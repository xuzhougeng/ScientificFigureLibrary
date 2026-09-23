import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { canonicalJson } from "../canonical-json.ts";
import { withCrossRuntimeWriteLock } from "../cross-runtime-lock.ts";
import type { LibraryRuntimeSnapshot } from "../library-runtime.ts";
import { providerSourcePaths } from "../provider-sources.ts";

const SCHEMA = "figure-library.custom-tags.v1";
const MAX_BYTES = 8 * 1024 * 1024;
const Identity = z.object({ providerId: z.string().min(1).max(200), templateId: z.string().min(1).max(500) }).strict();
const Tag = z.string().trim().min(1).max(40).regex(/^[^\x00-\x1f\x7f,，]+$/u);
export function normalizeCustomTags(value: unknown): string[] {
  const parsed = z.array(z.string()).max(20).safeParse(value);
  if (!parsed.success) throw new Error("每张图片最多保存 20 个文本标签。");
  const values = parsed.data.map(tag => tag.normalize("NFC").trim()).filter(Boolean);
  if (values.some(tag => !Tag.safeParse(tag).success)) throw new Error("每个标签最多 40 字符，不能包含逗号、换行或控制字符。");
  return [...new Set(values)].sort();
}
const Entry = Identity.extend({ tags: z.array(Tag).max(20) }).strict();
const FileSchema = z.object({ schema: z.literal(SCHEMA), libraryId: z.string().min(1), entries: z.array(Entry).max(5000) }).strict();
export type CustomTagEntry = z.infer<typeof Entry>;
export interface CustomTagSnapshot { libraryContext: string; entries: CustomTagEntry[]; tags: string[]; }
export const customTagKey = (identity: { providerId: string; templateId: string }) => canonicalJson([identity.providerId, identity.templateId]);

/** Personal, machine-local annotations, separate from immutable template metadata. */
export class CustomTagStore {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly current: () => Promise<LibraryRuntimeSnapshot>;
  private readonly directory: string;
  constructor(current: () => Promise<LibraryRuntimeSnapshot>, directory = path.join(providerSourcePaths().configRoot, "custom-tags")) {
    this.current = current; this.directory = directory;
  }
  file(libraryId: string) { return path.join(this.directory, `${createHash("sha256").update(libraryId).digest("hex")}.json`); }
  private async read(libraryId?: string): Promise<CustomTagEntry[]> {
    if (!libraryId) return [];
    let handle;
    try {
      const info = await fs.lstat(this.file(libraryId));
      if (!info.isFile() || info.isSymbolicLink()) throw new Error("标签配置必须是普通文件。");
      handle = await fs.open(this.file(libraryId), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error("自定义标签文件无效或过大；原文件已保留。");
      const data = FileSchema.parse(JSON.parse(await handle.readFile("utf8")));
      if (data.libraryId !== libraryId) throw new Error("自定义标签所属图库不匹配。");
      const keys = data.entries.map(customTagKey);
      if (new Set(keys).size !== keys.length) throw new Error("自定义标签文件包含重复图片；原文件已保留。");
      return data.entries.map(entry => ({ ...entry, tags: normalizeCustomTags(entry.tags) }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error("无法读取自定义标签，原文件已保留。请检查配置文件。", { cause: error });
    } finally { await handle?.close(); }
  }
  private snapshot(context: LibraryRuntimeSnapshot, entries: CustomTagEntry[]): CustomTagSnapshot {
    return { libraryContext: context.contextKey, entries, tags: [...new Set(entries.flatMap(entry => entry.tags))].sort() };
  }
  async list() {
    const context = await this.current();
    return this.snapshot(context, await this.read(context.libraryId));
  }
  async set(identity: { providerId: string; templateId: string }, input: { tags: unknown; expectedTags: unknown; libraryContext: string }) {
    const target = Identity.parse(identity);
    const tags = normalizeCustomTags(input.tags), expected = normalizeCustomTags(input.expectedTags);
    const task = this.queue.then(async () => {
      const context = await this.current();
      if (!context.libraryId || !context.writesEnabled) throw new Error("请先在设置中绑定图库，再保存自定义标签。");
      if (context.contextKey !== input.libraryContext) throw new Error("图库绑定已变化，请重新打开标签编辑器。");
      await fs.mkdir(this.directory, { recursive: true });
      const file = this.file(context.libraryId);
      return withCrossRuntimeWriteLock({ root: this.directory, lockDirectory: `${file}.lock`, libraryId: context.libraryId, operation: "custom-tags" }, async () => {
        const entries = await this.read(context.libraryId);
        const key = customTagKey(target), previous = entries.find(entry => customTagKey(entry) === key)?.tags ?? [];
        // Retried saves are idempotent; a different intervening edit is never overwritten.
        if (canonicalJson(previous) !== canonicalJson(tags) && canonicalJson(previous) !== canonicalJson(expected)) throw new Error("标签已在另一窗口中修改，请重新打开编辑器后再保存。");
        const updated = entries.filter(entry => customTagKey(entry) !== key);
        if (tags.length) updated.push({ ...target, tags });
        if (updated.length > 5000) throw new Error("已达到 5000 个图片标签记录的上限。");
        if ((await this.current()).contextKey !== context.contextKey) throw new Error("图库绑定已变化，请重新打开标签编辑器。");
        const serialized = JSON.stringify({ schema: SCHEMA, libraryId: context.libraryId, entries: updated }) + "\n";
        if (Buffer.byteLength(serialized) > MAX_BYTES) throw new Error("自定义标签文件已达到容量上限。");
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
          await fs.writeFile(temporary, serialized, { flag: "wx", mode: 0o600 });
          await fs.rename(temporary, file);
        } finally { await fs.rm(temporary, { force: true }); }
        return this.snapshot(context, updated);
      });
    });
    this.queue = task.catch(() => undefined);
    return task;
  }
}
