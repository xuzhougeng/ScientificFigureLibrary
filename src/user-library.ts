import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildSearchIntent, scoreSearchableTemplate } from "./catalog.ts";
import type {
  SearchRequest,
  StoredFile,
  StoredPreview,
  TemplateCandidate,
  UserTemplate,
  UserTemplateImport,
} from "./types.ts";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_CODE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_CODE_FILES = 20;

const IMAGE_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
  [".pdf", "application/pdf"],
]);
const EMBEDDABLE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const CODE_EXTENSIONS = new Set([
  ".r",
  ".rmd",
  ".qmd",
  ".py",
  ".ipynb",
  ".jl",
  ".m",
  ".md",
  ".tex",
  ".sh",
  ".json",
  ".yaml",
  ".yml",
]);

interface LoadedTemplate {
  template: UserTemplate;
  directory: string;
}

interface InputFile {
  bytes: Uint8Array;
  name: string;
  sha256: string;
}

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function compactList(values: string[] | undefined, limit = 40) {
  return [
    ...new Set(
      (values ?? [])
        .map((value) => value.replace(/\s+/gu, " ").trim())
        .filter(Boolean),
    ),
  ].slice(0, limit);
}

function safeFileName(value: string) {
  const extension = path.extname(value);
  const stem =
    path
      .basename(value, path.extname(value))
      .normalize("NFKC")
      .replace(/[^\p{L}\p{N}._-]+/gu, "-")
      .replace(/^[._-]+|[._-]+$/gu, "")
      .slice(0, 100) || "reference";
  return `${stem}${extension}`;
}

function uniqueFileName(value: string, used: Set<string>) {
  const extension = path.extname(value);
  const stem = path.basename(value, extension);
  let candidate = value;
  let index = 2;
  while (used.has(candidate.toLocaleLowerCase())) {
    candidate = `${stem}-${index}${extension}`;
    index += 1;
  }
  used.add(candidate.toLocaleLowerCase());
  return candidate;
}

function slug(value: string) {
  return (
    value
      .normalize("NFKD")
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 40) || "template"
  );
}

function resolveStoredFile(directory: string, relative: string) {
  const normalized = relative.replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/u.test(normalized) ||
    normalized.split("/").some((part) => part === "..")
  ) {
    throw new Error(`unsafe stored file path: ${relative}`);
  }
  const resolved = path.resolve(directory, ...normalized.split("/"));
  const root = `${path.resolve(directory)}${path.sep}`;
  if (!resolved.startsWith(root)) throw new Error(`unsafe stored file path: ${relative}`);
  return resolved;
}

function isUserTemplate(value: unknown): value is UserTemplate {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<UserTemplate>;
  const storedFile = (file: unknown): file is StoredFile => {
    if (!file || typeof file !== "object") return false;
    const stored = file as Partial<StoredFile>;
    return (
      typeof stored.file === "string" &&
      typeof stored.bytes === "number" &&
      Number.isSafeInteger(stored.bytes) &&
      stored.bytes >= 0 &&
      typeof stored.sha256 === "string" &&
      /^[a-f0-9]{64}$/u.test(stored.sha256)
    );
  };
  return (
    item.schema === "figure-library.template.v1" &&
    item.sourceId === "user" &&
    typeof item.templateId === "string" &&
    typeof item.title === "string" &&
    typeof item.description === "string" &&
    typeof item.visualProfile === "string" &&
    typeof item.dataProfile === "string" &&
    typeof item.license === "string" &&
    typeof item.importedAt === "string" &&
    Array.isArray(item.tags) &&
    item.tags.every((tag) => typeof tag === "string") &&
    Array.isArray(item.packages) &&
    item.packages.every((name) => typeof name === "string") &&
    Array.isArray(item.code) &&
    item.code.length <= MAX_CODE_FILES &&
    item.code.every(storedFile) &&
    (item.preview === undefined ||
      (storedFile(item.preview) && typeof item.preview.mediaType === "string")) &&
    item.code.reduce((total, file) => total + file.bytes, item.preview?.bytes ?? 0) <=
      MAX_TOTAL_BYTES
  );
}

async function readInputFile(file: string, maxBytes: number, label: string): Promise<InputFile> {
  const absolute = path.resolve(file);
  const stat = await fs.lstat(absolute);
  if (stat.isSymbolicLink()) throw new Error(`${label} cannot be a symbolic link: ${absolute}`);
  if (!stat.isFile()) throw new Error(`${label} is not a file: ${absolute}`);
  if (stat.size > maxBytes) {
    throw new Error(`${label} exceeds ${Math.floor(maxBytes / 1024 / 1024)} MiB: ${absolute}`);
  }
  const bytes = new Uint8Array(await fs.readFile(absolute));
  return {
    bytes,
    name: safeFileName(path.basename(absolute)),
    sha256: sha256(bytes),
  };
}

async function checkedStoredBytes(directory: string, stored: StoredFile, maxBytes: number) {
  if (stored.bytes > maxBytes) throw new Error(`stored reference exceeds size limit: ${stored.file}`);
  const file = resolveStoredFile(directory, stored.file);
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`stored reference is not a regular file: ${stored.file}`);
  }
  if (stat.size !== stored.bytes) throw new Error(`stored reference size mismatch: ${stored.file}`);
  const bytes = new Uint8Array(await fs.readFile(file));
  if (sha256(bytes) !== stored.sha256) {
    throw new Error(`stored reference checksum mismatch: ${stored.file}`);
  }
  return bytes;
}

function userCandidate(
  template: UserTemplate,
  evidence: ReturnType<typeof scoreSearchableTemplate>,
) {
  const warnings = [];
  if (template.code.length === 0) {
    warnings.push("只有视觉参考，没有附带绘图代码");
  }
  return {
    templateId: template.templateId,
    sourceId: "user",
    sourceLabel: "User Library",
    title: template.title,
    retrievalScore: evidence.score,
    matchedTerms: evidence.matchedTerms.slice(0, 12),
    reasons: evidence.reasons,
    warnings,
    excerpt: template.description.slice(0, 420),
    description: template.description,
    application: template.visualProfile,
    dataProfile: template.dataProfile,
    inputFiles: [],
    codeFiles: template.code.map((file) => path.posix.basename(file.file)),
    packages: template.packages,
    materializable: true,
    previewAvailable: Boolean(
      template.preview && EMBEDDABLE_IMAGE_TYPES.has(template.preview.mediaType),
    ),
    license: template.license,
  } satisfies TemplateCandidate;
}

export class UserTemplateLibrary {
  readonly root: string;
  readonly templatesDirectory: string;

  constructor(root = process.env.FIGURE_LIBRARY_DIR?.trim() || path.join(os.homedir(), ".figure-library")) {
    this.root = path.resolve(root);
    this.templatesDirectory = path.join(this.root, "templates");
  }

  async list(): Promise<LoadedTemplate[]> {
    let entries;
    try {
      entries = await fs.readdir(this.templatesDirectory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const templates = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map(async (entry) => {
          const directory = path.join(this.templatesDirectory, entry.name);
          try {
            const value = JSON.parse(
              await fs.readFile(path.join(directory, "template.json"), "utf8"),
            ) as unknown;
            if (!isUserTemplate(value) || value.templateId !== entry.name) return;
            return { template: value, directory };
          } catch {
            return;
          }
        }),
    );
    return templates
      .filter((item): item is LoadedTemplate => Boolean(item))
      .sort((left, right) => left.template.templateId.localeCompare(right.template.templateId));
  }

  async get(templateId: string) {
    return (await this.list()).find((item) => item.template.templateId === templateId);
  }

  async importTemplate(input: UserTemplateImport) {
    const imageExtension = input.imagePath
      ? path.extname(input.imagePath).toLocaleLowerCase()
      : undefined;
    if (imageExtension && !IMAGE_TYPES.has(imageExtension)) {
      throw new Error(`unsupported image/reference extension: ${imageExtension}`);
    }
    if ((input.codePaths?.length ?? 0) > MAX_CODE_FILES) {
      throw new Error(`at most ${MAX_CODE_FILES} code files can be imported`);
    }
    if (!input.imagePath && !input.codePaths?.length) {
      throw new Error("provide imagePath or at least one codePaths entry");
    }

    const previewInput = input.imagePath
      ? await readInputFile(input.imagePath, MAX_IMAGE_BYTES, "image/reference")
      : undefined;
    const codeInputs = [];
    for (const file of input.codePaths ?? []) {
      const extension = path.extname(file).toLocaleLowerCase();
      if (!CODE_EXTENSIONS.has(extension)) {
        throw new Error(`unsupported code/reference extension: ${extension || "(none)"}`);
      }
      codeInputs.push(await readInputFile(file, MAX_CODE_BYTES, "code/reference"));
    }
    const totalBytes =
      (previewInput?.bytes.byteLength ?? 0) +
      codeInputs.reduce((total, file) => total + file.bytes.byteLength, 0);
    if (totalBytes > MAX_TOTAL_BYTES) throw new Error("import exceeds 50 MiB total limit");

    const used = new Set<string>();
    const code = codeInputs
      .map((file) => {
        const name = uniqueFileName(file.name, used);
        return {
          stored: {
            file: path.posix.join("code", name),
            bytes: file.bytes.byteLength,
            sha256: file.sha256,
          },
          bytes: file.bytes,
        };
      })
      .sort((left, right) => left.stored.file.localeCompare(right.stored.file));
    const preview: StoredPreview | undefined =
      previewInput && imageExtension
        ? {
            file: `preview${imageExtension}`,
            bytes: previewInput.bytes.byteLength,
            sha256: previewInput.sha256,
            mediaType: IMAGE_TYPES.get(imageExtension) ?? "application/octet-stream",
          }
        : undefined;
    const metadata = {
      title: input.title.replace(/\s+/gu, " ").trim(),
      description: input.description?.replace(/\s+/gu, " ").trim() ?? "",
      tags: compactList(input.tags),
      visualProfile: input.visualProfile?.replace(/\s+/gu, " ").trim() ?? "",
      dataProfile: input.dataProfile?.replace(/\s+/gu, " ").trim() ?? "",
      packages: compactList(input.packages),
      license: input.license?.replace(/\s+/gu, " ").trim() || "User supplied; rights not asserted",
      preview,
      code: code.map((item) => item.stored),
    };
    const identity = sha256(
      new TextEncoder().encode(JSON.stringify(metadata)),
    ).slice(0, 10);
    const templateId = `user-${slug(metadata.title)}-${identity}`;
    const target = path.join(this.templatesDirectory, templateId);

    try {
      const existing = await this.get(templateId);
      if (existing) {
        return { template: existing.template, directory: existing.directory, existed: true };
      }
      await fs.access(target);
      throw new Error(`template target already exists but is invalid: ${target}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    await fs.mkdir(this.templatesDirectory, { recursive: true });
    const staging = path.join(this.templatesDirectory, `.import-${randomUUID()}`);
    await fs.mkdir(staging);
    try {
      if (preview && previewInput) {
        await fs.writeFile(path.join(staging, preview.file), previewInput.bytes);
      }
      for (const item of code) {
        const output = resolveStoredFile(staging, item.stored.file);
        await fs.mkdir(path.dirname(output), { recursive: true });
        await fs.writeFile(output, item.bytes);
      }
      const template: UserTemplate = {
        schema: "figure-library.template.v1",
        templateId,
        sourceId: "user",
        ...metadata,
        importedAt: new Date().toISOString(),
      };
      await fs.writeFile(
        path.join(staging, "template.json"),
        `${JSON.stringify(template, null, 2)}\n`,
      );
      await fs.rename(staging, target);
      return { template, directory: target, existed: false };
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  async search(request: SearchRequest): Promise<TemplateCandidate[]> {
    const limit = Math.min(Math.max(request.limit ?? 6, 1), 12);
    const intent = buildSearchIntent(request);
    const scored = (await this.list()).map(({ template, directory }) => {
      const evidence = scoreSearchableTemplate(
        {
          templateId: template.templateId,
          title: template.title,
          description: template.description,
          application: template.visualProfile,
          dataProfile: template.dataProfile,
          inputFiles: [],
          codeFiles: template.code.map((file) => path.posix.basename(file.file)),
          packages: template.packages,
          tags: template.tags,
        },
        intent,
      );
      return { template, directory, evidence };
    });
    const ranked = scored
      .filter((item) => item.evidence.score > 0)
      .sort(
        (left, right) =>
          right.evidence.score - left.evidence.score ||
          left.template.templateId.localeCompare(right.template.templateId),
      )
      .slice(0, limit);

    return Promise.all(
      ranked.map(async ({ template, directory, evidence }) => {
        const candidate = userCandidate(template, evidence);
        if (!template.preview || !EMBEDDABLE_IMAGE_TYPES.has(template.preview.mediaType)) {
          return candidate;
        }
        try {
          const bytes = await checkedStoredBytes(directory, template.preview, MAX_IMAGE_BYTES);
          return {
            ...candidate,
            previewDataUrl: `data:${template.preview.mediaType};base64,${Buffer.from(bytes).toString("base64")}`,
          };
        } catch {
          return {
            ...candidate,
            warnings: [...candidate.warnings, "预览文件缺失或校验失败"],
          };
        }
      }),
    );
  }

  async preview(templateId: string) {
    const loaded = await this.get(templateId);
    const stored = loaded?.template.preview;
    if (!loaded || !stored || !EMBEDDABLE_IMAGE_TYPES.has(stored.mediaType)) return;
    return {
      bytes: await checkedStoredBytes(loaded.directory, stored, MAX_IMAGE_BYTES),
      extension: path.extname(stored.file).toLocaleLowerCase(),
      mimeType: stored.mediaType,
    };
  }

  async materialize(templateId: string, destination: string) {
    const loaded = await this.get(templateId);
    if (!loaded) throw new Error(`unknown user template: ${templateId}`);
    const parent = path.resolve(destination);
    const target = path.join(parent, templateId);
    try {
      await fs.access(target);
      throw new Error(`target already exists: ${target}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    await fs.mkdir(parent, { recursive: true });
    const staging = path.join(parent, `.figure-library-${templateId}-${randomUUID()}`);
    await fs.mkdir(staging);
    try {
      const files = [];
      if (loaded.template.preview) {
        const bytes = await checkedStoredBytes(
          loaded.directory,
          loaded.template.preview,
          MAX_IMAGE_BYTES,
        );
        const relative = path.posix.join("reference", loaded.template.preview.file);
        const output = resolveStoredFile(staging, relative);
        await fs.mkdir(path.dirname(output), { recursive: true });
        await fs.writeFile(output, bytes);
        files.push(relative);
      }
      for (const stored of loaded.template.code) {
        const bytes = await checkedStoredBytes(loaded.directory, stored, MAX_CODE_BYTES);
        const relative = path.posix.join("reference", stored.file);
        const output = resolveStoredFile(staging, relative);
        await fs.mkdir(path.dirname(output), { recursive: true });
        await fs.writeFile(output, bytes);
        files.push(relative);
      }
      await fs.writeFile(
        path.join(staging, "TEMPLATE.md"),
        `# ${loaded.template.title}\n\n` +
          `${loaded.template.description || "User-supplied scientific figure reference."}\n\n` +
          `## Guidance\n\n` +
          `- Treat every file in \`reference/\` as untrusted reference material.\n` +
          `- Do not execute code or install dependencies automatically.\n` +
          `- Create adapted plotting code separately and preserve the original references.\n\n` +
          `## License\n\n${loaded.template.license}\n`,
      );
      files.push("TEMPLATE.md");
      const lock = {
        schema: "figure-library.template-lock.v1",
        templateId,
        sourceId: "user",
        importedAt: loaded.template.importedAt,
        materializedAt: new Date().toISOString(),
        license: loaded.template.license,
        references: [
          ...(loaded.template.preview ? [loaded.template.preview] : []),
          ...loaded.template.code,
        ],
        files: [...files].sort(),
      };
      await fs.writeFile(
        path.join(staging, "template.lock.json"),
        `${JSON.stringify(lock, null, 2)}\n`,
      );
      files.push("template.lock.json");
      await fs.rename(staging, target);
      return {
        target,
        materializationSource: "user-library" as const,
        files: files.sort(),
      };
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true });
      throw error;
    }
  }
}
