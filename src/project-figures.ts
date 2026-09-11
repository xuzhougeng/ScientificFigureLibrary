import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { zipSync } from "fflate";
import { assertMcpImageBytes } from "./image-validation.ts";
import { atomicJson, digest, jsonText, readJsonOr, safePath, safeRelative, withWorkflowLock } from "./workflow-storage.ts";

const text = z.string().trim().min(1).max(10000);
const id = z.string().uuid();
const slug = z.string().regex(/^[a-z][a-z0-9-]{0,99}$/u).refine((v) => { try { safeRelative(v); return true; } catch { return false; } }, "Unsafe file name");
const rel = z.string().refine((v) => { try { safeRelative(v); return true; } catch { return false; } }, "Unsafe relative path");
const Label = z.object({ figure: z.number().int().min(1).max(9999), panel: z.string().regex(/^[A-Z]{1,2}$/u) }).strict();
export const FigureChange = z.object({ id: id.optional(), title: text, slug: slug.optional(), label: Label.nullable().optional(), purpose: text.optional() }).strict();
export const Artifact = z.object({
  path: rel, role: z.enum(["raw_data", "analysis_data", "plot_data", "original_script", "plot_script", "preprocess_script", "output", "documentation"]),
  description: text,
  source: z.object({ kind: z.enum(["local", "url", "generated", "unknown"]), reference: text, version: text.optional(), acquiredAt: text.optional(), author: text.optional(), license: text.optional() }).strict(),
}).strict();
export const ArchiveDetails = z.object({
  purpose: text, dataDescription: text, scriptDescription: text, environment: text,
  parameters: z.record(z.string(), z.unknown()), provenanceNotes: text,
  runCommand: text, execution: z.enum(["not_run", "failed", "succeeded"]), executionNotes: text,
  scope: text, changes: text,
  externalDependencies: z.array(z.object({ reference: text, description: text, availability: z.enum(["local_only", "archived", "missing"]), sha256: z.string().regex(/^[a-f0-9]{64}$/u).optional() }).strict()).default([]),
  originalScript: z.enum(["included", "none", "missing"]),
  style: z.record(z.string(), z.unknown()).optional(),
  panelLabelInArtwork: z.string().nullable(),
  renderEvidence: z.object({ files: z.record(rel, z.string().regex(/^[a-f0-9]{64}$/u)), verifiedAt: text }).strict().optional(),
}).strict();
export type ArchiveDetailsValue = z.infer<typeof ArchiveDetails>;
type LabelValue = z.infer<typeof Label>;
type FileRecord = z.infer<typeof Artifact> & { bytes: number; sha256: string };
type Revision = { revision: number; directory: string; manifestSha256: string };
export type ProjectFigure = { id: string; title: string; slug: string; directory: string; label: LabelValue | null; purpose: string; aliases: string[]; revision: number; history: Revision[]; artworkLabelPending: boolean };
type ProjectState = { schema: "sfl.project-figures.v1"; revision: number; figuresDirectory: string; figures: ProjectFigure[] };
type Manifest = { schema: "sfl.figure-archive.v1"; figureId: string; title: string; label: LabelValue | null; revision: number; createdAt: string; files: FileRecord[]; details: ArchiveDetailsValue; generated: Record<string, { sha256: string; bytes: number }> };
export type FigureChangePlan = { schema: "sfl.figure-change-plan.v1"; expectedRevision: number; next: ProjectState; changes: Array<{ id: string; before: string | null; after: string; label: LabelValue | null }>; digest: string };
export type ExportPlan = { schema: "sfl.submission-plan.v1"; figureId: string; revision: number; locale: "zh-CN" | "en"; destination: string; files: Array<{ path: string; bytes: number; sha256: string }>; generatedManifest: { path: "manifest.json"; assignedOnExport: ["exportedAt"] }; sourceDigest: string; packageDigest: string; digest: string; exceptions: string[] };
export const ExportTranslation = z.object({
  // Host prepares translations as separate files inside this figure's working directory.
  readmeSections: z.object({ purpose: text, dataDescription: text, scriptDescription: text, environment: text, provenanceNotes: text, executionNotes: text, scope: text, changes: text }).strict().optional(),
  files: z.array(z.object({ originalPath: rel, preparedPath: rel }).strict()).default([]),
  labels: z.array(z.object({ original: text, translated: text }).strict()).default([]),
  verified: z.boolean(),
  notes: text,
  fileDescriptions: z.record(rel, text).optional(),
}).strict();
type Translation = z.infer<typeof ExportTranslation>;

const labelText = (label: LabelValue | null) => label ? `Figure ${label.figure}${label.panel}` : "";
const english = (v: string) => !/[\u3400-\u9fff]/u.test(v);
const substantive = (v: string) => !/^(todo|tbd|待补充|待填写|unknown|n\/a|\.\.\.)[.!。\s]*$/iu.test(v.trim());

function validateOutput(file: string, data: Uint8Array) {
  const extension = path.extname(file).toLowerCase(); const value = Buffer.from(data);
  if ([".png", ".jpg", ".jpeg", ".webp"].includes(extension)) {
    assertMcpImageBytes({ bytes: data, extension, mimeType: extension === ".png" ? "image/png" : extension === ".webp" ? "image/webp" : "image/jpeg" }); return;
  }
  if (extension === ".svg" && /<svg\b[^>]*(?:viewBox|width)\s*=/iu.test(value.toString()) && /<\/(?:\w+:)?svg\s*>/iu.test(value.toString()) && /<(?:path|rect|circle|line|polygon|polyline|text|image|use)\b/iu.test(value.toString())) return;
  if (extension === ".pdf" && value.subarray(0, 5).toString() === "%PDF-" && value.subarray(-1024).toString().includes("%%EOF")) return;
  if ([".tif", ".tiff"].includes(extension) && value.length > 8 && ["49492a00", "4d4d002a", "49492b00", "4d4d002b"].includes(value.subarray(0, 4).toString("hex"))) return;
  if (extension === ".eps" && value.subarray(0, 24).toString().startsWith("%!PS-Adobe") && value.toString().includes("%%BoundingBox:")) return;
  throw Error(`Output has unsupported or invalid image structure: ${file}`);
}

function figureReadme(figure: ProjectFigure) {
  return `# ${labelText(figure.label)} ${figure.title}\n\nStable ID: ${figure.id}\n\n${figure.purpose}\n\nDirectory: ${figure.directory}\n\nRevision: ${figure.revision || "planned; not rendered"}\n\nArtwork label needs rendering: ${figure.artworkLabelPending}\n\nHistorical names: ${figure.aliases.join("; ") || "none"}\n\nUse the project archive tool to capture actual data, scripts, environment and outputs after the host renders them.\n`;
}

function archiveReadme(manifest: Manifest, locale: "zh-CN" | "en" = "zh-CN") {
  const d = manifest.details;
  const translated = (zh: string, en: string) => locale === "en" ? en : zh;
  const headings = locale === "en"
    ? ["Identity and purpose", "File index", "Data", "Scripts and reproduction", "Environment", "Parameters and style", "Sources and permissions", "Execution and checks", "Revision and package scope"]
    : ["图的身份与目的", "文件索引", "数据说明", "脚本说明与重绘", "运行环境", "参数与图形规范", "来源与授权", "执行与检查状态", "修订与投稿包范围"];
  const sections = [
    `${manifest.figureId} · ${labelText(manifest.label)} · ${translated("修订", "revision")} ${manifest.revision}\n\n${d.purpose}`,
    manifest.files.map((f) => `- [${f.path}](<${f.path}>) — ${f.description}`).join("\n"),
    `${d.dataDescription}\n\n${translated("包外依赖", "External dependencies")}:\n${d.externalDependencies.map((v) => `- ${v.reference}: ${v.description} (${v.availability})`).join("\n") || translated("未声明包外依赖", "None declared")}`,
    `${d.scriptDescription}\n\n${translated("工作目录：解压后的包根目录", "Working directory: package root")}\n\n\`\`\`text\n${d.runCommand}\n\`\`\`\n\n${translated("原始脚本", "Original script")}: ${locale === "en" ? d.originalScript : ({ included: "已包含", none: "没有上游原始脚本", missing: "缺失" })[d.originalScript]}`,
    d.environment,
    translated("详见 [parameters.json](parameters.json)。保存的设置不代表已验证实际渲染符合规范。", "See [parameters.json](parameters.json). Saved settings are not proof of rendered compliance."),
    `${d.provenanceNotes}\n\n${translated("详见 [provenance.json](provenance.json)。来源链接可离线记录，未验证在线可访问性。", "See [provenance.json](provenance.json). Links recorded offline; reachability is not verified.")}`,
    `${locale === "en" ? d.execution : ({ succeeded: "已执行", failed: "执行失败", not_run: "未执行" })[d.execution]}: ${d.executionNotes}\n\n${translated("完整性检查核对已保存文件；代码执行与图形检查由宿主报告，并非 SFL 自行执行。", "Integrity validation checks saved files; execution and visual checks are reported by the host, not performed by SFL.")}`,
    `${d.changes}\n\n${d.scope}`,
  ];
  return `# ${manifest.title}\n\n${headings.map((h, i) => `## ${i + 1}. ${h}\n\n${sections[i]}\n`).join("\n")}`;
}

export class ProjectFigures {
  readonly workspace: string;
  readonly store: string;
  constructor(workspace: string) {
    if (!path.isAbsolute(workspace)) throw Error("Project workspace must be absolute");
    this.workspace = path.resolve(workspace); this.store = path.join(this.workspace, ".sfl-project");
  }
  async state(): Promise<ProjectState> {
    const recovery = await readJsonOr<unknown>(await safePath(this.store, "pending-change.json"), null);
    if (recovery) throw Error(`Interrupted project change: inspect ${path.join(this.store, "pending-change.json")} and the writer lock before recovery; do not start another rename`);
    const state = await readJsonOr<ProjectState>(await safePath(this.store, "state.json"), { schema: "sfl.project-figures.v1", revision: 0, figuresDirectory: "figures", figures: [] });
    if (state.schema !== "sfl.project-figures.v1" || !Number.isSafeInteger(state.revision) || !Array.isArray(state.figures)) throw Error("Invalid project state");
    safeRelative(state.figuresDirectory);
    for (const f of state.figures) { id.parse(f.id); slug.parse(f.slug); safeRelative(f.directory); if (f.label) Label.parse(f.label); }
    return state;
  }
  async list(query?: string) {
    const state = await this.state();
    const q = query?.trim().toLowerCase();
    const figures = state.figures.filter((f) => !q || [f.id, f.title, f.slug, labelText(f.label), ...f.aliases].some((v) => v.toLowerCase().includes(q)));
    return { ...state, figures, ambiguous: figures.length > 1 && Boolean(q), note: "These are project figures, not public templates. Historical aliases may be ambiguous." };
  }
  async plan(changes: z.infer<typeof FigureChange>[], figuresDirectory?: string): Promise<FigureChangePlan> {
    const state = await this.state();
    const next = structuredClone(state);
    if (figuresDirectory) {
      safeRelative(figuresDirectory);
      if (state.figures.length && state.figuresDirectory !== figuresDirectory) throw Error("Existing project figure root cannot be changed by this operation");
      next.figuresDirectory = figuresDirectory;
    }
    const moves: FigureChangePlan["changes"] = [];
    const changed = new Set<string>();
    for (const raw of changes) {
      const change = FigureChange.parse(raw);
      const old = change.id ? next.figures.find((f) => f.id === change.id) : undefined;
      if (change.id && !old) throw Error("Unknown figure ID");
      const figureId = old?.id ?? randomUUID();
      if (changed.has(figureId)) throw Error("Duplicate figure change"); changed.add(figureId);
      const label = change.label === undefined ? old?.label ?? null : change.label;
      const fallback = change.title.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 70);
      const prefix = label ? `fig${String(label.figure).padStart(2, "0")}${label.panel.toLowerCase()}-` : "";
      const name = slug.parse(change.slug ?? (old && change.label === undefined ? old.slug : `${prefix}${fallback || "figure"}`));
      const directory = `${next.figuresDirectory}/${name}`;
      const aliases = [...new Set([...(old?.aliases ?? []), ...(old ? [old.title, labelText(old.label)] : [])].filter(Boolean))];
      const figure: ProjectFigure = { id: figureId, title: change.title, slug: name, directory, label, purpose: change.purpose ?? old?.purpose ?? change.title,
        aliases, revision: old?.revision ?? 0, history: old?.history ?? [], artworkLabelPending: old?.artworkLabelPending === true || Boolean(old?.revision && labelText(old.label) !== labelText(label)) };
      if (old) next.figures[next.figures.indexOf(old)] = figure; else next.figures.push(figure);
      moves.push({ id: figureId, before: old?.directory ?? null, after: directory, label });
    }
    const paths = new Set<string>(); const labels = new Set<string>();
    for (const f of next.figures) {
      if (paths.has(f.directory.toLowerCase())) throw Error("File name conflict; provide a distinct descriptive slug"); paths.add(f.directory.toLowerCase());
      if (f.label) { const label = labelText(f.label); if (labels.has(label)) throw Error("Figure/panel label conflict; exchange panels in one batch"); labels.add(label); }
    }
    for (const move of moves) {
      const target = await safePath(this.workspace, move.after);
      if (move.before !== move.after && !moves.some((v) => v.before === move.after)) {
        try { await fs.lstat(target); throw Error(`Destination already exists: ${move.after}`); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
    }
    next.revision++;
    const plan = { schema: "sfl.figure-change-plan.v1" as const, expectedRevision: state.revision, next, changes: moves };
    return { ...plan, digest: digest(jsonText(plan)) };
  }
  async apply(plan: FigureChangePlan) {
    const { digest: expected, ...body } = plan;
    if (digest(jsonText(body)) !== expected) throw Error("Changed project plan");
    return withWorkflowLock(this.store, async () => {
      const previous = await this.state(); if (previous.revision !== plan.expectedRevision) throw Error("Stale project plan; refresh before applying");
      const staged: Array<{ before: string; stage: string; after: string }> = [];
      const created: string[] = [];
      const recoveryPath = await safePath(this.store, "pending-change.json");
      const moveStages = new Map(plan.changes.map((move) => [move.id, `move-${randomUUID()}`]));
      await atomicJson(recoveryPath, { schema: "sfl.project-change-recovery.v1", previous, next: plan.next,
        changes: plan.changes.map((move) => ({ ...move, stagingDirectory: `.sfl-project/${moveStages.get(move.id)!}` })) });
      // Cycles (B/C exchanges) use unique intermediate directories. Roll back on failure.
      try {
        for (const move of plan.changes) {
          if (!move.before || move.before === move.after) continue;
          const before = await safePath(this.workspace, move.before);
          const stage = await safePath(this.store, moveStages.get(move.id)!);
          await fs.rename(before, stage); staged.push({ before, stage, after: await safePath(this.workspace, move.after) });
        }
        for (const move of staged) {
          await fs.mkdir(path.dirname(move.after), { recursive: true });
          try { await fs.lstat(move.after); throw Error("Destination appeared during rename"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
          await fs.rename(move.stage, move.after);
        }
        for (const move of plan.changes.filter((m) => !m.before)) {
          const target = await safePath(this.workspace, move.after);
          await fs.mkdir(path.dirname(target), { recursive: true }); await fs.mkdir(target); created.push(target);
        }
        for (const f of plan.next.figures.filter((f) => plan.changes.some((m) => m.id === f.id))) {
          await atomicJson(await safePath(this.workspace, `${f.directory}/figure.json`), { schema: "sfl.figure.v1", ...f });
          await this.writeWorkingMetadata(f);
        }
        await atomicJson(await safePath(this.store, "state.json"), plan.next);
        await fs.rm(recoveryPath);
      } catch (error) {
        // Move all completed destinations back to staging before restoring a cycle.
        for (const move of staged) { try { await fs.lstat(move.stage); } catch { await fs.rename(move.after, move.stage); } }
        for (const move of staged) await fs.rename(move.stage, move.before);
        for (const target of created) { for (const name of ["figure.json", "README.md", "manifest.json"]) await fs.rm(path.join(target, name), { force: true }); await fs.rmdir(target); }
        for (const f of previous.figures.filter((f) => plan.changes.some((m) => m.id === f.id))) {
          await atomicJson(await safePath(this.workspace, `${f.directory}/figure.json`), { schema: "sfl.figure.v1", ...f });
          await this.writeWorkingMetadata(f);
        }
        await atomicJson(await safePath(this.store, "state.json"), previous);
        await fs.rm(recoveryPath, { force: true });
        throw error;
      }
      return { ...plan.next, note: "Relative in-folder references remain valid. External absolute references are not rewritten. Changed labels in existing artwork require a host render before export." };
    });
  }
  private async figure(figureId: string) {
    id.parse(figureId); const state = await this.state(); const figure = state.figures.find((f) => f.id === figureId);
    if (!figure) throw Error("Unknown project figure ID; search the project index first");
    return { state, figure };
  }
  async archive(figureId: string, expectedRevision: number, artifacts: z.infer<typeof Artifact>[], rawDetails: ArchiveDetailsValue) {
    const details = ArchiveDetails.parse(rawDetails);
    return withWorkflowLock(this.store, async () => {
      const { state, figure } = await this.figure(figureId);
      if (figure.revision !== expectedRevision) throw Error("Stale figure revision");
      const previousState = structuredClone(state);
      const revision = figure.revision + 1;
      const relative = `revisions/${figure.id}/${revision}-${randomUUID()}`;
      const destination = await safePath(this.store, relative);
      const files: FileRecord[] = []; const bytes = new Map<string, Uint8Array>(); const used = new Set<string>();
      let total = 0;
      for (const raw of artifacts) {
        const artifact = Artifact.parse(raw);
        if (/^(?:exports|revisions|\.sfl-project)(?:\/|$)/iu.test(artifact.path) || /\.(?:zip|tgz)$/iu.test(artifact.path)
          || /(?:^|\/)(?:\.env(?:\..*)?|id_rsa|credentials[^/]*|token[^/]*|secrets?[^/]*)$/iu.test(artifact.path)
          || ["readme.md", "manifest.json", "parameters.json", "provenance.json", "environment.txt", "figure.json"].includes(artifact.path.toLowerCase())) throw Error(`Reserved or excluded archive path: ${artifact.path}`);
        if (used.has(artifact.path.toLowerCase())) throw Error("Case-insensitive archive path collision"); used.add(artifact.path.toLowerCase());
        const source = await safePath(this.workspace, `${figure.directory}/${artifact.path}`);
        const stat = await fs.stat(source); if (!stat.isFile() || stat.size === 0 || stat.size > 64 * 1024 * 1024) throw Error(`Missing, empty or oversized artifact: ${artifact.path}`);
        total += stat.size; if (total > 128 * 1024 * 1024) throw Error("Archive exceeds 128 MiB; reference shared raw data externally");
        const data = await fs.readFile(source);
        if (artifact.role === "output") validateOutput(artifact.path, data);
        files.push({ ...artifact, bytes: data.length, sha256: digest(data) }); bytes.set(artifact.path, data);
      }
      const manifest: Manifest = { schema: "sfl.figure-archive.v1", figureId, title: figure.title, label: figure.label, revision, createdAt: new Date().toISOString(), files, details, generated: {} };
      if (details.execution === "succeeded") {
        if (!details.renderEvidence) throw Error("A successful render needs host-recorded input/script/output hashes from the actual execution");
        for (const file of files.filter((f) => ["plot_data", "plot_script", "preprocess_script", "output"].includes(f.role))) {
          if (details.renderEvidence.files[file.path] !== file.sha256) throw Error(`File changed since verified render: ${file.path}`);
        }
      }
      const previous = figure.history.length ? await this.snapshot(figureId) : undefined;
      for (const file of files.filter((f) => f.role === "original_script")) {
        const original = previous?.manifest.files.find((f) => f.role === "original_script" && f.path === file.path);
        if (original && original.sha256 !== file.sha256) throw Error("Original author script was overwritten; preserve the old original and use a distinct versioned path");
      }
      const generated = this.generatedFiles(manifest);
      for (const [name, data] of Object.entries(generated)) manifest.generated[name] = { bytes: Buffer.byteLength(data), sha256: digest(data) };
      await fs.mkdir(destination, { recursive: true });
      for (const [name, data] of [...bytes, ...Object.entries(generated)]) {
        const target = await safePath(destination, name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, data, { flag: "wx" });
      }
      const serialized = jsonText(manifest); await fs.writeFile(path.join(destination, "manifest.json"), serialized, { flag: "wx" });
      figure.revision = revision; figure.history.push({ revision, directory: relative, manifestSha256: digest(serialized) });
      figure.artworkLabelPending = Boolean(figure.label && details.panelLabelInArtwork !== figure.label.panel);
      state.revision++;
      const metadataBefore: Array<{ file: string; bytes: Buffer | null }> = [];
      for (const name of ["figure.json", "README.md", "manifest.json", "parameters.json", "provenance.json", "environment.txt"]) {
        const file = await safePath(this.workspace, `${figure.directory}/${name}`);
        let bytes: Buffer | null = null;
        try { bytes = await fs.readFile(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        metadataBefore.push({ file, bytes });
      }
      const recoveryPath = await safePath(this.store, "pending-change.json");
      await atomicJson(recoveryPath, { schema: "sfl.archive-recovery.v1", previous: previousState, next: state,
        metadata: metadataBefore.map(({ file, bytes }) => ({ path: path.relative(this.workspace, file).split(path.sep).join("/"), beforeBase64: bytes?.toString("base64") ?? null })) });
      try {
        await this.writeWorkingMetadata(figure);
        await atomicJson(await safePath(this.workspace, `${figure.directory}/figure.json`), { schema: "sfl.figure.v1", ...figure });
        await atomicJson(await safePath(this.store, "state.json"), state);
        await fs.rm(recoveryPath);
      } catch (error) {
        for (const { file, bytes } of metadataBefore) {
          if (bytes === null) await fs.rm(file, { force: true }); else await fs.writeFile(file, bytes);
        }
        await atomicJson(await safePath(this.store, "state.json"), previousState);
        await fs.rm(recoveryPath, { force: true });
        throw error;
      }
      return { figure, archiveDirectory: destination, ...(await this.check(figureId)) };
    });
  }
  private generatedFiles(manifest: Manifest, locale: "zh-CN" | "en" = "zh-CN") {
    return { "README.md": archiveReadme(manifest, locale), "parameters.json": jsonText({ schema: "sfl.figure-parameters.v1", values: manifest.details.parameters, style: manifest.details.style ?? null }),
      "provenance.json": jsonText({ schema: "sfl.figure-provenance.v1", files: manifest.files.map((f) => ({ path: f.path, sha256: f.sha256, role: f.role, source: f.source })), externalDependencies: manifest.details.externalDependencies }),
      "environment.txt": manifest.details.environment + "\n" };
  }
  private async writeWorkingMetadata(figure: ProjectFigure) {
    const last = figure.history.at(-1);
    if (!last) {
      await fs.writeFile(await safePath(this.workspace, `${figure.directory}/README.md`), figureReadme(figure));
      await atomicJson(await safePath(this.workspace, `${figure.directory}/manifest.json`), { schema: "sfl.figure-working.v1", figureId: figure.id, title: figure.title, label: figure.label, status: "planned", revision: 0, files: [] });
      return;
    }
    const archive = await safePath(this.store, last.directory);
    const raw = await fs.readFile(await safePath(archive, "manifest.json"), "utf8");
    if (digest(raw) !== last.manifestSha256) throw Error("Archive manifest changed; cannot synchronize working metadata");
    const manifest = JSON.parse(raw) as Manifest;
    manifest.title = figure.title; manifest.label = figure.label;
    for (const [name, content] of Object.entries(this.generatedFiles(manifest))) {
      await fs.writeFile(await safePath(this.workspace, `${figure.directory}/${name}`), content);
    }
    await fs.appendFile(await safePath(this.workspace, `${figure.directory}/README.md`), `\n${figure.artworkLabelPending ? "图内编号待重新渲染；不能将现有图片认作新编号的完成产物。\n" : ""}\n归档快照：${path.relative(path.join(this.workspace, figure.directory), archive).split(path.sep).join("/")}\n\n工作文件修改后需要重新归档；历史快照保持不变。\n`);
    await atomicJson(await safePath(this.workspace, `${figure.directory}/manifest.json`), { schema: "sfl.figure-working.v1", figureId: figure.id, title: figure.title, label: figure.label, revision: figure.revision, sourceArchive: last.directory, sourceManifestSha256: last.manifestSha256, artworkLabelPending: figure.artworkLabelPending, files: manifest.files });
  }
  private async snapshot(figureId: string) {
    const { figure } = await this.figure(figureId); const revision = figure.history.at(-1);
    if (!revision) throw Error("Figure is planned and has no archive revision");
    const directory = await safePath(this.store, revision.directory);
    const raw = await fs.readFile(await safePath(directory, "manifest.json"), "utf8");
    if (digest(raw) !== revision.manifestSha256) throw Error("Archive manifest was modified");
    const manifest = JSON.parse(raw) as Manifest;
    if (manifest.schema !== "sfl.figure-archive.v1" || manifest.figureId !== figure.id || manifest.revision !== figure.revision) throw Error("Archive identity mismatch");
    return { figure, directory, manifest, revision };
  }
  async check(figureId: string) {
    const { figure, directory, manifest, revision } = await this.snapshot(figureId); const errors: string[] = [];
    for (const file of [...manifest.files, ...Object.entries(manifest.generated).map(([name, v]) => ({ path: name, ...v }))]) {
      try { const data = await fs.readFile(await safePath(directory, file.path)); if (data.length !== file.bytes || digest(data) !== file.sha256) errors.push(`Changed file: ${file.path}`); }
      catch { errors.push(`Missing or unsafe file: ${file.path}`); }
    }
    for (const role of ["plot_data", "plot_script", "output"] as const) if (!manifest.files.some((f) => f.role === role)) errors.push(`Missing role: ${role}`);
    for (const [key, value] of Object.entries(manifest.details)) if (typeof value === "string" && !substantive(value)) errors.push(`Incomplete description: ${key}`);
    if (manifest.details.execution !== "succeeded") errors.push(`Render ${manifest.details.execution}`);
    if (!manifest.files.filter((f) => f.role === "plot_script").some((f) => manifest.details.runCommand.includes(f.path))) errors.push("Reproduction command does not reference the saved plotting script");
    if (/(?:[A-Za-z]:[\\/]|\/(?:Users|home|tmp|mnt)\/|\.\.[\\/])/u.test(manifest.details.runCommand)) errors.push("Reproduction command requires a path outside the package");
    if (manifest.details.originalScript === "missing" || (manifest.details.originalScript === "included" && !manifest.files.some((f) => f.role === "original_script"))) errors.push("Original script missing");
    for (const f of manifest.files) if (f.source.kind === "unknown" || !substantive(f.source.reference)) errors.push(`Unknown source: ${f.path}`);
    if (figure.artworkLabelPending) errors.push("Artwork panel label has not been updated");
    if (manifest.details.externalDependencies.some((d) => d.availability === "missing" || d.availability === "local_only")) errors.push("Package depends on missing or local-only external data");
    return { complete: errors.length === 0, errors, executionVerification: "host-reported", selfContained: manifest.details.externalDependencies.length === 0, revision: manifest.revision, sourceDigest: revision.manifestSha256 };
  }
  private async exportBytes(figureId: string, locale: "zh-CN" | "en", translation: Translation) {
    const check = await this.check(figureId); if (!check.complete) throw Error(`Archive incomplete: ${check.errors.join("; ")}`);
    const { figure, directory, manifest: saved, revision } = await this.snapshot(figureId);
    if (check.sourceDigest !== revision.manifestSha256 || figure.artworkLabelPending) throw Error("Figure changed during archive verification; check it again");
    const prepared = ExportTranslation.parse(translation);
    if (!prepared.verified) throw Error("Host must verify translated code behavior and rerendered labels before exporting");
    const manifest = structuredClone(saved); manifest.title = locale === "en" && !english(figure.title) ? figure.slug : figure.title; manifest.label = figure.label;
    if (!prepared.readmeSections) throw Error("Language export requires all eight prepared README sections, not only translated headings");
    Object.assign(manifest.details, prepared.readmeSections);
    if (locale === "en") {
      for (const value of Object.values(prepared.readmeSections)) if (!english(value)) throw Error("English README still contains untranslated Chinese text");
      if (prepared.labels.some((v) => !english(v.translated))) throw Error("Untranslated generated figure label");
    }
    if (locale === "zh-CN" && Object.values(prepared.readmeSections).some((value) => english(value))) throw Error("Chinese export needs Chinese explanations in each prepared README section");
    const output: Record<string, Uint8Array> = {}; const mappings = new Map(prepared.files.map((v) => [v.originalPath, v.preparedPath]));
    if (mappings.size !== prepared.files.length || prepared.files.some((v) => !manifest.files.some((f) => f.path === v.originalPath))) throw Error("Duplicate or unknown translation target");
    const exceptions: string[] = [];
    for (const file of manifest.files) {
      const immutable = ["raw_data", "analysis_data", "plot_data", "original_script"].includes(file.role);
      const replacement = mappings.get(file.path);
      if (prepared.fileDescriptions?.[file.path]) file.description = prepared.fileDescriptions[file.path]!;
      if ((locale === "en" && !english(file.description)) || (locale === "zh-CN" && english(file.description))) {
        const translatedDescription = prepared.fileDescriptions?.[file.path];
        if (!translatedDescription || (locale === "en" ? !english(translatedDescription) : english(translatedDescription))) throw Error(`Translate the generated file description: ${file.path}`);
        file.description = translatedDescription;
      }
      if (!immutable && !/^[\x20-\x7e]+$/u.test(file.path)) throw Error(`Generated export file names must use English: ${file.path}`);
      if (replacement && immutable) throw Error("Translation must preserve original data and original scripts");
      let data = await fs.readFile(await safePath(directory, file.path));
      if (data.length !== file.bytes || digest(data) !== file.sha256) throw Error(`Archive file changed during export: ${file.path}`);
      if (replacement) data = await fs.readFile(await safePath(this.workspace, `${figure.directory}/${replacement}`));
      if (!data.length || data.length > 64 * 1024 * 1024) throw Error("Empty or oversized prepared export file");
      if (file.role === "output") validateOutput(file.path, data);
      if (["plot_script", "preprocess_script"].includes(file.role) && !english(data.toString("utf8"))) throw Error(`Generated code needs English comments/identifiers: ${file.path}. Preserve original fields through a display mapping or escaped string literals.`);
      if (locale === "en" && file.role === "documentation" && !english(data.toString("utf8"))) throw Error(`Untranslated documentation: ${file.path}`);
      if (immutable) exceptions.push(`${file.path}: original material preserved`);
      output[file.path] = data; file.sha256 = digest(data); file.bytes = data.length;
    }
    if (locale === "en" && prepared.labels.some((v) => v.original !== v.translated) && !manifest.files.filter((f) => f.role === "output").every((f) => mappings.has(f.path))) throw Error("Changed figure labels require prepared rerendered outputs for every exported format");
    const generated = this.generatedFiles(manifest, locale);
    for (const [name, value] of Object.entries(generated)) output[name] = Buffer.from(value);
    const files = Object.entries(output).map(([name, value]) => ({ path: name, bytes: value.length, sha256: digest(value) })).sort((a, b) => a.path.localeCompare(b.path));
    output["manifest.json"] = Buffer.from(jsonText({ schema: "sfl.submission.v1", figureId, revision: figure.revision, label: figure.label, exportLocale: locale, sourceManifestSha256: revision.manifestSha256, sourceCreatedAt: saved.createdAt, files, languageVerification: "host-reported", labelMapping: prepared.labels, verificationNotes: prepared.notes, exceptions, selfContained: check.selfContained }));
    return { figure, revision, output, exceptions };
  }
  async planExport(figureId: string, locale: "zh-CN" | "en", translation: Translation): Promise<ExportPlan> {
    const { figure, revision, output, exceptions } = await this.exportBytes(figureId, locale, translation);
    const destination = `exports/${figure.slug}-r${figure.revision}-${locale}.zip`;
    await safePath(this.workspace, destination);
    const inventory = Object.entries(output).map(([name, value]) => ({ path: name, bytes: value.length, sha256: digest(value) }));
    const files = inventory.filter((file) => file.path !== "manifest.json");
    const generatedManifest = { path: "manifest.json" as const, assignedOnExport: ["exportedAt"] as ["exportedAt"] };
    const plan = { schema: "sfl.submission-plan.v1" as const, figureId, revision: figure.revision, locale, destination, files, generatedManifest, sourceDigest: revision.manifestSha256, packageDigest: digest(jsonText(inventory)), exceptions };
    return { ...plan, digest: digest(jsonText(plan)) };
  }
  async applyExport(plan: ExportPlan, translation: Translation) {
    return withWorkflowLock(this.store, async () => {
      const fresh = await this.planExport(plan.figureId, plan.locale, translation);
      if (fresh.digest !== plan.digest) throw Error("Export files or project changed after preview; review a fresh export plan");
      const { output } = await this.exportBytes(plan.figureId, plan.locale, translation);
      if (digest(jsonText(Object.entries(output).map(([name, value]) => ({ path: name, bytes: value.length, sha256: digest(value) })))) !== plan.packageDigest) throw Error("Export files changed while packaging");
      const exportedAt = new Date().toISOString();
      output["manifest.json"] = Buffer.from(jsonText({ ...JSON.parse(Buffer.from(output["manifest.json"]!).toString("utf8")), exportedAt }));
      const target = await safePath(this.workspace, plan.destination);
      await fs.mkdir(path.dirname(target), { recursive: true });
      // Publish a complete ZIP in one no-overwrite operation. A failed write never leaves
      // a partial ZIP at the final path; hard-link creation is atomic and exclusive.
      const temporary = await safePath(this.workspace, `exports/.submission-${randomUUID()}.tmp`);
      const zip = zipSync(output, { level: 6 });
      try {
        await fs.writeFile(temporary, zip, { flag: "wx" });
        await fs.link(temporary, target);
      } finally { await fs.rm(temporary, { force: true }); }
      return { path: target, figureId: plan.figureId, revision: plan.revision, exportLocale: plan.locale, exportedAt, sha256: digest(zip), uploaded: false };
    });
  }
}
