import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const digest = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
export const jsonText = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

export function safeRelative(value: string): string {
  if (!value || value.length > 240 || value.includes("\\") || path.posix.isAbsolute(value)) throw Error("Use a relative forward-slash path");
  for (const part of value.split("/")) {
    if (!part || part === "." || part === ".." || /[<>:"|?*\x00-\x1f]/u.test(part) || /[. ]$/u.test(part)
      || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)) throw Error(`Unsafe path: ${value}`);
  }
  return value;
}

// Check every existing component, including the root: archive readers must not follow links.
export async function safePath(root: string, relative: string): Promise<string> {
  safeRelative(relative);
  const absoluteRoot = path.resolve(root);
  const parsed = path.parse(absoluteRoot);
  let current = parsed.root;
  for (const part of path.relative(parsed.root, absoluteRoot).split(path.sep).filter(Boolean).concat(relative.split("/"))) {
    current = path.join(current, part);
    try { if ((await fs.lstat(current)).isSymbolicLink()) throw Error(`Symbolic links are not allowed: ${current}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  return current;
}

export async function readJsonOr<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await fs.readFile(file, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw error; }
}

export async function atomicJson(file: string, value: unknown) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, jsonText(value), { flag: "wx" });
  try { await fs.rename(temporary, file); } finally { await fs.rm(temporary, { force: true }); }
}

export async function withWorkflowLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  await safePath(root, "state.json");
  await fs.mkdir(root, { recursive: true });
  const lock = await safePath(root, ".write-lock");
  // Never remove another writer's lock, including after a crashed writer.
  await fs.mkdir(lock).catch((error) => {
    if (error.code === "EEXIST") throw Error("Another workflow write is active; retry after it finishes. A stale lock requires manual inspection.");
    throw error;
  });
  try { return await operation(); } finally { await fs.rmdir(lock); }
}
