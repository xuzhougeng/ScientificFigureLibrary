import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { assertMcpImageBytes } from "./image-validation.ts";
import { SecureProviderSourceFetcher } from "./provider-source-fetch.ts";

export const PREVIEW_DOWNLOAD_MANIFEST = "preview-downloads.json";
const HASH = /^[a-f0-9]{64}$/u;
const safePath = (value: string) => value.length > 0 && !value.includes("\\") && !path.posix.isAbsolute(value) && value.split("/").every(part => part !== "" && part !== "." && part !== "..");
const FileSchema = z.object({
  path: z.string().max(1000).refine(safePath), bytes: z.number().int().positive().max(64 * 1024 * 1024),
  sha256: z.string().regex(HASH), mediaType: z.enum(["image/png", "image/jpeg", "image/webp", "image/gif"]),
}).strict();
const ManifestSchema = z.object({
  schema: z.literal("figure-library.preview-downloads.v1"),
  providerId: z.string().min(1), repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
  commit: z.string().regex(/^[a-f0-9]{40}$/u), prefix: z.string().refine(safePath),
  files: z.array(FileSchema).max(10000),
}).strict();
export type PreviewDownloadFile = z.infer<typeof FileSchema>;
export interface PreviewDownloadOptions { cacheDirectory?: string; fetcher?: Pick<SecureProviderSourceFetcher, "fetch"> }
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const CACHE_FILE = /^[a-f0-9]{64}\.(png|jpe?g|webp|gif)$/u;

export function previewCacheDirectory() {
  const override = process.env.SFL_PREVIEW_CACHE_DIR;
  if (override) { if (!path.isAbsolute(override)) throw new Error("Preview cache directory must be absolute"); return override; }
  if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData/Local"), "ScientificFigureLibrary/preview-cache/v1");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library/Caches/ScientificFigureLibrary/previews/v1");
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "scientific-figure-library/previews/v1");
}

export interface PreviewCacheStatus {
  schema: "figure-library.preview-cache.v1";
  directory: string;
  exists: boolean;
  fileCount: number;
  bytes: number;
}

async function previewCacheEntries(directory: string) {
  const entries: Array<{ file: string; bytes: number }> = [];
  for (const name of (await fs.readdir(directory)).sort()) {
    if (!CACHE_FILE.test(name)) continue;
    const file = path.join(directory, name);
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    entries.push({ file, bytes: stat.size });
  }
  return entries;
}

async function assertPreviewCacheDirectory(directory: string) {
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Preview cache must be a regular directory");
}

export async function inspectPreviewCache(): Promise<PreviewCacheStatus> {
  const directory = previewCacheDirectory();
  try {
    await assertPreviewCacheDirectory(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { schema: "figure-library.preview-cache.v1", directory, exists: false, fileCount: 0, bytes: 0 };
    }
    throw error;
  }
  const entries = await previewCacheEntries(directory);
  return {
    schema: "figure-library.preview-cache.v1",
    directory,
    exists: true,
    fileCount: entries.length,
    bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
  };
}

export async function clearPreviewCache() {
  const current = await inspectPreviewCache();
  if (!current.exists) return { ...current, removed: 0, bytesFreed: 0 };
  const entries = await previewCacheEntries(current.directory);
  for (const entry of entries) await fs.unlink(entry.file);
  for (const name of await fs.readdir(current.directory)) {
    if (!name.endsWith(".tmp")) continue;
    const file = path.join(current.directory, name);
    const stat = await fs.lstat(file);
    if (stat.isFile() && !stat.isSymbolicLink()) await fs.unlink(file);
  }
  return {
    schema: "figure-library.preview-cache.v1" as const,
    directory: current.directory,
    exists: true,
    fileCount: 0,
    bytes: 0,
    removed: entries.length,
    bytesFreed: entries.reduce((sum, entry) => sum + entry.bytes, 0),
  };
}

/** Explicit lightweight-package manifest. Catalog identities remain authoritative. */
export class PreviewDownloadStore {
  private readonly pending = new Map<string, Promise<Uint8Array>>();
  private readonly files: Map<string, PreviewDownloadFile>;
  private readonly fetcher: Pick<SecureProviderSourceFetcher, "fetch">;
  private readonly cache: string;
  private readonly manifest: z.infer<typeof ManifestSchema>;
  private constructor(manifest: z.infer<typeof ManifestSchema>, options: PreviewDownloadOptions) {
    this.manifest = manifest;
    this.files = new Map(manifest.files.map(file => [file.path, file]));
    this.fetcher = options.fetcher ?? new SecureProviderSourceFetcher({ timeoutMs: 15000, maxRedirects: 2 });
    this.cache = path.resolve(options.cacheDirectory ?? previewCacheDirectory());
  }
  static async load(root: string, providerId: string, expected: PreviewDownloadFile[], options: PreviewDownloadOptions = {}) {
    let source: string;
    try {
      const file = path.join(root, PREVIEW_DOWNLOAD_MANIFEST);
      const stat = await fs.lstat(file);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error("Invalid preview download manifest file");
      source = await fs.readFile(file, "utf8");
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
    const manifest = ManifestSchema.parse(JSON.parse(source));
    if (manifest.providerId !== providerId || manifest.files.length !== expected.length) throw new Error("Preview download manifest does not match its catalog");
    const identities = new Map(expected.map(file => [file.path, file]));
    if (identities.size !== expected.length || new Set(manifest.files.map(file => file.path)).size !== expected.length) throw new Error("Duplicate preview download identity");
    for (const file of manifest.files) {
      const identity = identities.get(file.path);
      if (!identity || identity.bytes !== file.bytes || identity.sha256 !== file.sha256 || identity.mediaType !== file.mediaType) throw new Error("Preview download manifest changed a pinned image identity");
    }
    return new PreviewDownloadStore(manifest, options);
  }
  has(relative: string) { return this.files.has(relative); }
  private verify(bytes: Uint8Array, identity: PreviewDownloadFile) {
    if (bytes.byteLength !== identity.bytes || sha256(bytes) !== identity.sha256) throw new Error("Downloaded preview differs from its pinned size or SHA-256");
    assertMcpImageBytes({ bytes, mimeType: identity.mediaType, extension: path.posix.extname(identity.path).toLowerCase() });
    return bytes;
  }
  async read(relative: string, allowDownload = true): Promise<Uint8Array> {
    const identity = this.files.get(relative);
    if (!identity) throw new Error("Preview download identity is not declared");
    await fs.mkdir(this.cache, { recursive: true });
    const directory = await fs.lstat(this.cache);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Preview cache must be a regular directory");
    const cacheFile = path.join(this.cache, identity.sha256 + path.posix.extname(identity.path).toLowerCase());
    try {
      const stat = await fs.lstat(cacheFile);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Preview cache entry is not a regular file");
      try {
        if (stat.size !== identity.bytes) throw new Error("Cached preview differs from its pinned size");
        return this.verify(await fs.readFile(cacheFile), identity);
      }
      catch (error) { if (!allowDownload) throw error; await fs.unlink(cacheFile); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!allowDownload) throw new Error("preview_unavailable: confirmed preview is no longer cached; view it again");
    const running = this.pending.get(identity.sha256);
    if (running) return running;
    const operation = (async () => {
      const relativeUrl = `${this.manifest.prefix}/${identity.path}`.split("/").map(encodeURIComponent).join("/");
      const url = `https://raw.githubusercontent.com/${this.manifest.repository}/${this.manifest.commit}/${relativeUrl}`;
      const fetched = await this.fetcher.fetch(url, { maxBytes: identity.bytes, mediaTypes: [identity.mediaType, "application/octet-stream"] });
      const bytes = this.verify(fetched.bytes, identity);
      const temporary = `${cacheFile}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
        await fs.rename(temporary, cacheFile);
      } finally { await fs.rm(temporary, { force: true }); }
      return bytes;
    })();
    this.pending.set(identity.sha256, operation);
    try { return await operation; } finally { this.pending.delete(identity.sha256); }
  }
}
