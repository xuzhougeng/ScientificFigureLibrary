import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  applyLibraryWriteLockRecovery,
  planLibraryWriteLockRecovery,
  type LibraryWriteLockRecoveryPlanV1,
} from "./cross-runtime-lock.ts";
import {
  applyGlobalLibraryBinding,
  planGlobalLibraryBinding,
  type GlobalLibraryBindingPlanV1,
  type LibraryRuntime,
  type LibraryRuntimeSnapshot,
} from "./library-runtime.ts";
import type { VersionedTemplateLibrary } from "./versioned-library.ts";
import {
  WorkspaceRuntime,
  applyGlobalWorkspaceBinding,
  planGlobalWorkspaceBinding,
  type WorkspaceBindingPlanV1,
} from "./workspace-runtime.ts";

const HASH = /^[a-f0-9]{64}$/u;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PLAN_TTL_MS = 30 * 60 * 1_000;
const PLAN_LIMIT = 64;

export interface CurrentLibraryContext {
  snapshot: LibraryRuntimeSnapshot;
  versionedLibrary: VersionedTemplateLibrary;
}

export type ToolOutcome =
  | "ok"
  | "needs_user_input"
  | "needs_user_confirmation"
  | "applied"
  | "replayed"
  | "blocked"
  | "not_found"
  | "conflict"
  | "failed";

export type ToolNextAction =
  | "none"
  | "ask_user"
  | "review_plan"
  | "apply_confirmed_plan"
  | "create_new_plan"
  | "inspect_review"
  | "preview_selected_candidate"
  | "stop_other_writers"
  | "rebind_library"
  | "rebind_workspace";

export interface ToolOutcomeEnvelope {
  schema: "figure-library.tool-outcome.v1";
  outcome: ToolOutcome;
  terminal: true;
  retrySameCall: false;
  code: string;
  summary: string;
  nextAction: ToolNextAction;
  missingConfirmations?: string[];
}

function outcomeEnvelope(
  outcome: ToolOutcome,
  code: string,
  summary: string,
  nextAction: ToolNextAction,
  missingConfirmations?: string[],
): ToolOutcomeEnvelope {
  return {
    schema: "figure-library.tool-outcome.v1",
    outcome,
    terminal: true,
    retrySameCall: false,
    code,
    summary,
    nextAction,
    ...(missingConfirmations?.length ? { missingConfirmations } : {}),
  };
}

function outcomeText(envelope: ToolOutcomeEnvelope, lines: string[] = []) {
  return [
    `OUTCOME: ${envelope.outcome}`,
    "TERMINAL: true",
    "RETRY_SAME_CALL: false",
    `CODE: ${envelope.code}`,
    `NEXT_ACTION: ${envelope.nextAction}`,
    envelope.summary,
    ...lines,
  ].join("\n");
}

function response(
  envelope: ToolOutcomeEnvelope,
  detail: Record<string, unknown> = {},
  lines: string[] = [],
): CallToolResult {
  return {
    content: [{ type: "text", text: outcomeText(envelope, lines) }],
    structuredContent: { envelope, ...detail },
  };
}

function failure(prefix: string, error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLocaleLowerCase("en-US");
  if (lower.includes("library_busy") || lower.includes("write-lock")) {
    return response(
      outcomeEnvelope(
        "blocked",
        "library_busy",
        `${prefix}: ${message}`,
        "stop_other_writers",
      ),
    );
  }
  if (lower.includes("stale") || lower.includes("changed after planning")) {
    return response(
      outcomeEnvelope(
        "conflict",
        "stale_plan",
        `${prefix}: ${message}`,
        "create_new_plan",
      ),
    );
  }
  if (lower.includes("environment override") || lower.includes("library_not_bound")) {
    return response(
      outcomeEnvelope(
        "blocked",
        "library_binding_required",
        `${prefix}: ${message}`,
        "rebind_library",
      ),
    );
  }
  return response(outcomeEnvelope("failed", "operation_failed", `${prefix}: ${message}`, "none"));
}

function sameNativePath(left: string, right: string) {
  const normalize = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
  };
  return normalize(left) === normalize(right);
}

const BindingPlanInput = z.object({
  libraryDirectory: z
    .string()
    .min(1)
    .max(4_000)
    .describe("Absolute native path chosen by the user for the one global portable Library."),
  migrationMode: z.enum(["none", "copy_legacy"]).optional().default("none"),
  legacySourceDirectory: z
    .string()
    .min(1)
    .max(4_000)
    .optional()
    .describe("Optional unmarked flat-v1 source copied non-destructively into migration staging."),
});

const ApplyPlanInput = z.object({
  planDigest: z.string().regex(HASH),
  operationId: z.string().regex(OPERATION_ID),
});
const RecoveryPlanInput = z.object({ reason: z.string().min(1).max(2_000) });

export function registerLibraryBindingTools(options: {
  server: McpServer;
  runtime: LibraryRuntime;
  workspaceRuntime?: WorkspaceRuntime;
  currentLibraries: () => Promise<CurrentLibraryContext>;
}) {
  const { server, runtime, currentLibraries } = options;
  const workspaceRuntime = options.workspaceRuntime;
  const bindingPlans = new Map<
    string,
    { plan: GlobalLibraryBindingPlanV1; expiresAt: number }
  >();
  const recoveryPlans = new Map<
    string,
    { plan: LibraryWriteLockRecoveryPlanV1; expiresAt: number }
  >();

  function remember<T>(
    store: Map<string, { plan: T; expiresAt: number }>,
    digest: string,
    plan: T,
  ) {
    const now = Date.now();
    for (const [key, value] of store) {
      if (value.expiresAt <= now) store.delete(key);
    }
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
      outcomeEnvelope(
        "blocked",
        "plan_not_available",
        `The ${kind} plan expired or belongs to another server process. Create and review a new plan; do not repeat this Apply call.`,
        "create_new_plan",
      ),
    );
  }

  server.registerTool(
    "figure_library_plan_bind_global",
    {
      title: "Plan global ScientificFigureLibrary binding",
      description:
        "Validate the user-selected global Library directory and optionally stage a non-destructive flat-v1 copy. This read-only plan never chooses a project directory implicitly.",
      inputSchema: BindingPlanInput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input): Promise<CallToolResult> => {
      try {
        if (!path.isAbsolute(input.libraryDirectory)) {
          return response(
            outcomeEnvelope(
              "needs_user_input",
              "absolute_library_directory_required",
              "The user must choose an absolute native directory for the global Library.",
              "ask_user",
              ["libraryDirectory"],
            ),
          );
        }
        if (input.legacySourceDirectory && input.migrationMode !== "copy_legacy") {
          return response(
            outcomeEnvelope(
              "needs_user_input",
              "migration_mode_required",
              "legacySourceDirectory is accepted only with migrationMode copy_legacy.",
              "ask_user",
              ["migrationMode"],
            ),
          );
        }
        if (input.legacySourceDirectory && !path.isAbsolute(input.legacySourceDirectory)) {
          return response(
            outcomeEnvelope(
              "needs_user_input",
              "absolute_legacy_directory_required",
              "The legacy source must be an absolute trusted native path.",
              "ask_user",
              ["legacySourceDirectory"],
            ),
          );
        }
        const bindingContext = runtime.bindingContext();
        if (
          bindingContext.environmentOverrideRoot &&
          !sameNativePath(input.libraryDirectory, bindingContext.environmentOverrideRoot)
        ) {
          return response(
            outcomeEnvelope(
              "blocked",
              "binding_blocked_by_environment_override",
              "FIGURE_LIBRARY_DIR takes precedence over the user locator. Bind that same directory or remove the override before selecting a different Library.",
              "rebind_library",
            ),
          );
        }
        const plan = await planGlobalLibraryBinding({
          ...input,
          locatorPath: bindingContext.locatorPath,
          environmentOverrideRoot: bindingContext.environmentOverrideRoot,
        });
        const envelope = outcomeEnvelope(
          "needs_user_confirmation",
          "binding_plan_ready",
          `No files were written. Review the exact Library path, libraryId, inventories, and migration mode for ${plan.libraryDirectory}.`,
          "apply_confirmed_plan",
        );
        remember(bindingPlans, plan.planDigest, plan);
        return response(envelope, { plan }, [
          `PLAN_DIGEST: ${plan.planDigest}`,
          `LIBRARY_DIRECTORY: ${plan.libraryDirectory}`,
          `LOCATOR_PATH: ${plan.locatorPath}`,
          `LIBRARY_ID: ${plan.libraryId}`,
          `CONFIG_REVISION: ${plan.configRevision}`,
          `LOCATOR_STATUS: ${plan.expectedLocatorStatus}`,
          `LOCATOR_RAW_DIGEST: ${plan.expectedLocatorRawDigest ?? "none"}`,
          `TARGET_FILES: ${plan.expectedTargetInventory.length}`,
          `TARGET_STATE_DIGEST: ${plan.expectedTargetStateDigest}`,
          `MIGRATION_MODE: ${plan.migration.mode}`,
          ...(plan.migration.mode === "copy_legacy"
            ? [
                `LEGACY_SOURCE_DIRECTORY: ${plan.migration.sourceDirectory}`,
                `LEGACY_FILES: ${plan.migration.sourceInventory.length}`,
                `LEGACY_INVENTORY_DIGEST: ${plan.migration.sourceInventoryDigest}`,
              ]
            : []),
        ]);
      } catch (error) {
        return failure("Global Library binding plan failed", error);
      }
    },
  );

  server.registerTool(
    "figure_library_apply_bind_global",
    {
      title: "Apply confirmed global Library binding",
      description:
        "Apply the exact reviewed binding plan using operation-id idempotency and stale-plan checks.",
      inputSchema: ApplyPlanInput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ planDigest, operationId }): Promise<CallToolResult> => {
      try {
        const plan = recalled(bindingPlans, planDigest);
        if (!plan) return missingPlan("global Library binding");
        const bindingContext = runtime.bindingContext();
        if (
          typeof plan.locatorPath !== "string" ||
          !sameNativePath(plan.locatorPath, bindingContext.locatorPath)
        ) {
          throw new Error("binding plan locatorPath does not match this runtime");
        }
        if (
          bindingContext.environmentOverrideRoot &&
          (typeof plan.libraryDirectory !== "string" ||
            !sameNativePath(plan.libraryDirectory, bindingContext.environmentOverrideRoot))
        ) {
          throw new Error("binding blocked by FIGURE_LIBRARY_DIR environment override");
        }
        if (plan.planDigest !== planDigest) throw new Error("planDigest does not match the supplied binding plan");
        const result = await applyGlobalLibraryBinding(
          plan as unknown as GlobalLibraryBindingPlanV1,
          operationId,
        );
        const effective = await runtime.refresh();
        const envelope = outcomeEnvelope(
          result.idempotentReplay ? "replayed" : "applied",
          result.idempotentReplay ? "binding_replayed" : "binding_applied",
          `${result.idempotentReplay ? "Replayed" : "Applied"} global Library binding ${result.libraryId}; effective source is ${effective.directorySource}.`,
          "none",
        );
        return response(envelope, {
          planDigest,
          result,
          effective: {
            libraryDirectory: effective.root,
            directorySource: effective.directorySource,
            libraryId: effective.libraryId,
            configRevision: effective.configRevision,
            writesEnabled: effective.writesEnabled,
          },
        }, [
          `PLAN_DIGEST: ${planDigest}`,
          `LIBRARY_DIRECTORY: ${effective.root}`,
          `LIBRARY_ID: ${effective.libraryId ?? result.libraryId}`,
          `CONFIG_REVISION: ${effective.configRevision ?? result.configRevision}`,
          `WRITES_ENABLED: ${effective.writesEnabled}`,
        ]);
      } catch (error) {
        return failure("Global Library binding Apply failed", error);
      }
    },
  );

  const workspacePlans = new Map<string, { plan: WorkspaceBindingPlanV1; expiresAt: number }>();
  const WorkspacePlanInput = z.object({
    workspaceDirectory: z
      .string()
      .min(1)
      .max(4_000)
      .describe("Absolute native path for the machine-local draft knowledge base (inbox/drafts/gallery)."),
  });

  server.registerTool(
    "figure_library_plan_bind_workspace",
    {
      title: "Plan Local workspace binding",
      description:
        "Validate the user-selected Local workspace directory. First-time machine confirmation only; later starts reuse the saved locator. Never infers the current project folder.",
      inputSchema: WorkspacePlanInput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input): Promise<CallToolResult> => {
      try {
        if (!path.isAbsolute(input.workspaceDirectory)) {
          return response(
            outcomeEnvelope(
              "needs_user_input",
              "absolute_workspace_directory_required",
              "The user must choose an absolute native directory for the Local workspace.",
              "ask_user",
              ["workspaceDirectory"],
            ),
          );
        }
        if (process.env.FIGURE_WORKSPACE_DIR?.trim()) {
          return response(
            outcomeEnvelope(
              "blocked",
              "binding_blocked_by_environment_override",
              "FIGURE_WORKSPACE_DIR takes precedence over the workspace locator.",
              "rebind_workspace",
            ),
          );
        }
        const plan = await planGlobalWorkspaceBinding({
          workspaceDirectory: input.workspaceDirectory,
          locatorPath: workspaceRuntime ? (await workspaceRuntime.current()).locatorPath : undefined,
        });
        remember(workspacePlans, plan.planDigest, plan);
        return response(
          outcomeEnvelope(
            "needs_user_confirmation",
            "workspace_binding_plan_ready",
            `No files were written. Review the Local workspace path ${plan.workspaceDirectory}. Skeleton creation: ${plan.willCreateSkeleton}.`,
            "apply_confirmed_plan",
          ),
          { plan },
          [
            `PLAN_DIGEST: ${plan.planDigest}`,
            `WORKSPACE_DIRECTORY: ${plan.workspaceDirectory}`,
            `LOCATOR_PATH: ${plan.locatorPath}`,
            `WORKSPACE_KIND: ${plan.workspaceKind}`,
            `WILL_CREATE_SKELETON: ${plan.willCreateSkeleton}`,
            `CONFIG_REVISION: ${plan.configRevision}`,
          ],
        );
      } catch (error) {
        return failure("Local workspace binding plan failed", error);
      }
    },
  );

  server.registerTool(
    "figure_library_apply_bind_workspace",
    {
      title: "Apply confirmed Local workspace binding",
      description:
        "Apply the exact reviewed workspace binding plan. After this first confirmation, later MCP starts reuse the same directory across projects.",
      inputSchema: ApplyPlanInput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ planDigest, operationId }): Promise<CallToolResult> => {
      try {
        const plan = recalled(workspacePlans, planDigest);
        if (!plan) return missingPlan("Local workspace binding");
        if (process.env.FIGURE_WORKSPACE_DIR?.trim()) {
          throw new Error("binding blocked by FIGURE_WORKSPACE_DIR environment override");
        }
        const result = await applyGlobalWorkspaceBinding(plan, operationId);
        const runtimeForRefresh = workspaceRuntime ?? new WorkspaceRuntime({ locatorPath: plan.locatorPath });
        const effective = await runtimeForRefresh.refresh();
        return response(
          outcomeEnvelope(
            result.idempotentReplay ? "replayed" : "applied",
            result.idempotentReplay ? "workspace_binding_replayed" : "workspace_binding_applied",
            `${result.idempotentReplay ? "Replayed" : "Applied"} Local workspace binding; later starts will reuse ${result.workspaceDirectory}.`,
            "none",
          ),
          { planDigest, result, effective },
          [
            `PLAN_DIGEST: ${planDigest}`,
            `WORKSPACE_DIRECTORY: ${result.workspaceDirectory}`,
            `WORKSPACE_CONFIRMED: ${effective.confirmed}`,
            `CREATED_SKELETON: ${result.createdSkeleton}`,
            `CONFIG_REVISION: ${result.configRevision}`,
          ],
        );
      } catch (error) {
        return failure("Local workspace binding Apply failed", error);
      }
    },
  );

  server.registerTool(
    "figure_library_plan_recover_write_lock",
    {
      title: "Plan abandoned global write-lock recovery",
      description:
        "Inspect one exact Library write lock. The user must stop every Wisp, Codex, Claude, and other writer before approving recovery; locks are never auto-stolen.",
      inputSchema: RecoveryPlanInput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ reason }): Promise<CallToolResult> => {
      try {
        const context = await currentLibraries();
        if (!context.snapshot.libraryId) {
          return response(
            outcomeEnvelope(
              "blocked",
              "library_not_bound",
              "A stable global libraryId is required before write-lock recovery can be planned.",
              "rebind_library",
            ),
          );
        }
        const plan = await planLibraryWriteLockRecovery({
          libraryRoot: context.snapshot.root,
          libraryId: context.snapshot.libraryId,
          reason,
        });
        const envelope = outcomeEnvelope(
          "needs_user_confirmation",
          "write_lock_recovery_plan_ready",
          "No files were changed. Stop every writer and review the exact owner, heartbeat, and digest before Apply.",
          "apply_confirmed_plan",
        );
        remember(recoveryPlans, plan.planDigest, plan);
        return response(envelope, { plan }, [
          `PLAN_DIGEST: ${plan.planDigest}`,
          `LIBRARY_ID: ${plan.libraryId}`,
          `LOCK_DIGEST: ${plan.expectedLockDigest}`,
          `OWNER_VALID: ${plan.ownerValid}`,
          `HEARTBEAT_VALID: ${plan.heartbeatValid}`,
          `HEARTBEAT_AGE_MS: ${plan.heartbeatAgeMs ?? "unknown"}`,
          `OWNER_OPERATION: ${plan.observedOwner?.operation ?? "unknown"}`,
          `OWNER_HOSTNAME: ${plan.observedOwner?.hostname ?? "unknown"}`,
        ]);
      } catch (error) {
        return failure("Write-lock recovery plan failed", error);
      }
    },
  );

  server.registerTool(
    "figure_library_apply_recover_write_lock",
    {
      title: "Apply confirmed global write-lock recovery",
      description:
        "Archive the exact unchanged abandoned lock and write a recovery receipt after all writers are confirmed stopped.",
      inputSchema: ApplyPlanInput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ planDigest, operationId }): Promise<CallToolResult> => {
      try {
        const plan = recalled(recoveryPlans, planDigest);
        if (!plan) return missingPlan("write-lock recovery");
        const context = await currentLibraries();
        if (!context.snapshot.libraryId) throw new Error("library_not_bound: stable libraryId missing");
        if (
          typeof plan.libraryRoot !== "string" ||
          !sameNativePath(plan.libraryRoot, context.snapshot.root) ||
          plan.libraryId !== context.snapshot.libraryId
        ) {
          throw new Error("write-lock recovery plan does not match the current global Library");
        }
        if (plan.planDigest !== planDigest) throw new Error("planDigest does not match the supplied recovery plan");
        const result = await applyLibraryWriteLockRecovery(
          plan as unknown as LibraryWriteLockRecoveryPlanV1,
          operationId,
        );
        const envelope = outcomeEnvelope(
          result.idempotentReplay ? "replayed" : "applied",
          result.idempotentReplay ? "write_lock_recovery_replayed" : "write_lock_recovered",
          `${result.idempotentReplay ? "Replayed" : "Applied"} write-lock recovery; the old lock remains in the recovery archive.`,
          "none",
        );
        return response(envelope, { planDigest, result }, [
          `PLAN_DIGEST: ${planDigest}`,
          `LIBRARY_ID: ${result.libraryId}`,
          `RECOVERED_LOCK_DIGEST: ${result.recoveredLockDigest}`,
          `OPERATION_ID: ${result.operationId}`,
        ]);
      } catch (error) {
        return failure("Write-lock recovery Apply failed", error);
      }
    },
  );
}
