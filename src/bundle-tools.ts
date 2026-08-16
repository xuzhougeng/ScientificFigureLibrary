import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type {
  CurrentLibraryContext,
  ToolOutcomeEnvelope,
} from "./library-binding-tools.ts";
import {
  PortableBundleManager,
  type BundleExportPlanV1,
  type FullLibraryRestorePlanV1,
  type TemplateBundleImportPlanV1,
} from "./portable-bundles.ts";

const HASH = /^[a-f0-9]{64}$/u;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PLAN_TTL_MS = 30 * 60 * 1_000;
const PLAN_LIMIT = 64;

function envelope(
  outcome: ToolOutcomeEnvelope["outcome"],
  code: string,
  summary: string,
  nextAction: ToolOutcomeEnvelope["nextAction"],
): ToolOutcomeEnvelope {
  return {
    schema: "figure-library.tool-outcome.v1",
    outcome,
    terminal: true,
    retrySameCall: false,
    code,
    summary,
    nextAction,
  };
}

function response(
  value: ToolOutcomeEnvelope,
  detail: Record<string, unknown> = {},
  lines: string[] = [],
): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: [
          `OUTCOME: ${value.outcome}`,
          "TERMINAL: true",
          "RETRY_SAME_CALL: false",
          `CODE: ${value.code}`,
          `NEXT_ACTION: ${value.nextAction}`,
          value.summary,
          ...lines,
        ].join("\n"),
      },
    ],
    structuredContent: { envelope: value, ...detail },
  };
}

function failure(prefix: string, error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLocaleLowerCase("en-US");
  if (lower.includes("stale") || lower.includes("already exists") || lower.includes("changed")) {
    return response(
      envelope("conflict", "stale_bundle_plan", `${prefix}: ${message}`, "create_new_plan"),
    );
  }
  if (lower.includes("library_busy") || lower.includes("write-lock")) {
    return response(
      envelope("blocked", "library_busy", `${prefix}: ${message}`, "stop_other_writers"),
    );
  }
  return response(envelope("failed", "bundle_operation_failed", `${prefix}: ${message}`, "none"));
}

function templateImportSource(plan: TemplateBundleImportPlanV1) {
  const source = plan.lifecyclePlan.content.intakeBinding?.sourceManifest;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new Error("template bundle import plan is missing its source manifest");
  }
  if (typeof source.sourceLibraryId !== "string" || !source.sourceLibraryId) {
    throw new Error("template bundle import plan is missing sourceLibraryId");
  }
  if (!source.selector || typeof source.selector !== "object" || Array.isArray(source.selector)) {
    throw new Error("template bundle import plan is missing its Published selector");
  }
  return { sourceLibraryId: source.sourceLibraryId, selector: source.selector };
}

const ExportPlanInput = z.object({
  kind: z.enum(["full_library", "published_template"]),
  destination: z.string().min(1).max(4_000),
  targetName: z.string().min(1).max(240).optional(),
  templateId: z.string().min(1).max(128).optional(),
  releaseId: z.string().min(1).max(128).optional(),
});
const RestorePlanInput = z.object({
  bundleDirectory: z.string().min(1).max(4_000),
  targetDirectory: z.string().min(1).max(4_000),
  mode: z.enum(["restore", "fork"]),
  authorityTransferConfirmed: z.boolean().optional().default(false),
});
const ImportPlanInput = z.object({
  bundleDirectory: z.string().min(1).max(4_000),
  targetTemplateId: z.string().min(1).max(128),
  mode: z.enum(["create", "update_published", "update_working"]).optional().default("create"),
});
const ApplyInput = z.object({
  planDigest: z.string().regex(HASH),
  operationId: z.string().regex(OPERATION_ID),
});
const ExportApplyInput = ApplyInput.extend({
  expectedTarget: z.string().min(1).max(4_000),
});

function sameNativePath(left: string, right: string) {
  const normalize = (value: string) => {
    const resolved = path.resolve(value).normalize("NFC");
    return process.platform === "win32"
      ? resolved.toLocaleLowerCase("en-US")
      : resolved;
  };
  return normalize(left) === normalize(right);
}

export function registerBundleTools(options: {
  server: McpServer;
  currentLibraries: () => Promise<CurrentLibraryContext>;
}) {
  const { server, currentLibraries } = options;
  const exportPlans = new Map<string, { plan: BundleExportPlanV1; expiresAt: number }>();
  const restorePlans = new Map<
    string,
    { plan: FullLibraryRestorePlanV1; expiresAt: number }
  >();
  const importPlans = new Map<
    string,
    { plan: TemplateBundleImportPlanV1; expiresAt: number }
  >();

  function remember<T>(
    store: Map<string, { plan: T; expiresAt: number }>,
    digest: string,
    plan: T,
  ) {
    const now = Date.now();
    for (const [key, value] of store) if (value.expiresAt <= now) store.delete(key);
    while (store.size >= PLAN_LIMIT) {
      const first = store.keys().next().value as string | undefined;
      if (!first) break;
      store.delete(first);
    }
    store.set(digest, { plan, expiresAt: now + PLAN_TTL_MS });
  }

  function recalled<T>(store: Map<string, { plan: T; expiresAt: number }>, digest: string) {
    const value = store.get(digest);
    if (!value) return undefined;
    if (value.expiresAt <= Date.now()) {
      store.delete(digest);
      return undefined;
    }
    return value.plan;
  }

  function missingPlan(kind: string) {
    return response(
      envelope(
        "blocked",
        "plan_not_available",
        `The ${kind} plan expired or belongs to another server process. Create and review a new plan; do not repeat this Apply call.`,
        "create_new_plan",
      ),
    );
  }

  server.registerTool(
    "figure_library_plan_bundle_export",
    {
      title: "Plan a portable Library or Published-template bundle",
      description:
        "Inventory either the authoritative Library (excluding rebuildable indexes/runtime locks) or one exact reachable Published Release. Produces a directory-bundle plan and writes nothing.",
      inputSchema: ExportPlanInput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input): Promise<CallToolResult> => {
      try {
        if (input.kind === "published_template" && !input.templateId) {
          return response(
            envelope(
              "needs_user_input",
              "template_id_required",
              "Published-template export requires templateId and may optionally select releaseId.",
              "ask_user",
            ),
          );
        }
        const context = await currentLibraries();
        const manager = new PortableBundleManager(
          context.snapshot.root,
          context.versionedLibrary,
        );
        const plan =
          input.kind === "full_library"
            ? await manager.planFullBackup({
                destination: input.destination,
                targetName: input.targetName,
              })
            : await manager.planPublishedTemplateExport({
                templateId: input.templateId!,
                releaseId: input.releaseId,
                destination: input.destination,
                targetName: input.targetName,
              });
        remember(exportPlans, plan.planDigest, plan);
        return response(
          envelope(
            "needs_user_confirmation",
            "bundle_export_plan_ready",
            `No files were written. Review ${plan.kind}, target, libraryId, selector, and ${plan.payloadInventory.length} inventory entries.`,
            "apply_confirmed_plan",
          ),
          { plan },
          [
            `PLAN_DIGEST: ${plan.planDigest}`,
            `KIND: ${plan.kind}`,
            `SOURCE_LIBRARY_ID: ${plan.sourceLibraryId}`,
            `TARGET: ${path.join(plan.destination, plan.targetName)}`,
            `FILES: ${plan.payloadInventory.length}`,
            `INVENTORY_DIGEST: ${plan.bundle.payloadInventoryDigest}`,
            ...(plan.bundle.schema === "figure-library.published-template-bundle.v1"
              ? [`PUBLISHED_SELECTOR: ${JSON.stringify(plan.bundle.selector)}`]
              : []),
          ],
        );
      } catch (error) {
        return failure("Bundle export planning failed", error);
      }
    },
  );

  server.registerTool(
    "figure_library_apply_bundle_export",
    {
      title: "Apply a confirmed portable bundle export",
      description:
        "Reverify the exact source inventory and visible expectedTarget, write a new directory bundle without overwrite, and persist an idempotent export receipt. A durable pre-write intent can recover a completed target after server restart.",
      inputSchema: ExportApplyInput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ planDigest, operationId, expectedTarget }): Promise<CallToolResult> => {
      try {
        const context = await currentLibraries();
        const manager = new PortableBundleManager(
          context.snapshot.root,
          context.versionedLibrary,
        );
        const durable = await manager.recoverExport({
          planDigest,
          operationId,
          expectedTarget,
        });
        if (durable) {
          return response(
            envelope(
              "replayed",
              durable.recovered ? "bundle_export_recovered" : "bundle_export_replayed",
              durable.recovered
                ? `Recovered and finalized portable bundle ${durable.bundleId} from its authoritative pre-write intent.`
                : `Verified existing portable bundle ${durable.bundleId}.`,
              "none",
            ),
            { planDigest, result: durable },
            [
              `TARGET: ${durable.target}`,
              `INVENTORY_DIGEST: ${durable.inventoryDigest}`,
              `OPERATION_ID: ${durable.operationId}`,
            ],
          );
        }
        const plan = recalled(exportPlans, planDigest);
        if (!plan) return missingPlan("bundle export");
        if (plan.planDigest !== planDigest) throw new Error("planDigest does not match supplied export plan");
        const plannedTarget = path.join(plan.destination, plan.targetName);
        if (!sameNativePath(expectedTarget, plannedTarget)) {
          throw new Error("expectedTarget does not match the cached bundle export plan");
        }
        const result = await manager.applyExport(
          plan as unknown as BundleExportPlanV1,
          operationId,
        );
        return response(
          envelope(
            result.idempotentReplay ? "replayed" : "applied",
            result.idempotentReplay ? "bundle_export_replayed" : "bundle_export_applied",
            `${result.idempotentReplay ? "Replayed" : "Exported"} portable bundle ${result.bundleId}.`,
            "none",
          ),
          { planDigest, result },
          [
            `TARGET: ${result.target}`,
            `INVENTORY_DIGEST: ${result.inventoryDigest}`,
            `OPERATION_ID: ${result.operationId}`,
          ],
        );
      } catch (error) {
        return failure("Bundle export Apply failed", error);
      }
    },
  );

  server.registerTool(
    "figure_library_plan_full_restore",
    {
      title: "Plan full-Library Restore or Fork",
      description:
        "Verify a full backup directory. Restore preserves libraryId and requires explicit authority transfer; Fork creates a new libraryId with fork provenance.",
      inputSchema: RestorePlanInput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input): Promise<CallToolResult> => {
      try {
        if (input.mode === "restore" && !input.authorityTransferConfirmed) {
          return response(
            envelope(
              "needs_user_input",
              "authority_transfer_confirmation_required",
              "Restore preserves libraryId. Confirm the old copy will stop accepting writes, or use Fork for an independent clone.",
              "ask_user",
            ),
          );
        }
        const plan = await PortableBundleManager.planFullLibraryRestore(input);
        remember(restorePlans, plan.planDigest, plan);
        return response(
          envelope(
            "needs_user_confirmation",
            "full_restore_plan_ready",
            `No files were written. Review ${plan.mode}, source/target libraryId, and target directory.`,
            "apply_confirmed_plan",
          ),
          { plan },
          [
            `PLAN_DIGEST: ${plan.planDigest}`,
            `MODE: ${plan.mode}`,
            `BUNDLE_DIRECTORY: ${plan.bundleDirectory}`,
            `BUNDLE_INVENTORY_DIGEST: ${plan.payloadInventoryDigest}`,
            `SOURCE_LIBRARY_ID: ${plan.sourceLibraryId}`,
            `TARGET_LIBRARY_ID: ${plan.targetLibraryId}`,
            `TARGET_DIRECTORY: ${plan.targetDirectory}`,
            `AUTHORITY_TRANSFER_CONFIRMED: ${plan.authorityTransferConfirmed}`,
          ],
        );
      } catch (error) {
        return failure("Full restore/fork planning failed", error);
      }
    },
  );

  server.registerTool(
    "figure_library_apply_full_restore",
    {
      title: "Apply confirmed full-Library Restore or Fork",
      description:
        "Restore/fork into an absent target, verify every byte, and write an immutable operation receipt. It never changes the active locator automatically.",
      inputSchema: ApplyInput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ planDigest, operationId }): Promise<CallToolResult> => {
      try {
        const plan = recalled(restorePlans, planDigest);
        if (!plan) return missingPlan("full restore/fork");
        if (plan.planDigest !== planDigest) throw new Error("planDigest does not match supplied restore plan");
        const result = await PortableBundleManager.applyFullLibraryRestore(
          plan as unknown as FullLibraryRestorePlanV1,
          operationId,
        );
        return response(
          envelope(
            result.idempotentReplay ? "replayed" : "applied",
            result.idempotentReplay ? "full_restore_replayed" : "full_restore_applied",
            `${result.idempotentReplay ? "Replayed" : "Applied"} full-Library ${result.mode}. The active locator was not changed.`,
            "none",
          ),
          { planDigest, result },
          [
            `TARGET: ${result.target}`,
            `SOURCE_LIBRARY_ID: ${result.sourceLibraryId}`,
            `TARGET_LIBRARY_ID: ${result.targetLibraryId}`,
            `OPERATION_ID: ${result.operationId}`,
          ],
        );
      } catch (error) {
        return failure("Full restore/fork Apply failed", error);
      }
    },
  );

  server.registerTool(
    "figure_library_plan_template_bundle_import",
    {
      title: "Plan Published-template bundle import as Working",
      description:
        "Verify an exact Published-template bundle, copy its immutable assets into a new local candidate, and plan a Working Revision. Source approval is provenance only and is never inherited.",
      inputSchema: ImportPlanInput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input): Promise<CallToolResult> => {
      try {
        const context = await currentLibraries();
        const plan = await new PortableBundleManager(
          context.snapshot.root,
          context.versionedLibrary,
        ).planTemplateBundleImport(input);
        const source = templateImportSource(plan);
        remember(importPlans, plan.planDigest, plan);
        return response(
          envelope(
            "needs_user_confirmation",
            "template_bundle_import_plan_ready",
            "No files were written. Review the target identity and Working Revision; source Published authority will not be inherited.",
            "apply_confirmed_plan",
          ),
          { plan },
          [
            `PLAN_DIGEST: ${plan.planDigest}`,
            `BUNDLE_DIRECTORY: ${plan.bundleDirectory}`,
            `BUNDLE_ID: ${plan.bundleId}`,
            `BUNDLE_INVENTORY_DIGEST: ${plan.bundleInventoryDigest}`,
            `SOURCE_LIBRARY_ID: ${source.sourceLibraryId}`,
            `SOURCE_PUBLISHED_SELECTOR: ${JSON.stringify(source.selector)}`,
            `TARGET_TEMPLATE_ID: ${plan.targetTemplateId}`,
            `ACTION: ${plan.lifecyclePlan.action}`,
            `REVISION_ID: ${plan.lifecyclePlan.content.revisionId}`,
            "AUTHORITY_INHERITED: false",
          ],
        );
      } catch (error) {
        return failure("Template bundle import planning failed", error);
      }
    },
  );

  server.registerTool(
    "figure_library_apply_template_bundle_import",
    {
      title: "Apply confirmed template-bundle import as Working",
      description:
        "Reverify the exact bundle and apply only the planned Working Revision. Local review and publish remain mandatory.",
      inputSchema: ApplyInput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ planDigest, operationId }): Promise<CallToolResult> => {
      try {
        const plan = recalled(importPlans, planDigest);
        if (!plan) return missingPlan("template bundle import");
        if (plan.planDigest !== planDigest) throw new Error("planDigest does not match supplied template import plan");
        const context = await currentLibraries();
        const result = await new PortableBundleManager(
          context.snapshot.root,
          context.versionedLibrary,
        ).applyTemplateBundleImport(
          plan as unknown as TemplateBundleImportPlanV1,
          operationId,
        );
        return response(
          envelope(
            result.idempotentReplay ? "replayed" : "applied",
            result.idempotentReplay ? "template_bundle_import_replayed" : "template_bundle_import_applied",
            `${result.idempotentReplay ? "Replayed" : "Imported"} template bundle as Working Revision.`,
            "inspect_review",
          ),
          { planDigest, result, authorityInherited: false },
          [
            `TEMPLATE_ID: ${result.templateId}`,
            `REVISION_ID: ${result.revisionId ?? "none"}`,
            `OPERATION_ID: ${result.operationId}`,
            "AUTHORITY_INHERITED: false",
          ],
        );
      } catch (error) {
        return failure("Template bundle import Apply failed", error);
      }
    },
  );
}
