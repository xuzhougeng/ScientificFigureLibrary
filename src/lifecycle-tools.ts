import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { canonicalJson, canonicalJsonClone } from "./canonical-json.ts";
import {
  type FigureCodeRelationship,
  type JsonValue,
  type LifecycleApplyResult,
  type LifecyclePlan,
  type PublicLifecyclePlanKind,
  type ReviewAssessmentInput,
  type RevisionAssetInput,
  type VersionedTemplateCandidate,
  VersionedTemplateLibrary,
} from "./versioned-library.ts";

const HASH = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PLAN_CACHE_TTL_MS = 30 * 60 * 1_000;
const PLAN_CACHE_LIMIT = 64;
const MAX_ASSET_BYTES = 128 * 1024 * 1024;
const MAX_REVISION_BYTES = 512 * 1024 * 1024;

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

type NextAction =
  | "none"
  | "ask_user"
  | "review_plan"
  | "apply_confirmed_plan"
  | "create_new_plan"
  | "inspect_review"
  | "stop_other_writers"
  | "rebind_library";

interface ToolEnvelope {
  schema: "figure-library.tool-outcome.v1";
  outcome: ToolOutcome;
  terminal: true;
  retrySameCall: false;
  code: string;
  summary: string;
  nextAction: NextAction;
  missingConfirmations?: string[];
}

function jsonValue(value: unknown): JsonValue {
  return canonicalJsonClone(value) as JsonValue;
}

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function textEnvelope(envelope: ToolEnvelope, details: string[] = []) {
  return [
    `OUTCOME: ${envelope.outcome}`,
    "TERMINAL: true",
    "RETRY_SAME_CALL: false",
    `CODE: ${envelope.code}`,
    `SUMMARY: ${envelope.summary}`,
    ...(envelope.missingConfirmations?.length
      ? [`MISSING_CONFIRMATIONS: ${envelope.missingConfirmations.join(", ")}`]
      : []),
    `NEXT_ACTION: ${envelope.nextAction}`,
    ...details,
  ].join("\n");
}

function terminalResult(
  envelope: ToolEnvelope,
  structured: Record<string, unknown> = {},
  details: string[] = [],
): CallToolResult {
  return {
    content: [{ type: "text", text: textEnvelope(envelope, details) }],
    structuredContent: { envelope, ...structured },
  };
}

function envelope(
  outcome: ToolOutcome,
  code: string,
  summary: string,
  nextAction: NextAction,
  missingConfirmations?: string[],
): ToolEnvelope {
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

function blockedResult(code: string, prefix: string, error: unknown, nextAction: NextAction) {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLocaleLowerCase("en-US");
  if (lower.includes("library_busy") || lower.includes("write-lock")) {
    return terminalResult(
      envelope("blocked", "library_busy", `${prefix}: ${message}`, "stop_other_writers"),
    );
  }
  if (lower.includes("library_not_bound") || lower.includes("environment override")) {
    return terminalResult(
      envelope(
        "blocked",
        "library_binding_required",
        `${prefix}: ${message}`,
        "rebind_library",
      ),
    );
  }
  if (lower.includes("stale") || lower.includes("changed after planning")) {
    return terminalResult(
      envelope("conflict", "stale_plan", `${prefix}: ${message}`, "create_new_plan"),
    );
  }
  return terminalResult(envelope("blocked", code, `${prefix}: ${message}`, nextAction));
}

const ValidationErrorSchema = z.object({
  id: z.string().min(1).max(200).optional(),
  code: z.string().min(1).max(200),
  message: z.string().min(1).max(4_000),
  path: z.string().max(1_000).optional(),
  source: z.literal("agent").optional(),
});
const BlockingGateSchema = z.object({
  gateId: z.string().min(1).max(200),
  code: z.string().min(1).max(200),
  message: z.string().min(1).max(4_000),
  path: z.string().max(1_000).optional(),
  source: z.literal("agent").optional(),
});
const ReviewWarningSchema = z.object({
  id: z.string().min(1).max(200).optional(),
  code: z.string().min(1).max(200),
  message: z.string().min(1).max(4_000),
  path: z.string().max(1_000).optional(),
  source: z.literal("agent").optional(),
});
const ReviewAssessmentSchema = z.object({
  validationErrors: z.array(ValidationErrorSchema).max(100).optional(),
  blockingGates: z.array(BlockingGateSchema).max(100).optional(),
  warnings: z.array(ReviewWarningSchema).max(100).optional(),
});

const AssetOriginSchema = z.record(z.string(), z.unknown()).optional();
const VisualAssetSchema = z.object({
  assetId: z.string().regex(SAFE_ID),
  sourcePath: z.string().min(1).max(4_000),
  visualRole: z.enum(["source_reference", "rendered_output"]).optional(),
  mediaType: z.string().min(1).max(200).optional(),
  origin: AssetOriginSchema,
});
const CodeAssetSchema = z.object({
  assetId: z.string().regex(SAFE_ID),
  sourcePath: z.string().min(1).max(4_000),
  language: z.string().min(1).max(100).optional(),
  codeOrigin: z
    .enum(["user_supplied", "author_provided", "agent_generated", "adapted"])
    .optional(),
  mediaType: z.string().min(1).max(200).optional(),
  origin: AssetOriginSchema,
});
const SupportingAssetSchema = z.object({
  assetId: z.string().regex(SAFE_ID),
  sourcePath: z.string().min(1).max(4_000),
  mediaType: z.string().min(1).max(200).optional(),
  origin: AssetOriginSchema,
});
const FigureCodeLinkSchema = z.object({
  visualAssetId: z.string().regex(SAFE_ID),
  codeAssetIds: z.array(z.string().regex(SAFE_ID)).min(1).max(100),
  relationship: z.enum([
    "user_supplied_pair",
    "visual_inference",
    "adapted_from_template",
    "generated_output",
    "author_provided_original",
  ]),
  evidence: z.string().min(1).max(4_000),
  confirmedBy: z.literal("user"),
  confidence: z.number().min(0).max(1).optional(),
});
const ConfirmationsSchema = z.object({
  createOrUpdate: z.boolean().optional(),
  figureUnitBoundary: z.boolean().optional(),
  multiImageGrouping: z.boolean().optional(),
  primaryPreview: z.boolean().optional(),
  assetKind: z.boolean().optional(),
  canonicalImplementation: z.boolean().optional(),
  codeRelationships: z.boolean().optional(),
  codeOrigin: z.boolean().optional(),
  executionClaim: z.boolean().optional(),
  duplicateDecision: z.enum(["create_new", "update_exact", "reuse_existing"]).optional(),
});
const IntakeSchema = z.object({
  adapterId: z.string().regex(SAFE_ID).optional().default("user-upload"),
  importId: z.string().regex(SAFE_ID).optional(),
  sourceManifest: z.unknown().optional(),
});

const WorkingPlanInput = z.object({
  mode: z.enum(["create", "update"]).optional(),
  templateId: z.string().regex(SAFE_ID).optional(),
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(8_000).optional(),
  tags: z.array(z.string().min(1).max(200)).max(100).optional(),
  visualProfile: z.string().max(4_000).optional(),
  dataProfile: z.string().max(4_000).optional(),
  packages: z.array(z.string().min(1).max(200)).max(100).optional(),
  license: z.string().max(2_000).optional(),
  assetKind: z.enum(["plot_template", "visual_reference"]).optional(),
  language: z.string().min(1).max(100).optional(),
  plotFamily: z.string().max(200).optional(),
  codeStatus: z.enum(["none", "scaffold", "reviewed"]).optional(),
  executionStatus: z.enum(["not_run", "passed", "failed"]).optional(),
  intake: IntakeSchema.optional(),
  visualAssets: z.array(VisualAssetSchema).max(100).optional().default([]),
  codeAssets: z.array(CodeAssetSchema).max(100).optional().default([]),
  referenceAssets: z.array(SupportingAssetSchema).max(100).optional().default([]),
  evidenceAssets: z.array(SupportingAssetSchema).max(100).optional().default([]),
  primaryVisualAssetId: z.string().regex(SAFE_ID).optional(),
  canonicalCodeAssetId: z.string().regex(SAFE_ID).optional(),
  figureCodeLinks: z.array(FigureCodeLinkSchema).max(100).optional().default([]),
  confirmations: ConfirmationsSchema.optional(),
  assessment: ReviewAssessmentSchema.optional(),
  agentAssessment: z.record(z.string(), z.unknown()).optional(),
  provenance: z.record(z.string(), z.unknown()).optional(),
});

const WorkingApplyInput = z.object({
  planDigest: z.string().regex(HASH),
  operationId: z.string().regex(SAFE_ID),
  expectedAction: z.enum(["create_working", "update_working"]),
  expectedTemplateId: z.string().regex(SAFE_ID),
  expectedSeriesDigest: z.string().regex(HASH).nullable(),
});
const ReviewOpenInput = z.object({ templateId: z.string().regex(SAFE_ID).optional() });
const TemplateIdInput = z.object({ templateId: z.string().regex(SAFE_ID) });
const RevisionDiffInput = z.object({
  templateId: z.string().regex(SAFE_ID),
  fromRevisionId: z.string().regex(SAFE_ID),
  toRevisionId: z.string().regex(SAFE_ID),
});
const GateDecisionSchema = z.object({
  gateId: z.string().min(1).max(200),
  decision: z.enum(["resolved", "reopen"]),
  note: z.string().min(1).max(4_000),
});
const GatePlanInput = z.object({
  templateId: z.string().regex(SAFE_ID),
  decisions: z.array(GateDecisionSchema).min(1).max(100),
});
const ReleaseRestorePlanInput = z.object({
  templateId: z.string().regex(SAFE_ID),
  releaseId: z.string().regex(SAFE_ID),
});
const AdoptPlanInput = z.object({
  templateId: z.string().regex(SAFE_ID),
  canonicalImplementationAssetPath: z.string().min(1).max(1_000).optional(),
});
const GenericApplyInput = z.object({
  planDigest: z.string().regex(HASH),
  operationId: z.string().regex(SAFE_ID),
  expectedTemplateId: z.string().regex(SAFE_ID),
  expectedSeriesDigest: z.string().regex(HASH).nullable(),
});

type WorkingPlanRequest = z.infer<typeof WorkingPlanInput>;

interface CachedPlan {
  kind: PublicLifecyclePlanKind;
  publicDigest: string;
  digestPayload: unknown;
  backendPlan: LifecyclePlan;
  expiresAt: number;
}

class PublicPlanCache {
  private readonly entries = new Map<string, CachedPlan>();

  private prune() {
    const now = Date.now();
    for (const [digest, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(digest);
    }
    while (this.entries.size > PLAN_CACHE_LIMIT) {
      const first = this.entries.keys().next().value as string | undefined;
      if (!first) break;
      this.entries.delete(first);
    }
  }

  remember(entry: Omit<CachedPlan, "publicDigest" | "expiresAt">) {
    this.prune();
    const publicDigest = sha256(canonicalJson(entry.digestPayload));
    const existing = this.entries.get(publicDigest);
    if (existing && existing.expiresAt > Date.now()) return existing;
    const stored = { ...entry, publicDigest, expiresAt: Date.now() + PLAN_CACHE_TTL_MS };
    this.entries.set(publicDigest, stored);
    this.prune();
    return stored;
  }

  get(digest: string) {
    this.prune();
    return this.entries.get(digest);
  }
}

function uniqueIds(values: string[]) {
  return new Set(values).size === values.length;
}

function missingWorkingConfirmations(input: WorkingPlanRequest) {
  const missing: string[] = [];
  const confirmations = input.confirmations;
  if (!input.mode) missing.push("mode:create_or_update");
  if (input.mode === "update" && !input.templateId) missing.push("templateId_for_update");
  if (!input.title?.trim()) missing.push("title");
  if (!input.assetKind) missing.push("assetKind:plot_template_or_visual_reference");
  if (!input.visualAssets.length) missing.push("visualAssets");
  for (const asset of input.visualAssets) {
    if (!asset.visualRole) missing.push(`visualRole:${asset.assetId}`);
  }
  if (!input.primaryVisualAssetId) missing.push("primaryVisualAssetId");
  if (!confirmations?.createOrUpdate) missing.push("confirmation:createOrUpdate");
  if (!confirmations?.figureUnitBoundary) missing.push("confirmation:figureUnitBoundary");
  if (input.visualAssets.length > 1 && !confirmations?.multiImageGrouping) {
    missing.push("confirmation:multiImageGrouping");
  }
  if (!confirmations?.primaryPreview) missing.push("confirmation:primaryPreview");
  if (!confirmations?.assetKind) missing.push("confirmation:assetKind");
  if (!confirmations?.executionClaim) missing.push("confirmation:executionClaim");
  if (!confirmations?.duplicateDecision) missing.push("confirmation:duplicateDecision");
  if (input.assetKind === "plot_template") {
    if (!input.codeAssets.length) missing.push("codeAssets_for_plot_template");
    if (!input.canonicalCodeAssetId) missing.push("canonicalCodeAssetId");
    if (!input.figureCodeLinks.length) missing.push("figureCodeLinks");
    for (const asset of input.codeAssets) {
      if (!asset.codeOrigin) missing.push(`codeOrigin:${asset.assetId}`);
    }
    if (!confirmations?.canonicalImplementation) missing.push("confirmation:canonicalImplementation");
    if (!confirmations?.codeRelationships) missing.push("confirmation:codeRelationships");
    if (!confirmations?.codeOrigin) missing.push("confirmation:codeOrigin");
  }
  return [...new Set(missing)];
}

function extensionFromSource(sourcePath: string) {
  const extension = path.extname(sourcePath).toLocaleLowerCase();
  return /^\.[a-z0-9]{1,12}$/u.test(extension) ? extension : ".bin";
}

async function verifiedSources(input: WorkingPlanRequest) {
  const selected = [
    ...input.visualAssets.map((asset) => ({ ...asset, category: "visual" as const })),
    ...input.codeAssets.map((asset) => ({ ...asset, category: "code" as const })),
    ...input.referenceAssets.map((asset) => ({ ...asset, category: "reference" as const })),
    ...input.evidenceAssets.map((asset) => ({ ...asset, category: "evidence" as const })),
  ];
  const ids = selected.map((asset) => asset.assetId);
  if (!uniqueIds(ids)) throw new Error("asset IDs must be unique across the complete Figure Unit");
  let total = 0;
  const verified = [] as Array<(typeof selected)[number] & { sha256: string; bytes: number }>;
  for (const asset of selected) {
    if (!path.isAbsolute(asset.sourcePath) && !path.win32.isAbsolute(asset.sourcePath)) {
      throw new Error(`sourcePath must be an absolute trusted host path: ${asset.assetId}`);
    }
    const stat = await fs.lstat(asset.sourcePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`sourcePath must be a regular non-symbolic-link file: ${asset.assetId}`);
    }
    if (stat.size > MAX_ASSET_BYTES) throw new Error(`asset exceeds ${MAX_ASSET_BYTES} bytes: ${asset.assetId}`);
    total += stat.size;
    if (total > MAX_REVISION_BYTES) throw new Error(`Figure Unit exceeds ${MAX_REVISION_BYTES} bytes`);
    const bytes = new Uint8Array(await fs.readFile(asset.sourcePath));
    if (bytes.byteLength !== stat.size) throw new Error(`asset changed while being read: ${asset.assetId}`);
    verified.push({ ...asset, sha256: sha256(bytes), bytes: bytes.byteLength });
  }
  return verified;
}

function publicPlanBody(plan: LifecyclePlan) {
  const base = {
    schema: "figure-library.public-lifecycle-plan.v1",
    action: plan.action,
    templateId: plan.templateId,
    expectedSeriesDigest: plan.expectedSeriesDigest,
    createdAt: plan.createdAt,
  };
  if (plan.action === "create_working" || plan.action === "update_working" || plan.action === "restore_release") {
    return { ...base, content: plan.content, review: plan.review };
  }
  if (plan.action === "update_gates") return { ...base, review: plan.review };
  if (plan.action === "publish") return { ...base, release: plan.release };
  if (plan.action === "discard_working") return { ...base, discardedRevisionId: plan.discardedRevisionId };
  if (plan.action !== "adopt_legacy") throw new Error(`unsupported lifecycle plan: ${plan.action}`);
  return {
    ...base,
    migrationId: plan.migrationId,
    legacy: {
      legacyManifestSha256: plan.legacy.legacyManifestSha256,
      legacyReviewStatus: plan.legacy.legacyReviewStatus,
      content: plan.legacy.content,
      review: plan.legacy.review,
      release: plan.legacy.release,
    },
  };
}

function planSummary(entry: CachedPlan) {
  return { ...publicPlanBody(entry.backendPlan), planDigest: entry.publicDigest, written: false as const };
}

async function directCandidate(input: WorkingPlanRequest): Promise<VersionedTemplateCandidate> {
  const verified = await verifiedSources(input);
  const byId = new Map(verified.map((asset) => [asset.assetId, asset]));
  const visualPaths = new Map<string, string>();
  const codePaths = new Map<string, string>();
  const assets: RevisionAssetInput[] = [];
  for (const asset of verified) {
    const extension = extensionFromSource(asset.sourcePath);
    let logicalPath: string;
    if (asset.category === "visual") {
      logicalPath = `visuals/${asset.visualRole === "rendered_output" ? "rendered" : "source"}/${asset.assetId}${extension}`;
      visualPaths.set(asset.assetId, logicalPath);
      assets.push({
        logicalPath,
        role: "visual",
        visualRole: asset.visualRole!,
        sourcePath: asset.sourcePath,
        ...(asset.mediaType ? { mediaType: asset.mediaType } : {}),
        ...(asset.origin ? { origin: jsonValue(asset.origin) } : {}),
      });
    } else if (asset.category === "code") {
      logicalPath = `code/${asset.assetId}${extension}`;
      codePaths.set(asset.assetId, logicalPath);
      assets.push({
        logicalPath,
        role: "code",
        codeOrigin: asset.codeOrigin!,
        sourcePath: asset.sourcePath,
        ...(asset.language ? { language: asset.language } : {}),
        ...(asset.mediaType ? { mediaType: asset.mediaType } : {}),
        origin: jsonValue({ ...(asset.origin ?? {}), codeOrigin: asset.codeOrigin }),
      });
    } else {
      logicalPath = `${asset.category === "reference" ? "references" : "evidence"}/${asset.assetId}${extension}`;
      assets.push({
        logicalPath,
        role: asset.category,
        sourcePath: asset.sourcePath,
        ...(asset.mediaType ? { mediaType: asset.mediaType } : {}),
        ...(asset.origin ? { origin: jsonValue(asset.origin) } : {}),
      });
    }
  }

  const primaryPreview = visualPaths.get(input.primaryVisualAssetId!);
  if (!primaryPreview) throw new Error("primaryVisualAssetId must select one visual asset");
  const canonicalCode = input.canonicalCodeAssetId
    ? codePaths.get(input.canonicalCodeAssetId)
    : undefined;
  if (input.canonicalCodeAssetId && !canonicalCode) {
    throw new Error("canonicalCodeAssetId must select one code asset");
  }
  const figureCodeLinks = input.figureCodeLinks.map((link) => {
    const visualAssetPath = visualPaths.get(link.visualAssetId);
    if (!visualAssetPath) throw new Error(`figureCodeLinks references unknown visual: ${link.visualAssetId}`);
    const codeAssetPaths = link.codeAssetIds.map((assetId) => {
      const selected = codePaths.get(assetId);
      if (!selected) throw new Error(`figureCodeLinks references unknown code: ${assetId}`);
      return selected;
    });
    return {
      visualAssetPath,
      codeAssetPaths,
      evidence: link.evidence,
      relationship: link.relationship as FigureCodeRelationship,
      confirmedBy: "user" as const,
      ...(link.confidence !== undefined ? { confidence: link.confidence } : {}),
    };
  });

  const visualInference = figureCodeLinks.some((link) => link.relationship === "visual_inference");
  const executionStatus = input.executionStatus ?? "not_run";
  const codeStatus = input.assetKind === "visual_reference" ? "none" : input.codeStatus ?? "scaffold";
  if (visualInference && (executionStatus !== "not_run" || codeStatus !== "scaffold")) {
    throw new Error("visual_inference must remain scaffold/not_run and inspired_by_not_reproduced");
  }
  if (executionStatus === "passed") {
    const hasRendered = input.visualAssets.some((asset) => asset.visualRole === "rendered_output");
    const hasGeneratedLink = figureCodeLinks.some((link) => link.relationship === "generated_output");
    if (!hasRendered || !hasGeneratedLink || !input.evidenceAssets.length) {
      throw new Error("executionStatus passed requires a rendered_output, generated_output link, and evidence asset");
    }
  }

  const requiredAssetSha256 = [...new Set(verified.map((asset) => asset.sha256))].sort();
  const adapterId = input.intake?.adapterId ?? "user-upload";
  const sourceManifest = jsonValue(
    input.intake?.sourceManifest ?? {
      schema: "figure-library.user-upload-manifest.v1",
      assetIds: verified.map((asset) => asset.assetId).sort(),
    },
  );
  const importId = input.intake?.importId ?? `import-${sha256(canonicalJson({ adapterId, sourceManifest, requiredAssetSha256 })).slice(0, 24)}`;
  return {
    title: input.title!,
    description: input.description,
    tags: input.tags,
    visualProfile: input.visualProfile,
    dataProfile: input.dataProfile,
    packages: input.packages,
    license: input.license ?? "unspecified",
    assetKind: input.assetKind!,
    language: input.language ?? input.codeAssets.find((asset) => asset.assetId === input.canonicalCodeAssetId)?.language ?? "none",
    plotFamily: input.plotFamily,
    codeStatus,
    executionStatus,
    primaryPreview,
    ...(canonicalCode ? { canonicalImplementation: { assetPath: canonicalCode, selectedBy: "user" as const } } : {}),
    visualGrouping: {
      visualAssetPaths: input.visualAssets.map((asset) => visualPaths.get(asset.assetId)!),
      confirmedBy: "user",
      note: input.visualAssets.length > 1
        ? "The user confirmed this complete multi-image Figure Unit."
        : "The user confirmed the Figure Unit boundary.",
    },
    figureCodeLinks,
    provenance: input.provenance ? jsonValue(input.provenance) : undefined,
    annotations: jsonValue({
      schema: "figure-library.direct-intake-decision.v1",
      executionClaim: visualInference ? "inspired_by_not_reproduced" : executionStatus,
      agentAssessment: input.agentAssessment ?? null,
      userDecision: {
        confirmations: input.confirmations,
        primaryVisualAssetId: input.primaryVisualAssetId,
        canonicalCodeAssetId: input.canonicalCodeAssetId ?? null,
        figureCodeLinks: input.figureCodeLinks,
      },
    }),
    intakeBinding: { adapterId, importId, sourceManifest, requiredAssetSha256 },
    assets,
  };
}

function planDetails(plan: ReturnType<typeof planSummary>) {
  const details = [
    `PLAN_DIGEST: ${plan.planDigest}`,
    `ACTION: ${plan.action}`,
    `TEMPLATE_ID: ${plan.templateId}`,
    `EXPECTED_SERIES_DIGEST: ${plan.expectedSeriesDigest ?? "null"}`,
  ];
  if ("content" in plan && plan.content) {
    details.push(
      `REVISION_ID: ${plan.content.revisionId}`,
      `CONTENT_DIGEST: ${plan.content.contentDigest}`,
      ...plan.content.assets.map(
        (asset) =>
          `ASSET: ${asset.logicalPath} | ROLE=${asset.role} | BYTES=${asset.bytes} | SHA256=${asset.sha256}`,
      ),
    );
  }
  if ("review" in plan && plan.review) {
    details.push(
      `REVIEW_ID: ${plan.review.reviewId}`,
      `VALIDATION_ERRORS: ${plan.review.validationErrors.map((item) => item.code).join(", ") || "none"}`,
      `BLOCKING_GATES: ${plan.review.blockingGates.filter((item) => item.status === "open").map((item) => item.gateId).join(", ") || "none"}`,
      `REVIEW_WARNINGS: ${plan.review.warnings.map((item) => item.code).join(", ") || "none"}`,
      ...plan.review.validationErrors.map(
        (item) =>
          `VALIDATION_ERROR: ${item.code} | PATH=${item.path ?? "none"} | MESSAGE=${JSON.stringify(item.message)}`,
      ),
      ...plan.review.blockingGates.map(
        (item) =>
          `REVIEW_GATE: ${item.gateId} | STATUS=${item.status} | CODE=${item.code} | PATH=${item.path ?? "none"} | MESSAGE=${JSON.stringify(item.message)}`,
      ),
      ...plan.review.warnings.map(
        (item) =>
          `REVIEW_WARNING: ${item.code} | PATH=${item.path ?? "none"} | MESSAGE=${JSON.stringify(item.message)}`,
      ),
    );
  }
  if ("release" in plan && plan.release) {
    details.push(
      `RELEASE_ID: ${plan.release.releaseId}`,
      `RELEASE_REVISION_ID: ${plan.release.revisionId}`,
      `RELEASE_CONTENT_DIGEST: ${plan.release.contentDigest}`,
      `RELEASE_DIGEST: ${plan.release.releaseDigest}`,
    );
  }
  if ("discardedRevisionId" in plan) {
    details.push(`DISCARDED_REVISION_ID: ${plan.discardedRevisionId}`);
  }
  if ("legacy" in plan) {
    details.push(
      `MIGRATION_ID: ${plan.migrationId}`,
      `LEGACY_MANIFEST_SHA256: ${plan.legacy.legacyManifestSha256}`,
      `LEGACY_REVIEW_STATUS: ${plan.legacy.legacyReviewStatus}`,
      `REVISION_ID: ${plan.legacy.content.revisionId}`,
      `CONTENT_DIGEST: ${plan.legacy.content.contentDigest}`,
      `REVIEW_ID: ${plan.legacy.review.reviewId}`,
      `RELEASE_ID: ${plan.legacy.release?.releaseId ?? "none"}`,
    );
  }
  return details;
}

export function registerLifecycleTools(options: {
  server: McpServer;
  currentLibrary: () => Promise<VersionedTemplateLibrary>;
}) {
  const { server, currentLibrary } = options;
  const plans = new PublicPlanCache();

  async function replay(input: {
    kind: PublicLifecyclePlanKind;
    planDigest: string;
    operationId: string;
    expectedTemplateId: string;
    expectedSeriesDigest: string | null;
    expectedAction?: LifecyclePlan["action"];
  }) {
    return (await currentLibrary()).replayPublicOperation(input);
  }

  function applyResult(planDigest: string, result: LifecycleApplyResult) {
    const outcome = result.idempotentReplay ? "replayed" : "applied";
    const responseEnvelope = envelope(
      outcome,
      result.idempotentReplay ? "operation_replayed" : "operation_applied",
      `${result.action} completed for ${result.templateId}`,
      result.action === "publish" ? "none" : "inspect_review",
    );
    return terminalResult(responseEnvelope, { planDigest, result }, [
      `PLAN_DIGEST: ${planDigest}`,
      `OPERATION_ID: ${result.operationId}`,
      `ACTION: ${result.action}`,
      `TEMPLATE_ID: ${result.templateId}`,
      ...(result.revisionId ? [`REVISION_ID: ${result.revisionId}`] : []),
      ...(result.contentDigest ? [`CONTENT_DIGEST: ${result.contentDigest}`] : []),
      ...(result.reviewId ? [`REVIEW_ID: ${result.reviewId}`] : []),
      ...(result.releaseId ? [`RELEASE_ID: ${result.releaseId}`] : []),
    ]);
  }

  server.registerTool(
    "figure_library_review_open",
    {
      title: "Inspect template review state",
      description: "Host-neutral read-only inspection of Working, Published, history, Diff, and Review findings.",
      inputSchema: ReviewOpenInput.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ templateId }): Promise<CallToolResult> => {
      try {
        const library = await currentLibrary();
        if (!templateId) {
          const seriesList = [];
          for (const series of await library.listSeries()) {
            if (!series.workingHead) continue;
            const content = await library.getContent(series.templateId, series.workingHead.revisionId, series.workingHead.contentDigest);
            seriesList.push({ ...series, ...(content ? { title: content.title } : {}) });
          }
          return terminalResult(
            envelope("ok", "working_series_listed", `${seriesList.length} Series have a Working Head`, "none"),
            { view: "review", seriesList },
            seriesList.map(
              (item) =>
                `WORKING_SERIES: ${item.templateId} | TITLE=${JSON.stringify(item.title ?? "")} | WORKING_REVISION=${item.workingHead?.revisionId ?? "none"} | WORKING_DIGEST=${item.workingHead?.contentDigest ?? "none"} | PUBLISHED_RELEASE=${item.publishedHead?.releaseId ?? "none"}`,
            ),
          );
        }
        const series = await library.getSeries(templateId);
        if (!series) return terminalResult(envelope("not_found", "template_not_found", `Unknown versioned template: ${templateId}`, "none"));
        const history = await library.history(templateId);
        const publishedContent = series.publishedHead
          ? await library.getContent(templateId, series.publishedHead.revisionId, series.publishedHead.contentDigest)
          : undefined;
        const publishedRelease = series.publishedHead
          ? await library.getRelease(templateId, series.publishedHead.releaseId)
          : undefined;
        const workingContent = series.workingHead
          ? await library.getContent(templateId, series.workingHead.revisionId, series.workingHead.contentDigest)
          : undefined;
        const review = series.workingHead ? await library.getReview(templateId, series.workingHead.reviewId) : undefined;
        const diff = series.publishedHead && series.workingHead
          ? await library.diff(templateId, series.publishedHead.revisionId, series.workingHead.revisionId)
          : undefined;
        return terminalResult(
          envelope("ok", "review_loaded", `Loaded review state for ${templateId}`, "none"),
          { view: "review", templateId, series, ...(publishedContent ? { publishedContent } : {}), ...(publishedRelease ? { publishedRelease } : {}), ...(workingContent ? { workingContent } : {}), ...(review ? { review } : {}), ...(diff ? { diff } : {}), history },
          [
            `TEMPLATE_ID: ${templateId}`,
            `PUBLISHED_REVISION: ${series.publishedHead?.revisionId ?? "none"}`,
            `WORKING_REVISION: ${series.workingHead?.revisionId ?? "none"}`,
            `VALIDATION_ERRORS: ${review?.validationErrors.map((item) => item.code).join(", ") || "none"}`,
            `BLOCKING_GATES: ${review?.blockingGates.filter((item) => item.status === "open").map((item) => item.gateId).join(", ") || "none"}`,
            `REVIEW_WARNINGS: ${review?.warnings.map((item) => item.code).join(", ") || "none"}`,
            ...(review?.validationErrors.map(
              (item) =>
                `VALIDATION_ERROR: ${item.code} | PATH=${item.path ?? "none"} | MESSAGE=${JSON.stringify(item.message)}`,
            ) ?? []),
            ...(review?.blockingGates.map(
              (item) =>
                `REVIEW_GATE: ${item.gateId} | STATUS=${item.status} | CODE=${item.code} | PATH=${item.path ?? "none"} | MESSAGE=${JSON.stringify(item.message)} | RESOLUTION=${item.resolution ? JSON.stringify(item.resolution) : "none"}`,
            ) ?? []),
            ...(review?.warnings.map(
              (item) =>
                `REVIEW_WARNING: ${item.code} | PATH=${item.path ?? "none"} | MESSAGE=${JSON.stringify(item.message)}`,
            ) ?? []),
            ...(diff
              ? [
                  ...diff.fieldChanges.map(
                    (item) =>
                      `DIFF_FIELD: ${item.field} | BEFORE=${canonicalJson(item.before)} | AFTER=${canonicalJson(item.after)}`,
                  ),
                  ...diff.assets.added.map(
                    (item) => `DIFF_ASSET_ADDED: ${item.logicalPath} | SHA256=${item.sha256}`,
                  ),
                  ...diff.assets.removed.map(
                    (item) => `DIFF_ASSET_REMOVED: ${item.logicalPath} | SHA256=${item.sha256}`,
                  ),
                  ...diff.assets.changed.map(
                    (item) =>
                      `DIFF_ASSET_CHANGED: ${item.logicalPath} | BEFORE_SHA256=${item.before.sha256} | AFTER_SHA256=${item.after.sha256}`,
                  ),
                ]
              : []),
          ],
        );
      } catch (error) {
        return blockedResult("review_read_failed", "Review inspection failed", error, "none");
      }
    },
  );

  server.registerTool(
    "figure_library_template_history",
    {
      title: "Inspect immutable template history",
      description: "Return immutable Content Revision and Release history.",
      inputSchema: TemplateIdInput.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ templateId }): Promise<CallToolResult> => {
      try {
        const history = await (await currentLibrary()).history(templateId);
        return terminalResult(
          envelope("ok", "template_history_loaded", `${history.releases.length} immutable Releases for ${templateId}`, "none"),
          { view: "review", templateId, history },
          [
            `TEMPLATE_ID: ${templateId}`,
            `SERIES_STATUS: ${history.series.status}`,
            `PUBLISHED_RELEASE: ${history.series.publishedHead?.releaseId ?? "none"}`,
            `WORKING_REVISION: ${history.series.workingHead?.revisionId ?? "none"}`,
            ...history.revisions.map(
              (item) =>
                `REVISION: ${item.revisionId} | CREATED_AT=${item.createdAt} | CONTENT_DIGEST=${item.contentDigest} | PARENT=${item.parentRevisionId ?? "none"} | RESTORED_FROM=${item.restoredFromReleaseId ?? "none"} | TITLE=${JSON.stringify(item.title)}`,
            ),
            ...history.releases.map(
              (item) =>
                `RELEASE: ${item.releaseId} | PUBLISHED_AT=${item.publishedAt} | REVISION_ID=${item.revisionId} | CONTENT_DIGEST=${item.contentDigest} | REVIEW_ID=${item.reviewId} | RELEASE_DIGEST=${item.releaseDigest}`,
            ),
          ],
        );
      } catch (error) {
        return blockedResult("template_history_failed", "Template history failed", error, "none");
      }
    },
  );

  server.registerTool(
    "figure_library_diff_revisions",
    {
      title: "Diff two immutable Content Revisions",
      description: "Compare complete revision fields and asset inventories without modifying either revision.",
      inputSchema: RevisionDiffInput.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ templateId, fromRevisionId, toRevisionId }): Promise<CallToolResult> => {
      try {
        const diff = await (await currentLibrary()).diff(templateId, fromRevisionId, toRevisionId);
        return terminalResult(
          envelope("ok", "revision_diff_loaded", `${diff.fieldChanges.length} fields changed for ${templateId}`, "none"),
          { view: "review", templateId, diff },
          [
            `FIELD_CHANGES: ${diff.fieldChanges.length}`,
            `ASSETS_ADDED: ${diff.assets.added.length}`,
            `ASSETS_REMOVED: ${diff.assets.removed.length}`,
            `ASSETS_CHANGED: ${diff.assets.changed.length}`,
            ...diff.fieldChanges.map(
              (item) =>
                `FIELD_CHANGE: ${item.field} | BEFORE=${canonicalJson(item.before)} | AFTER=${canonicalJson(item.after)}`,
            ),
            ...diff.assets.added.map(
              (item) => `ASSET_ADDED: ${item.logicalPath} | SHA256=${item.sha256}`,
            ),
            ...diff.assets.removed.map(
              (item) => `ASSET_REMOVED: ${item.logicalPath} | SHA256=${item.sha256}`,
            ),
            ...diff.assets.changed.map(
              (item) =>
                `ASSET_CHANGED: ${item.logicalPath} | BEFORE_SHA256=${item.before.sha256} | AFTER_SHA256=${item.after.sha256}`,
            ),
          ],
        );
      } catch (error) {
        return blockedResult("revision_diff_failed", "Revision diff failed", error, "none");
      }
    },
  );

  server.registerTool(
    "figure_library_plan_working_revision",
    {
      title: "Plan a direct-intake Working Revision",
      description: "Validate user-confirmed image/code intake and return an immutable Working Revision plan. The server never calls a model or executes code.",
      inputSchema: WorkingPlanInput.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input): Promise<CallToolResult> => {
      try {
        const missing = missingWorkingConfirmations(input);
        if (missing.length) {
          return terminalResult(
            envelope("needs_user_input", "missing_confirmations", "The Figure Unit is not ready to plan", "ask_user", missing),
          );
        }
        if (input.confirmations?.duplicateDecision === "reuse_existing") {
          if (!input.templateId) {
            return terminalResult(
              envelope("needs_user_input", "reuse_target_required", "Reusing an existing template requires templateId", "ask_user", ["templateId_for_reuse"]),
            );
          }
          return terminalResult(
            envelope("ok", "reuse_existing_selected", `The user selected existing template ${input.templateId}; no Working Revision was planned`, "none"),
            { templateId: input.templateId, written: false },
          );
        }
        if (input.mode === "create" && input.confirmations?.duplicateDecision !== "create_new") {
          return terminalResult(envelope("conflict", "duplicate_decision_mismatch", "Create mode requires duplicateDecision create_new", "ask_user"));
        }
        if (input.mode === "update" && input.confirmations?.duplicateDecision !== "update_exact") {
          return terminalResult(envelope("conflict", "duplicate_decision_mismatch", "Update mode requires duplicateDecision update_exact", "ask_user"));
        }
        const candidate = await directCandidate(input);
        const library = await currentLibrary();
        const backendPlan = input.mode === "create"
          ? await library.planCreateWorking({ templateId: input.templateId, candidate, assessment: input.assessment as ReviewAssessmentInput | undefined })
          : await library.planUpdateWorking({ templateId: input.templateId!, candidate, assessment: input.assessment as ReviewAssessmentInput | undefined });
        const digestPayload = {
          schema: "figure-library.public-lifecycle-plan-digest.v1",
          kind: "working",
          exactPlan: publicPlanBody(backendPlan),
        };
        const entry = plans.remember({ kind: "working", digestPayload, backendPlan });
        const plan = planSummary(entry);
        return terminalResult(
          envelope("needs_user_confirmation", "working_revision_plan_ready", `Review ${plan.action} for ${plan.templateId}; no files were written`, "apply_confirmed_plan"),
          { plan },
          planDetails(plan),
        );
      } catch (error) {
        return blockedResult("working_revision_plan_failed", "Working Revision planning failed", error, "create_new_plan");
      }
    },
  );

  server.registerTool(
    "figure_library_apply_working_revision",
    {
      title: "Apply a confirmed Working Revision plan",
      description: "Reverify source bytes and apply the exact cached plan with operation-id idempotency and stale-state checks.",
      inputSchema: WorkingApplyInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input): Promise<CallToolResult> => {
      try {
        const entry = plans.get(input.planDigest);
        if (!entry) {
          const result = await replay({ kind: "working", ...input });
          return result
            ? applyResult(input.planDigest, result)
            : terminalResult(envelope("blocked", "plan_not_available", "The unapplied plan expired or the server restarted", "create_new_plan"));
        }
        if (entry.kind !== "working") return terminalResult(envelope("conflict", "plan_kind_mismatch", "The plan is not a Working Revision plan", "create_new_plan"));
        if (entry.backendPlan.templateId !== input.expectedTemplateId || entry.backendPlan.expectedSeriesDigest !== input.expectedSeriesDigest || entry.backendPlan.action !== input.expectedAction) {
          return terminalResult(envelope("conflict", "plan_expectation_mismatch", "Apply expectations do not match the reviewed plan", "create_new_plan"));
        }
        const result = await (await currentLibrary()).applyPlan(entry.backendPlan, input.operationId, { kind: entry.kind, planDigest: entry.publicDigest });
        return applyResult(entry.publicDigest, result);
      } catch (error) {
        return blockedResult("working_revision_apply_failed", "Working Revision Apply failed", error, "create_new_plan");
      }
    },
  );

  function registerSimpleLifecycle(config: {
    kind: Exclude<PublicLifecyclePlanKind, "working">;
    planName: string;
    applyName: string;
    planTitle: string;
    applyTitle: string;
    planSchema: z.ZodType;
    plan: (library: VersionedTemplateLibrary, input: never) => Promise<LifecyclePlan>;
  }) {
    server.registerTool(
      config.planName,
      {
        title: config.planTitle,
        description: "Create a read-only lifecycle plan. No files or pointers are changed.",
        inputSchema: config.planSchema,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (input): Promise<CallToolResult> => {
        try {
          const backendPlan = await config.plan(await currentLibrary(), input as never);
          const entry = plans.remember({
            kind: config.kind,
            backendPlan,
            digestPayload: { schema: "figure-library.public-lifecycle-plan-digest.v1", kind: config.kind, exactPlan: publicPlanBody(backendPlan) },
          });
          const plan = planSummary(entry);
          return terminalResult(
            envelope("needs_user_confirmation", "lifecycle_plan_ready", `Review ${plan.action} for ${plan.templateId}; no files were written`, "apply_confirmed_plan"),
            { plan },
            planDetails(plan),
          );
        } catch (error) {
          return blockedResult("lifecycle_plan_blocked", `${config.planTitle} failed`, error, "inspect_review");
        }
      },
    );
    server.registerTool(
      config.applyName,
      {
        title: config.applyTitle,
        description: "Apply the exact cached plan with operation-id idempotency and stale-state checks.",
        inputSchema: GenericApplyInput.shape,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (input): Promise<CallToolResult> => {
        try {
          const entry = plans.get(input.planDigest);
          if (!entry) {
            const result = await replay({ kind: config.kind, ...input });
            return result
              ? applyResult(input.planDigest, result)
              : terminalResult(envelope("blocked", "plan_not_available", "The unapplied plan expired or the server restarted", "create_new_plan"));
          }
          if (entry.kind !== config.kind) return terminalResult(envelope("conflict", "plan_kind_mismatch", `The plan does not match ${config.applyName}`, "create_new_plan"));
          if (entry.backendPlan.templateId !== input.expectedTemplateId || entry.backendPlan.expectedSeriesDigest !== input.expectedSeriesDigest) {
            return terminalResult(envelope("conflict", "plan_expectation_mismatch", "Apply expectations do not match the reviewed plan", "create_new_plan"));
          }
          const result = await (await currentLibrary()).applyPlan(entry.backendPlan, input.operationId, { kind: entry.kind, planDigest: entry.publicDigest });
          return applyResult(entry.publicDigest, result);
        } catch (error) {
          return blockedResult("lifecycle_apply_failed", `${config.applyTitle} failed`, error, "create_new_plan");
        }
      },
    );
  }

  registerSimpleLifecycle({
    kind: "gate",
    planName: "figure_library_plan_review_gate_update",
    applyName: "figure_library_apply_review_gate_update",
    planTitle: "Plan Review Gate decisions",
    applyTitle: "Apply Review Gate decisions",
    planSchema: GatePlanInput,
    plan: (library, input: z.infer<typeof GatePlanInput>) => library.planGateUpdate(input),
  });
  registerSimpleLifecycle({
    kind: "publish",
    planName: "figure_library_plan_publish_working_revision",
    applyName: "figure_library_apply_publish_working_revision",
    planTitle: "Plan atomic approval and publication",
    applyTitle: "Apply atomic approval and publication",
    planSchema: TemplateIdInput,
    plan: (library, input: z.infer<typeof TemplateIdInput>) => library.planPublish(input),
  });
  registerSimpleLifecycle({
    kind: "discard",
    planName: "figure_library_plan_discard_working_revision",
    applyName: "figure_library_apply_discard_working_revision",
    planTitle: "Plan Working Head discard",
    applyTitle: "Apply Working Head discard",
    planSchema: TemplateIdInput,
    plan: (library, input: z.infer<typeof TemplateIdInput>) => library.planDiscardWorking(input),
  });
  registerSimpleLifecycle({
    kind: "restore",
    planName: "figure_library_plan_restore_release",
    applyName: "figure_library_apply_restore_release",
    planTitle: "Plan historical Release restoration as Working",
    applyTitle: "Apply historical Release restoration as Working",
    planSchema: ReleaseRestorePlanInput,
    plan: (library, input: z.infer<typeof ReleaseRestorePlanInput>) => library.planRestoreRelease(input),
  });
  registerSimpleLifecycle({
    kind: "adopt",
    planName: "figure_library_plan_adopt_versioning",
    applyName: "figure_library_apply_adopt_versioning",
    planTitle: "Plan explicit flat-v1 adoption",
    applyTitle: "Apply explicit flat-v1 adoption",
    planSchema: AdoptPlanInput,
    plan: (library, input: z.infer<typeof AdoptPlanInput>) => library.planAdoptLegacy(input),
  });
}
