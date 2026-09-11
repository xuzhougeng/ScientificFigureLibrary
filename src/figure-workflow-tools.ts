import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
import { StyleProfileStore, StyleSettings } from "./style-profile.ts";
import { ArchiveDetails, Artifact, ExportTranslation, FigureChange, ProjectFigures, type FigureChangePlan, type ExportPlan } from "./project-figures.ts";
import { atomicJson, readJsonOr, safePath, withWorkflowLock } from "./workflow-storage.ts";
import type { ToolOutcomeEnvelope } from "./library-binding-tools.ts";

function response(data: Record<string, unknown>, error?: string) {
  const envelope: ToolOutcomeEnvelope = { schema: "figure-library.tool-outcome.v1", outcome: error ? "failed" : "ok", terminal: true, retrySameCall: false, code: error ? "figure_workflow_failed" : "figure_workflow_ok", summary: error ?? "Figure workflow operation completed", nextAction: error ? "inspect_review" : "none" };
  return { ...(error ? { isError: true } : {}), content: [{ type: "text" as const, text: `OUTCOME: ${envelope.outcome}\nTERMINAL: true\nRETRY_SAME_CALL: false\nCODE: ${envelope.code}\nNEXT_ACTION: ${envelope.nextAction}\n${envelope.summary}\n${JSON.stringify(data)}` }], structuredContent: { envelope, ...data } };
}

export function registerFigureWorkflowTools(server: McpServer, workspaceRuntime: WorkspaceRuntime, profiles = new StyleProfileStore()) {
  const changePlans = new Map<string, { root: string; plan: FigureChangePlan }>();
  const exportPlans = new Map<string, { root: string; plan: ExportPlan }>();
  async function project() {
    const workspace = await workspaceRuntime.current();
    if (!workspace.confirmed || !workspace.directory) throw Error("Bind a project workspace before managing project figures");
    return new ProjectFigures(workspace.directory);
  }
  function register<S extends z.ZodRawShape>(name: string, description: string, shape: S, readOnly: boolean, run: (input: z.infer<z.ZodObject<S>>) => Promise<unknown>) {
    server.registerTool(name, { description, inputSchema: shape as z.ZodRawShape, _meta: { ui: { visibility: ["model", "app"] } }, annotations: { readOnlyHint: readOnly, destructiveHint: false, idempotentHint: readOnly, openWorldHint: false } }, async (raw) => {
      try {
        const value = await run(z.object(shape).strict().parse(raw));
        const data = value as Record<string, unknown>;
        return response(data);
      } catch (error) {
        return response({}, error instanceof Error ? error.message : String(error));
      }
    });
  }
  register("figure_library_get_style_profile", "Read the local user's saved style profile without modifying it. Disabled or absent profiles preserve template behavior.", {}, true, () => profiles.read());
  register("figure_library_save_style_profile", "Explicitly save or replace the user's long-term style preferences. Only use when the user asks to remember/change their defaults; never persist temporary instructions. Read current revision first.", { expectedRevision: z.number().int().nonnegative(), name: z.string().max(200), settings: StyleSettings, enabled: z.boolean().optional() }, false, (input) => profiles.save(input));
  register("figure_library_reset_style_profile", "Explicitly reset saved defaults while preserving the revision counter. Does not modify figures.", { expectedRevision: z.number().int().nonnegative() }, false, ({ expectedRevision }) => profiles.reset(expectedRevision));
  register("figure_library_resolve_style", "Read effective settings before adapting plotting code: template < enabled saved profile < current overrides. faithfulTemplate bypasses saved preferences. Semantic truth always takes priority. Host applies and verifies settings; this tool does not execute code.", { template: StyleSettings.optional(), overrides: StyleSettings.optional(), faithfulTemplate: z.boolean().optional() }, true, ({ template, overrides, faithfulTemplate }) => profiles.resolve(template, overrides, faithfulTemplate));
  register("figure_library_list_project_figures", "Find generated or planned project figures by stable ID, name, historical alias or Figure 1B. Multiple matches need disambiguation. Does not search public templates.", { query: z.string().max(500).optional() }, true, async ({ query }) => (await project()).list(query));
  register("figure_library_plan_project_figures", "Plan independent figures or panels before plotting. New entries need title and descriptive English slug for non-English titles. Label is optional (standalone figures do not occupy Figure 1). Batch updates permit panel swaps. Review before/after paths before apply. Planning A-H does not mark any panel rendered.", { changes: z.array(FigureChange).min(1).max(100), figuresDirectory: z.string().max(240).optional() }, true, async ({ changes, figuresDirectory }) => {
    const p = await project(); const plan = await p.plan(changes, figuresDirectory);
    if (changePlans.size >= 64) changePlans.delete(changePlans.keys().next().value!);
    changePlans.set(plan.digest, { root: p.workspace, plan }); return plan;
  });
  register("figure_library_apply_project_figures", "Apply a reviewed naming/grouping plan. Preserves stable IDs and historical revisions; moves working directories without overwriting targets. Does not render changed panel letters or rewrite external absolute references.", { planDigest: z.string().regex(/^[a-f0-9]{64}$/u) }, false, async ({ planDigest }) => {
    const cached = changePlans.get(planDigest); const p = await project();
    if (!cached || cached.root !== p.workspace) throw Error("Plan expired or workspace changed; make a fresh plan");
    const result = await p.apply(cached.plan); changePlans.delete(planDigest); return result;
  });
  register("figure_library_archive_project_figure", "Snapshot only the explicitly listed figure files under its working directory. Include real plotting data and actual scripts, parameters, environment and truthful sources. Distinguish raw experiments from analysis tables. Host reports execution; SFL never runs scripts. Returns integrity issues instead of treating incomplete archives as complete.", { figureId: z.string().uuid(), expectedRevision: z.number().int().nonnegative(), artifacts: z.array(Artifact).max(200), details: ArchiveDetails }, false, async ({ figureId, expectedRevision, artifacts, details }) => (await project()).archive(figureId, expectedRevision, artifacts, details));
  register("figure_library_check_project_figure", "Verify current archive hashes, required data/script/output roles, sources, execution report and artwork label state. This does not rerun code or validate scientific conclusions.", { figureId: z.string().uuid() }, true, async ({ figureId }) => (await project()).check(figureId));
  const translationInput = { figureId: z.string().uuid(), locale: z.enum(["zh-CN", "en"]) };
  register("figure_library_prepare_submission", "Record host-prepared language export copies after checking their code behavior and rerendered output. Both locales require English generated code; en also requires translated generated prose and plot labels. Original data/scripts remain unchanged. Records preparation only; no ZIP is generated. User reviews the file inventory before applying export.", { ...translationInput, translation: ExportTranslation }, false, async ({ figureId, locale, translation }) => {
    const p = await project(); const plan = await p.planExport(figureId, locale, translation);
    await withWorkflowLock(p.store, async () => {
      await atomicJson(await safePath(p.store, `export-${figureId}-${locale}.json`), { schema: "sfl.export-preparation.v1", sourceDigest: plan.sourceDigest, packageDigest: plan.packageDigest, translation });
    });
    return { ready: true, plan, note: "Choose language, review inventory and confirm export in the App, or call plan/apply submission export." };
  });
  async function preparation(p: ProjectFigures, figureId: string, locale: "zh-CN" | "en") {
    const prepared = await readJsonOr<{ schema: string; sourceDigest: string; packageDigest: string; translation: z.infer<typeof ExportTranslation> } | null>(await safePath(p.store, `export-${figureId}-${locale}.json`), null);
    if (!prepared || prepared.schema !== "sfl.export-preparation.v1") throw Error("请先让 Agent 准备所选语言的说明、英文代码和必要的重绘，再重试导出。");
    const plan = await p.planExport(figureId, locale, prepared.translation);
    if (plan.sourceDigest !== prepared.sourceDigest) throw Error("Figure revision changed; prepare this language again");
    if (plan.packageDigest !== prepared.packageDigest) throw Error("Prepared files changed after host verification; prepare this language again");
    return { plan, translation: prepared.translation };
  }
  register("figure_library_plan_submission_export", "Preview language-specific submission ZIP inventory and destination. Requires a complete archive and current host-verified language preparation; writes no ZIP. This is figure source-data packaging, not automatic journal compliance.", translationInput, true, async ({ figureId, locale }) => {
    const p = await project(); const { plan } = await preparation(p, figureId, locale);
    if (exportPlans.size >= 64) exportPlans.delete(exportPlans.keys().next().value!);
    exportPlans.set(plan.digest, { root: p.workspace, plan }); return plan;
  });
  register("figure_library_apply_submission_export", "Generate the reviewed language ZIP without overwriting existing files. Rechecks source/translation digests and workspace. No upload, journal submission or arbitrary execution.", { planDigest: z.string().regex(/^[a-f0-9]{64}$/u) }, false, async ({ planDigest }) => {
    const p = await project(); const cached = exportPlans.get(planDigest);
    if (!cached || cached.root !== p.workspace) throw Error("Export plan expired or workspace changed");
    const { translation } = await preparation(p, cached.plan.figureId, cached.plan.locale);
    const result = await p.applyExport(cached.plan, translation); exportPlans.delete(planDigest); return result;
  });
}
