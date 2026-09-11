import path from "node:path";
import { z } from "zod";
import { defaultLibraryLocatorPath } from "./library-runtime.ts";
import { atomicJson, readJsonOr, safePath, withWorkflowLock } from "./workflow-storage.ts";

const positive = z.number().finite().positive().max(10000);
const semanticKey = z.string().min(1).max(100).refine((v) => !["__proto__", "constructor", "prototype"].includes(v));
export const StyleSettings = z.object({
  fontFamily: z.string().trim().min(1).max(150).optional(),
  fontSizePt: z.object({ title: positive.optional(), axis: positive.optional(), legend: positive.optional(), panel: positive.optional() }).strict().optional(),
  colors: z.record(semanticKey, z.string().regex(/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu)).optional(),
  size: z.object({ width: positive, height: positive.optional(), unit: z.enum(["mm", "cm", "in"]) }).strict().optional(),
  namedSizes: z.record(semanticKey, z.object({ width: positive, height: positive.optional(), unit: z.enum(["mm", "cm", "in"]) }).strict()).optional(),
  lineWidthMm: positive.optional(),
  legend: z.string().max(500).optional(),
  panelLabels: z.string().max(500).optional(),
  marginsMm: z.object({ top: positive, right: positive, bottom: positive, left: positive }).strict().optional(),
  export: z.object({ formats: z.array(z.enum(["png", "pdf", "svg", "tiff", "jpeg", "eps"])).min(1).max(6), rasterDpi: z.number().int().min(72).max(9600).optional(), background: z.string().max(100).optional() }).strict().optional(),
}).strict();
export type StyleSettingsValue = z.infer<typeof StyleSettings>;
const StoredStyle = z.object({ schema: z.literal("sfl.style-profile.v1"), revision: z.number().int().nonnegative(), enabled: z.boolean(), name: z.string(), settings: StyleSettings, updatedAt: z.string() }).strict();
export type StoredStyleValue = z.infer<typeof StoredStyle>;

function overlay(base: StyleSettingsValue, update: StyleSettingsValue): StyleSettingsValue {
  const output = { ...base, ...update };
  for (const key of ["colors", "fontSizePt", "namedSizes"] as const) {
    if (base[key] || update[key]) (output as Record<string, unknown>)[key] = { ...base[key], ...update[key] };
  }
  return StyleSettings.parse(output);
}

export class StyleProfileStore {
  readonly directory: string;
  constructor(directory = path.join(path.dirname(defaultLibraryLocatorPath()), "style-profile")) { this.directory = directory; }
  async read(): Promise<StoredStyleValue> {
    return StoredStyle.parse(await readJsonOr(await safePath(this.directory, "state.json"), {
      schema: "sfl.style-profile.v1", revision: 0, enabled: false, name: "", settings: {}, updatedAt: "",
    }));
  }
  async save(input: { expectedRevision: number; settings: StyleSettingsValue; name: string; enabled?: boolean }) {
    const settings = StyleSettings.parse(input.settings);
    return withWorkflowLock(this.directory, async () => {
      const previous = await this.read();
      if (previous.revision !== input.expectedRevision) throw Error("Style profile changed; read it again before saving");
      const next = StoredStyle.parse({ schema: previous.schema, revision: previous.revision + 1, enabled: input.enabled ?? true, name: input.name, settings, updatedAt: new Date().toISOString() });
      await atomicJson(await safePath(this.directory, "state.json"), next); return next;
    });
  }
  async reset(expectedRevision: number) { return this.save({ expectedRevision, settings: {}, name: "", enabled: false }); }
  async resolve(template: StyleSettingsValue = {}, overrides: StyleSettingsValue = {}, faithfulTemplate = false) {
    const profile = await this.read();
    const templateSettings = StyleSettings.parse(template); const current = StyleSettings.parse(overrides);
    const effective = overlay(profile.enabled && !faithfulTemplate ? overlay(templateSettings, profile.settings) : templateSettings, current);
    return { schema: "sfl.effective-style.v1", profileRevision: profile.revision, profileApplied: profile.enabled && !faithfulTemplate, effective, overrides: current, faithfulTemplate,
      validation: "Host must check fonts, backend support, dimensions and rendered output; saving settings does not execute or verify a plot." };
  }
}
