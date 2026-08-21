import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  ProviderSourceManager,
  type ProviderSourceChangeAction,
  type ProviderSourceChangeInput,
  type ProviderSourceChangePlanV1,
  type ProviderSourceAlreadyCurrentV1,
} from "./provider-sources.ts";

const HASH = /^[a-f0-9]{64}$/u;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

type ToolOutcome =
  | "ok"
  | "needs_user_input"
  | "needs_user_confirmation"
  | "applied"
  | "replayed"
  | "blocked"
  | "not_found"
  | "conflict"
  | "failed";

type ToolNextAction = "none" | "ask_user" | "apply_confirmed_plan" | "create_new_plan";

interface ToolOutcomeEnvelope {
  schema: "figure-library.tool-outcome.v1";
  outcome: ToolOutcome;
  terminal: true;
  retrySameCall: false;
  code: string;
  summary: string;
  nextAction: ToolNextAction;
  missingConfirmations?: string[];
}

function envelope(
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

function response(
  outcome: ToolOutcomeEnvelope,
  detail: Record<string, unknown> = {},
  lines: string[] = [],
): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: [
          `OUTCOME: ${outcome.outcome}`,
          "TERMINAL: true",
          "RETRY_SAME_CALL: false",
          `CODE: ${outcome.code}`,
          `NEXT_ACTION: ${outcome.nextAction}`,
          outcome.summary,
          ...lines,
        ].join("\n"),
      },
    ],
    structuredContent: { envelope: outcome, ...detail },
  };
}

function failure(prefix: string, error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLocaleLowerCase("en-US");
  if (lower.includes("plan is not available") || lower.includes("another server process")) {
    return response(
      envelope(
        "blocked",
        "plan_not_available",
        `${prefix}: ${message}`,
        "create_new_plan",
      ),
    );
  }
  if (
    lower.includes("stale") ||
    lower.includes("changed after planning") ||
    lower.includes("rollback") ||
    lower.includes("equivocation") ||
    lower.includes("collision")
  ) {
    return response(
      envelope("conflict", "provider_source_conflict", `${prefix}: ${message}`, "create_new_plan"),
    );
  }
  if (lower.includes("not found")) {
    return response(envelope("not_found", "provider_source_not_found", `${prefix}: ${message}`, "none"));
  }
  if (lower.includes("write-lock") || lower.includes("library_busy")) {
    return response(envelope("blocked", "provider_source_busy", `${prefix}: ${message}`, "none"));
  }
  return response(envelope("failed", "provider_source_operation_failed", `${prefix}: ${message}`, "none"));
}

const ProviderId = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]{1,126}[a-z0-9]$/u)
  .describe("Provider-qualified identity declared by the signed personal catalog.");

const ListInput = z.object({});

const PlanInput = z.object({
  action: z.enum(["add", "update", "configure", "remove", "trust_reset"]),
  expectedProviderId: ProviderId
    .optional()
    .describe("Add only: independently expected providerId; the signed manifest and catalog must match it."),
  providerId: ProviderId.optional().describe("Existing providerId for Update, Configure, Remove, or Trust Reset."),
  manifestUrl: z
    .string()
    .min(1)
    .max(4_000)
    .optional()
    .describe("Public HTTPS URL for the canonical signed provider manifest."),
  publicKeyBase64: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe("Add/Trust Reset: independently obtained canonical base64 for the raw 32-byte Ed25519 public key."),
  enabled: z.boolean().optional(),
  includeInDefaultSearch: z
    .boolean()
    .optional()
    .describe("Opt in to ordinary default search. Add defaults this to false."),
  allowSequenceReset: z
    .boolean()
    .optional()
    .describe("Trust-reset only: explicitly permit a lower sequence under the new trust epoch."),
});

const ApplyInput = z.object({
  planDigest: z.string().regex(HASH),
  operationId: z.string().regex(OPERATION_ID),
  expectedAction: z.enum(["add", "update", "configure", "remove", "trust_reset"]),
  expectedProviderId: ProviderId,
});

type RawPlanInput = z.infer<typeof PlanInput>;

function checkedPlanInput(input: RawPlanInput): ProviderSourceChangeInput {
  const missing: string[] = [];
  if (input.action === "add") {
    if (!input.expectedProviderId) missing.push("expectedProviderId");
    if (!input.manifestUrl) missing.push("manifestUrl");
    if (!input.publicKeyBase64) missing.push("publicKeyBase64");
    if (missing.length) throw new Error(`missing required Add fields: ${missing.join(", ")}`);
    return {
      action: "add",
      expectedProviderId: input.expectedProviderId!,
      manifestUrl: input.manifestUrl!,
      publicKeyBase64: input.publicKeyBase64!,
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.includeInDefaultSearch !== undefined
        ? { includeInDefaultSearch: input.includeInDefaultSearch }
        : {}),
    };
  }
  if (input.action === "update") {
    if (!input.providerId) throw new Error("missing required Update field: providerId");
    return { action: "update", providerId: input.providerId };
  }
  if (input.action === "remove") {
    if (!input.providerId) throw new Error("missing required Remove field: providerId");
    return { action: "remove", providerId: input.providerId };
  }
  if (input.action === "trust_reset") {
    if (!input.providerId) throw new Error("missing required Trust Reset field: providerId");
    if (!input.publicKeyBase64) throw new Error("missing required Trust Reset field: publicKeyBase64");
    return {
      action: "trust_reset",
      providerId: input.providerId,
      publicKeyBase64: input.publicKeyBase64,
      ...(input.manifestUrl ? { manifestUrl: input.manifestUrl } : {}),
      ...(input.allowSequenceReset !== undefined
        ? { allowSequenceReset: input.allowSequenceReset }
        : {}),
    };
  }
  if (!input.providerId) throw new Error("missing required Configure field: providerId");
  return {
    action: "configure",
    providerId: input.providerId,
    ...(input.manifestUrl ? { manifestUrl: input.manifestUrl } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
    ...(input.includeInDefaultSearch !== undefined
      ? { includeInDefaultSearch: input.includeInDefaultSearch }
      : {}),
  };
}

function planLines(plan: ProviderSourceChangePlanV1) {
  return [
    `ACTION: ${plan.action}`,
    `PROVIDER_ID: ${plan.providerId}`,
    `MANIFEST_URL: ${plan.manifestUrl ?? "none"}`,
    `PREVIOUS_SIGNING_KEY_ID: ${plan.previousSigningKeyId ?? "none"}`,
    `SIGNING_KEY_ID: ${plan.signingKeyId ?? "none"}`,
    `PREVIOUS_TRUST_EPOCH: ${plan.previousTrustEpoch ?? "none"}`,
    `TRUST_EPOCH: ${plan.trustEpoch ?? "none"}`,
    `ALLOW_SEQUENCE_RESET: ${plan.allowSequenceReset === true}`,
    `ENABLED: ${plan.enabled ?? "removed"}`,
    `INCLUDE_IN_DEFAULT_SEARCH: ${plan.includeInDefaultSearch ?? "removed"}`,
    `CONFIG_PATH: ${plan.configPath}`,
    `TARGET_SNAPSHOT_PATH: ${plan.targetSnapshotPath ?? "none"}`,
    `SNAPSHOT_SEQUENCE: ${plan.snapshot?.sequence ?? "none"}`,
    `MANIFEST_SHA256: ${plan.snapshot?.manifestSha256 ?? "none"}`,
    `CATALOG_SHA256: ${plan.snapshot?.catalogSha256 ?? "none"}`,
    `PREVIEWS_SHA256: ${plan.snapshot?.previewsSha256 ?? "none"}`,
    `TEMPLATE_COUNT: ${plan.snapshot?.templateCount ?? "none"}`,
    `TEMPLATES_ADDED: ${plan.templateDiff.added.join(", ") || "none"}`,
    `TEMPLATES_UPDATED: ${plan.templateDiff.updated.map((item) => item.identity).join(", ") || "none"}`,
    `TEMPLATES_WITHDRAWN: ${plan.templateDiff.withdrawn.join(", ") || "none"}`,
    `TOMBSTONES: ${plan.templateDiff.tombstones.join(", ") || "none"}`,
    ...plan.accessUrls.map((url, index) => `ACCESS_URL_${index + 1}: ${url}`),
    ...plan.warnings.map((warning, index) => `WARNING_${index + 1}: ${warning}`),
    `EXPECTED_CONFIG_REVISION: ${plan.expectedConfigRevision}`,
    `PROPOSED_CONFIG_REVISION: ${plan.proposedConfigRevision}`,
    `PLAN_DIGEST: ${plan.planDigest}`,
    "PLAN_WRITES: none",
  ];
}

function isAlreadyCurrent(
  value: ProviderSourceChangePlanV1 | ProviderSourceAlreadyCurrentV1,
): value is ProviderSourceAlreadyCurrentV1 {
  return "status" in value;
}

interface PersonalProviderRuntimeStatus {
  providerId: string;
  health: "ready" | "degraded" | "corrupt";
  errorCode?: string;
  safeMessage?: string;
  details?: Record<string, unknown>;
}

export function registerProviderSourceTools(options: {
  server: McpServer;
  manager?: ProviderSourceManager;
  builtInSources?: () => Promise<Array<Record<string, unknown>>>;
  personalSourceStatuses?: () => Promise<PersonalProviderRuntimeStatus[]>;
  onApplied?: () => Promise<void>;
}) {
  const { server } = options;
  const manager = options.manager ?? new ProviderSourceManager();

  server.registerTool(
    "figure_library_list_provider_sources",
    {
      title: "List configured personal figure providers",
      description:
        "Read the configured personal provider sources and their last-known-good snapshot identities without making any network request. The raw trusted public key is never returned.",
      inputSchema: ListInput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (): Promise<CallToolResult> => {
      try {
        const result = await manager.listSources();
        const builtInSources = options.builtInSources ? await options.builtInSources() : [];
        const runtimeStatuses = options.personalSourceStatuses
          ? await options.personalSourceStatuses()
          : [];
        const runtimeStatusById = new Map(
          runtimeStatuses.map((status) => [String(status.providerId ?? ""), status]),
        );
        const personalSources: Array<Record<string, unknown>> = result.sources.map((source) => {
          const runtimeStatus = runtimeStatusById.get(source.providerId);
          const health = runtimeStatus?.health === "ready" || runtimeStatus?.health === "degraded" ||
              runtimeStatus?.health === "corrupt"
            ? runtimeStatus.health
            : "degraded";
          const details = runtimeStatus && typeof runtimeStatus.details === "object" &&
              runtimeStatus.details !== null && !Array.isArray(runtimeStatus.details)
            ? runtimeStatus.details as Record<string, unknown>
            : {};
          const errorCode = typeof runtimeStatus?.errorCode === "string"
            ? runtimeStatus.errorCode
            : typeof details.errorCode === "string"
              ? details.errorCode
              : health === "ready"
                ? undefined
                : "provider_runtime_status_unavailable";
          const safeMessage = typeof runtimeStatus?.safeMessage === "string"
            ? runtimeStatus.safeMessage
            : typeof details.safeMessage === "string"
              ? details.safeMessage
              : health === "ready"
                ? undefined
                : "The configured Provider is not backed by a verified runtime snapshot.";
          // A failed aggregate LKG load does not prove that every component is
          // corrupt. Report both component checks as unverified and retain the
          // precise safe error at the source level instead of overclaiming.
          const verification = health === "ready" ? "verified" : "unverified";
          const runtimeLastError = errorCode && safeMessage
            ? { errorCode, message: safeMessage }
            : null;
          return {
            sourceKind: "signed-personal",
            ...source,
            health,
            signature: { ...source.signature, status: verification },
            inventory: { ...source.inventory, status: verification },
            lastError: health === "ready" ? source.lastError : runtimeLastError ?? source.lastError,
            ...(errorCode ? { errorCode } : {}),
            ...(safeMessage ? { safeMessage } : {}),
            ...(runtimeStatus ? { details } : {}),
          };
        });
        const sources: Array<Record<string, unknown>> = [...builtInSources, ...personalSources];
        const listed = { ...result, sources };
        const outcome = envelope(
          "ok",
          "provider_sources_listed",
          `Listed ${sources.length} built-in and configured Provider source(s) entirely offline.`,
          "none",
        );
        return response(outcome, { result: listed }, [
          `CONFIG_REVISION: ${result.configRevision}`,
          `SOURCE_COUNT: ${sources.length}`,
          ...sources.flatMap((source, index) => [
            `SOURCE_${index + 1}_PROVIDER_ID: ${String(source.providerId ?? "unknown")}`,
            `SOURCE_${index + 1}_KIND: ${String(source.sourceKind ?? "unknown")}`,
            `SOURCE_${index + 1}_ENABLED: ${String(source.enabled ?? true)}`,
            `SOURCE_${index + 1}_DEFAULT_SEARCH: ${String(source.includeInDefaultSearch ?? true)}`,
            `SOURCE_${index + 1}_TEMPLATE_COUNT: ${String(source.templateCount ?? "unknown")}`,
            `SOURCE_${index + 1}_HEALTH: ${String(source.health ?? "degraded")}`,
          ]),
        ]);
      } catch (error) {
        return failure("Provider source listing failed", error);
      }
    },
  );

  server.registerTool(
    "figure_library_plan_provider_source_change",
    {
      title: "Plan a signed personal provider change",
      description:
        "Plan Add, Update, Configure, Remove, or explicit Trust Reset for a signed personal provider. Network access occurs only when the requested action must verify a snapshot. Planning never writes configuration or snapshots.",
      inputSchema: PlanInput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (rawInput): Promise<CallToolResult> => {
      try {
        const input = checkedPlanInput(rawInput);
        const plan = await manager.planChange(input);
        if (isAlreadyCurrent(plan)) {
          const outcome = envelope(
            "ok",
            "provider_source_already_current",
            `Provider ${plan.providerId} is already at the verified sequence and manifest identity. No Apply is available or required.`,
            "none",
          );
          return response(outcome, { result: plan }, [
            `ACTION: ${plan.action}`,
            `PROVIDER_ID: ${plan.providerId}`,
            `STATUS: ${plan.status}`,
            `SEQUENCE: ${plan.sequence}`,
            `MANIFEST_SHA256: ${plan.manifestSha256}`,
            `CONFIG_REVISION: ${plan.configRevision}`,
            "PLAN_WRITES: none",
            "APPLY_REQUIRED: false",
          ]);
        }
        const risk = plan.action === "remove"
          ? "Removing the source stops future discovery but deliberately keeps immutable snapshots and already materialized projects."
          : plan.action === "trust_reset"
            ? "Trust Reset replaces the independently trusted key and starts a new trust epoch; review the key fingerprint and sequence-reset choice carefully."
            : "Review the exact provider, endpoints, key identity, snapshot identity, and search inclusion before Apply.";
        const outcome = envelope(
          "needs_user_confirmation",
          "provider_source_plan_ready",
          `No files were written. ${risk}`,
          "apply_confirmed_plan",
        );
        return response(outcome, { plan }, planLines(plan));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.startsWith("missing required")) {
          const fields = message.split(":", 2)[1]?.split(",").map((value) => value.trim()) ?? [];
          return response(
            envelope(
              "needs_user_input",
              "provider_source_fields_required",
              message,
              "ask_user",
              fields,
            ),
          );
        }
        return failure("Provider source change plan failed", error);
      }
    },
  );

  server.registerTool(
    "figure_library_apply_provider_source_change",
    {
      title: "Apply a confirmed signed provider change",
      description:
        "Apply the exact cached provider-source plan with stale-state checks and operation-id replay protection. Apply never accepts a raw public key or endpoint override.",
      inputSchema: ApplyInput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        // Apply deliberately re-fetches and pins the exact planned remote
        // snapshot before switching local configuration.
        openWorldHint: true,
      },
    },
    async (input): Promise<CallToolResult> => {
      try {
        const result = await manager.applyChange(input);
        await options.onApplied?.();
        const replayed = result.idempotentReplay === true;
        const outcome = envelope(
          replayed ? "replayed" : "applied",
          replayed ? "provider_source_change_replayed" : "provider_source_change_applied",
          `${replayed ? "Replayed" : "Applied"} ${result.action} for provider ${result.providerId}.`,
          "none",
        );
        return response(outcome, { result }, [
          `ACTION: ${result.action}`,
          `PROVIDER_ID: ${result.providerId}`,
          `CONFIG_REVISION: ${result.configRevision}`,
          `MANIFEST_SHA256: ${result.manifestSha256 ?? "none"}`,
          `PLAN_DIGEST: ${result.planDigest}`,
          `OPERATION_ID: ${result.operationId}`,
          `IDEMPOTENT_REPLAY: ${replayed}`,
        ]);
      } catch (error) {
        return failure("Provider source change Apply failed", error);
      }
    },
  );
}

export type { ProviderSourceChangeAction };
