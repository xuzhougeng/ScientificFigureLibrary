import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { assertExactTemplateSelector, exactSelectorDigest } from "../providers.ts";
import { providerSourcePaths } from "../provider-sources.ts";
import type { ExactTemplateSelector, TemplateCandidate } from "../types.ts";

const schema = "figure-library.favorite.v1";
const idSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const recordSchema = z.object({
  schema: z.literal(schema), id: idSchema, addedAt: z.string().datetime(),
  providerId: z.string().min(1), templateId: z.string().min(1),
  title: z.string(), sourceLabel: z.string(), application: z.string(),
  exactSelector: z.unknown(),
}).strict();
export interface Favorite {
  schema: typeof schema; id: string; addedAt: string;
  providerId: string; templateId: string; title: string; sourceLabel: string;
  application: string; exactSelector: ExactTemplateSelector;
}
function parse(value: unknown): Favorite {
  const entry = recordSchema.parse(value);
  assertExactTemplateSelector(entry.exactSelector);
  const selector = entry.exactSelector as ExactTemplateSelector;
  if (selector.providerId !== entry.providerId || exactSelectorDigest(selector) !== entry.id) {
    throw new Error("Favorite identity does not match its exact selector");
  }
  return { ...entry, exactSelector: selector };
}

/** User preferences, separate from immutable assets and rebuildable caches.
 * One atomic file per exact identity prevents unrelated concurrent stars from
 * overwriting one another. No session IDs, receipts, code or images are stored.
 */
export class FavoriteStore {
  readonly directory: string;
  constructor(directory = path.join(providerSourcePaths().configRoot, "favorites")) {
    this.directory = directory;
  }
  private file(id: string) { return path.join(this.directory, `${idSchema.parse(id)}.json`); }
  async get(id: string): Promise<Favorite | undefined> {
    try {
      const entry = parse(JSON.parse(await fs.readFile(this.file(id), "utf8")));
      if (entry.id !== id) throw new Error("Favorite filename does not match its identity");
      return entry;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  async list(): Promise<Favorite[]> {
    let names: string[];
    try { names = await fs.readdir(this.directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const entries = await Promise.all(names.filter(name => /^[a-f0-9]{64}\.json$/u.test(name))
      .map(name => this.get(name.slice(0, -5))));
    return entries.filter((entry): entry is Favorite => entry !== undefined)
      .sort((a, b) => b.addedAt.localeCompare(a.addedAt) || a.id.localeCompare(b.id));
  }
  async add(candidate: Pick<TemplateCandidate, "providerId" | "templateId" | "title" | "sourceLabel" | "application" | "exactSelector">): Promise<void> {
    const id = exactSelectorDigest(candidate.exactSelector);
    const previous = await this.get(id);
    const entry = parse({ schema, id, addedAt: previous?.addedAt ?? new Date().toISOString(),
      providerId: candidate.providerId, templateId: candidate.templateId,
      title: candidate.title, sourceLabel: candidate.sourceLabel,
      application: candidate.application, exactSelector: candidate.exactSelector });
    await fs.mkdir(this.directory, { recursive: true });
    const temporary = path.join(this.directory, `.${id}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, `${JSON.stringify(entry, null, 2)}\n`, { flag: "wx", mode: 0o600 });
      await fs.rename(temporary, this.file(id));
    } finally { await fs.rm(temporary, { force: true }); }
  }
  async remove(id: string): Promise<void> { await fs.rm(this.file(id), { force: true }); }
}
