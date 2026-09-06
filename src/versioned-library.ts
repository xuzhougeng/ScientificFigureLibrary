import { runtimePath, assertUniqueRuntimePaths, inspectRuntimeReads, assertRuntimeReads } from "./runtime-closure.ts";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  canonicalJson,
  canonicalJsonClone,
  compareCanonicalStrings,
} from "./canonical-json.ts";
import { withCrossRuntimeWriteLock } from "./cross-runtime-lock.ts";
import {
  MCP_IMAGE_MEDIA_TYPES,
  assertMcpImageBytes,
} from "./image-validation.ts";
import {
  assertLibraryOperationContext,
  assertNoPortableCaseCollision,
  assertPortableFilesystemSegment,
  assertPortableSegment,
  ensureLibraryRootMarker,
  operationContextForSnapshot,
  portableCaseFold,
  resolveLibraryRuntimeSnapshotSync,
  type LibraryDirectorySource,
  type LibraryOperationContext,
  type LibraryRuntimeSnapshot,
} from "./library-runtime.ts";

export const TEMPLATE_SERIES_SCHEMA = "figure-library.template-series.v1" as const;
export const TEMPLATE_CONTENT_SCHEMA = "figure-library.template-content.v1" as const;
export const VALIDATION_STATE_SCHEMA = "figure-library.validation-state.v1" as const;
export const REVIEW_SNAPSHOT_SCHEMA = "figure-library.review-snapshot.v1" as const;
export const TEMPLATE_RELEASE_SCHEMA = "figure-library.template-release.v1" as const;
export const LIFECYCLE_PLAN_SCHEMA = "figure-library.lifecycle-plan.v1" as const;
export const LIFECYCLE_OPERATION_RECEIPT_SCHEMA =
  "figure-library.lifecycle-operation-receipt.v1" as const;
export const LIFECYCLE_OPERATION_INTENT_SCHEMA =
  "figure-library.lifecycle-operation-intent.v1" as const;
export const LEGACY_ADOPTION_RECEIPT_SCHEMA =
  "figure-library.legacy-adoption-receipt.v1" as const;
export const IMPORT_RECEIPT_SCHEMA =
  "figure-library.import-receipt.v1" as const;
export const MATERIALIZATION_PLAN_SCHEMA =
  "figure-library.materialization-plan.v1" as const;
export const MATERIALIZATION_RECEIPT_SCHEMA =
  "figure-library.materialization-receipt.v1" as const;

const HASH = /^[a-f0-9]{64}$/u;
const SAFE_SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_ASSET_BYTES = 128 * 1024 * 1024;
const MAX_REVISION_BYTES = 512 * 1024 * 1024;

type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type VersionedAssetKind = "plot_template" | "visual_reference";
export type VersionedCodeStatus = "none" | "scaffold" | "reviewed";
export type ExecutionStatus = "not_run" | "passed" | "failed";
export type PlotExecutionScope =
  | "synthetic_data"
  | "example_data"
  | "real_data"
  | "unknown";
export type UpstreamWorkflowStatus =
  | "unknown"
  | "not_run"
  | "partial"
  | "passed"
  | "failed"
  | "not_applicable";
export type ScientificValidationStatus =
  | "not_assessed"
  | "limited"
  | "validated"
  | "rejected"
  | "not_applicable";
export type ScientificValidationDecisionSource = "user" | "external_review";
export type RevisionAssetRole = "visual" | "code" | "reference" | "evidence";
export type VisualAssetRole = "source_reference" | "rendered_output";
export type FigureCodeRelationship =
  | "user_supplied_pair"
  | "visual_inference"
  | "adapted_from_template"
  | "generated_output"
  | "author_provided_original";
export type CodeAssetOrigin =
  | "user_supplied"
  | "author_provided"
  | "agent_generated"
  | "adapted";
export type ReviewSource = "system" | "rule" | "agent" | "user" | "migration";

export interface AssetRights {
  license: string;
  distribution: "local_only" | "public";
  attribution?: string;
}

export interface RevisionAssetInput {
  rights?: AssetRights;
  logicalPath: string;
  role: RevisionAssetRole;
  visualRole?: VisualAssetRole;
  codeOrigin?: CodeAssetOrigin;
  mediaType?: string;
  language?: string;
  sourcePath?: string;
  bytes?: Uint8Array;
  text?: string;
  origin?: JsonValue;
}

export interface StoredRevisionAsset {
  rights?: AssetRights;
  logicalPath: string;
  file: string;
  role: RevisionAssetRole;
  visualRole?: VisualAssetRole;
  codeOrigin?: CodeAssetOrigin;
  mediaType: string;
  language?: string;
  bytes: number;
  sha256: string;
  origin?: JsonValue;
}

export interface CanonicalImplementationSelection {
  assetPath: string;
  selectedBy: "user";
}

export interface PlotExecutionValidationV1 {
  status: ExecutionStatus;
  scope: PlotExecutionScope;
  evidenceAssetPaths?: string[];
}

export interface UpstreamWorkflowValidationV1 {
  status: UpstreamWorkflowStatus;
  scope?: string;
  evidenceAssetPaths?: string[];
}

export interface ScientificValidationV1 {
  status: ScientificValidationStatus;
  decisionSource?: ScientificValidationDecisionSource;
  assessmentAssetPath?: string;
}

export interface ValidationStateV1 {
  schema: typeof VALIDATION_STATE_SCHEMA;
  plotExecution: PlotExecutionValidationV1;
  upstreamWorkflow: UpstreamWorkflowValidationV1;
  scientificValidation: ScientificValidationV1;
}

/**
 * Lifecycle adapters resolve public asset IDs to canonical logical paths before
 * passing this structure to the versioned-library core.
 */
export type ValidationStateInputV1 = ValidationStateV1;

export interface PrimaryPreviewOverride {
  confirmedBy: "user";
  reason: string;
}

export type CanonicalPreviewDecision =
  | {
      assetPath: string;
      reason: "default_uploaded_source" | "only_visual_available";
      selectedBy: "policy";
    }
  | {
      assetPath: string;
      reason: "user_selected_source";
      selectedBy: "user";
    }
  | {
      assetPath: string;
      reason: "user_override_rendered";
      selectedBy: "user";
      note: string;
    };

export interface FigureCodeLink {
  visualAssetPath: string;
  codeAssetPaths: string[];
  evidence: string;
  relationship: FigureCodeRelationship;
  confirmedBy: "user";
  confidence?: number;
}

export interface ConfirmedVisualGrouping {
  visualAssetPaths: string[];
  confirmedBy: "user";
  note?: string;
}

export interface IntakeRevisionBinding {
  adapterId: string;
  importId: string;
  sourceManifest: JsonValue;
  requiredAssetSha256: string[];
}

export type RuntimeInputRole = "example_data" | "source_data" | "private_reference";

export interface RuntimeClosureInputV1 {
  codePath: string;
  assetPath: string;
  required: true;
  role: RuntimeInputRole;
}

export interface RuntimeClosureV1 {
  schema: "figure-library.runtime-closure.v1";
  entrypoint: string;
  inputs: RuntimeClosureInputV1[];
  dependencies?: Array<{ codePath: string; assetPath: string }>;
  output: { previewPath: string; mediaType: "image/png" };
}

export interface VersionedTemplateCandidate {
  title: string;
  description?: string;
  tags?: string[];
  visualProfile?: string;
  dataProfile?: string;
  scientificQuestion?: string;
  application?: string;
  packages?: string[];
  license?: string;
  assetKind: VersionedAssetKind;
  language?: string;
  plotFamily?: string;
  codeStatus: VersionedCodeStatus;
  executionStatus?: ExecutionStatus;
  validationState?: ValidationStateInputV1;
  primaryPreview?: string;
  primaryPreviewOverride?: PrimaryPreviewOverride;
  canonicalImplementation?: CanonicalImplementationSelection;
  visualGrouping?: ConfirmedVisualGrouping;
  figureCodeLinks?: FigureCodeLink[];
  provenance?: JsonValue;
  annotations?: JsonValue;
  intakeBinding?: IntakeRevisionBinding;
  runtime?: RuntimeClosureV1;
  assets: RevisionAssetInput[];
}

export interface ValidationErrorInput {
  id?: string;
  code: string;
  message: string;
  path?: string;
  source?: Exclude<ReviewSource, "user">;
}

export interface BlockingGateInput {
  gateId: string;
  code: string;
  message: string;
  path?: string;
  source?: Exclude<ReviewSource, "system">;
}

export interface ReviewWarningInput {
  id?: string;
  code: string;
  message: string;
  path?: string;
  source?: ReviewSource;
}

export interface ReviewAssessmentInput {
  validationErrors?: ValidationErrorInput[];
  blockingGates?: BlockingGateInput[];
  warnings?: ReviewWarningInput[];
}

export interface ValidationErrorRecord {
  id: string;
  code: string;
  message: string;
  path?: string;
  source: Exclude<ReviewSource, "user">;
}

export interface GateResolution {
  decision: "resolved";
  decidedAt: string;
  note: string;
  source: "user";
}

export interface BlockingGateRecord {
  gateId: string;
  code: string;
  message: string;
  path?: string;
  source: Exclude<ReviewSource, "system">;
  status: "open" | "resolved";
  resolution?: GateResolution;
}

export interface ReviewWarningRecord {
  id: string;
  code: string;
  message: string;
  path?: string;
  source: ReviewSource;
}

export interface TemplateContentV1 {
  schema: typeof TEMPLATE_CONTENT_SCHEMA;
  templateId: string;
  revisionId: string;
  parentRevisionId?: string;
  restoredFromReleaseId?: string;
  createdAt: string;
  title: string;
  description: string;
  tags: string[];
  visualProfile: string;
  dataProfile: string;
  scientificQuestion?: string;
  application?: string;
  packages: string[];
  license: string;
  assetKind: VersionedAssetKind;
  language: string;
  plotFamily: string;
  codeStatus: VersionedCodeStatus;
  executionStatus: ExecutionStatus;
  validationState?: ValidationStateV1;
  primaryPreview?: string;
  canonicalPreviewDecision?: CanonicalPreviewDecision;
  canonicalImplementation?: CanonicalImplementationSelection;
  visualGrouping?: ConfirmedVisualGrouping;
  figureCodeLinks: FigureCodeLink[];
  provenance?: JsonValue;
  annotations?: JsonValue;
  intakeBinding?: IntakeRevisionBinding;
  runtime?: RuntimeClosureV1;
  assets: StoredRevisionAsset[];
  contentDigest: string;
}

export interface ReviewSnapshotV1 {
  schema: typeof REVIEW_SNAPSHOT_SCHEMA;
  templateId: string;
  reviewId: string;
  revisionId: string;
  previousReviewId?: string;
  createdAt: string;
  validationErrors: ValidationErrorRecord[];
  blockingGates: BlockingGateRecord[];
  warnings: ReviewWarningRecord[];
  reviewDigest: string;
}

export interface TemplateHead {
  revisionId: string;
  contentDigest: string;
}

export interface WorkingHead extends TemplateHead {
  reviewId: string;
  reviewDigest: string;
  baseReleaseId?: string;
  updatedAt: string;
}

export interface PublishedHead extends TemplateHead {
  releaseId: string;
  publishedAt: string;
}

export interface TemplateSeriesV1 {
  schema: typeof TEMPLATE_SERIES_SCHEMA;
  templateId: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
  publishedHead?: PublishedHead;
  workingHead?: WorkingHead;
}

export interface TemplateReleaseV1 {
  schema: typeof TEMPLATE_RELEASE_SCHEMA;
  templateId: string;
  releaseId: string;
  revisionId: string;
  contentDigest: string;
  reviewId: string;
  reviewDigest: string;
  publishedAt: string;
  previousReleaseId?: string;
  restoredFromReleaseId?: string;
  releaseDigest: string;
}

export interface ImportReceiptV1 {
  schema: typeof IMPORT_RECEIPT_SCHEMA;
  receiptId: string;
  adapterId: string;
  importId: string;
  sourceManifestDigest: string;
  templateId: string;
  revisionId: string;
  contentDigest: string;
  requiredAssetSha256: string[];
  assetInventory: Array<Pick<StoredRevisionAsset, "logicalPath" | "role" | "bytes" | "sha256">>;
  committedAt: string;
  selfContained: true;
}

export interface LegacyAdoptionReceiptV1 {
  schema: typeof LEGACY_ADOPTION_RECEIPT_SCHEMA;
  migrationId: string;
  templateId: string;
  legacySchema: "figure-library.template.v1";
  legacyManifestFile: "template.json";
  legacyManifestSha256: string;
  revisionId: string;
  contentDigest: string;
  releaseId?: string;
  adoptedAt: string;
  nonDestructive: true;
}

interface PreparedAssetSource {
  logicalPath: string;
  sourcePath?: string;
  bytesBase64?: string;
}

export type LifecyclePlanAction =
  | "create_working"
  | "update_working"
  | "update_gates"
  | "publish"
  | "discard_working"
  | "restore_release"
  | "adopt_legacy";

export type PublicLifecyclePlanKind =
  | "working"
  | "gate"
  | "publish"
  | "discard"
  | "restore"
  | "adopt";

export interface PublicLifecycleOperationBinding {
  kind: PublicLifecyclePlanKind;
  planDigest: string;
  expectedSeriesDigest: string | null;
}

export interface PublicLifecycleReplayInput {
  operationId: string;
  kind: PublicLifecyclePlanKind;
  planDigest: string;
  expectedTemplateId: string;
  expectedSeriesDigest: string | null;
  expectedAction?: LifecyclePlanAction;
}

interface PlanBase {
  schema: typeof LIFECYCLE_PLAN_SCHEMA;
  action: LifecyclePlanAction;
  templateId: string;
  expectedSeriesDigest: string | null;
  libraryContext?: LibraryOperationContext;
  createdAt: string;
  planDigest: string;
}

export interface WorkingRevisionPlan extends PlanBase {
  action: "create_working" | "update_working" | "restore_release";
  content: TemplateContentV1;
  review: ReviewSnapshotV1;
  assetSources: PreparedAssetSource[];
}

export interface GateDecision {
  gateId: string;
  decision: "resolved" | "reopen";
  note: string;
}

export interface GateUpdatePlan extends PlanBase {
  action: "update_gates";
  review: ReviewSnapshotV1;
}

export interface PublishPlan extends PlanBase {
  action: "publish";
  release: TemplateReleaseV1;
}

export interface DiscardWorkingPlan extends PlanBase {
  action: "discard_working";
  discardedRevisionId: string;
}

interface LegacyPreparedState {
  sourceRelativeDirectory: string;
  legacyManifestSha256: string;
  legacyReviewStatus: "draft" | "approved" | "archived";
  content: TemplateContentV1;
  review: ReviewSnapshotV1;
  release?: TemplateReleaseV1;
  assetSources: PreparedAssetSource[];
}

export interface LegacyAdoptionPlan extends PlanBase {
  action: "adopt_legacy";
  migrationId: string;
  legacy: LegacyPreparedState;
}

export type LifecyclePlan =
  | WorkingRevisionPlan
  | GateUpdatePlan
  | PublishPlan
  | DiscardWorkingPlan
  | LegacyAdoptionPlan;

export interface LifecycleApplyResult {
  operationId: string;
  action: LifecyclePlanAction;
  templateId: string;
  appliedAt: string;
  stateDigest: string;
  revisionId?: string;
  contentDigest?: string;
  reviewId?: string;
  releaseId?: string;
  importReceiptId?: string;
  migrationId?: string;
  idempotentReplay: boolean;
}

export interface LifecycleOperationReceiptV1 {
  schema: typeof LIFECYCLE_OPERATION_RECEIPT_SCHEMA;
  operationId: string;
  planDigest: string;
  action: LifecyclePlanAction;
  templateId: string;
  appliedAt: string;
  libraryContext?: LibraryOperationContext;
  publicPlan?: PublicLifecycleOperationBinding;
  result: Omit<LifecycleApplyResult, "idempotentReplay">;
}

export interface LifecycleOperationIntentV1 {
  schema: typeof LIFECYCLE_OPERATION_INTENT_SCHEMA;
  operationId: string;
  planDigest: string;
  action: LifecyclePlanAction;
  templateId: string;
  expectedSeriesDigest: string | null;
  libraryContext?: LibraryOperationContext;
  expectedSeries: TemplateSeriesV1 | null;
  preparedAt: string;
  publicPlan?: PublicLifecycleOperationBinding;
  nextSeries: TemplateSeriesV1;
  objects: {
    content?: TemplateHead;
    review?: { reviewId: string; reviewDigest: string; revisionId: string };
    release?: { releaseId: string; releaseDigest: string };
  };
  importReceipt?: ImportReceiptV1;
  adoptionReceipt?: LegacyAdoptionReceiptV1;
  result: Omit<LifecycleApplyResult, "idempotentReplay">;
  intentDigest: string;
}

export type LifecycleFaultPoint =
  | "after_intent_write"
  | "after_immutable_objects"
  | "after_series_write"
  | "after_auxiliary_receipts"
  | "before_operation_receipt";

export interface VersionedTemplateLibraryOptions {
  /** Test/host fault-injection hook. Production callers should omit this option. */
  faultInjector?: (
    point: LifecycleFaultPoint,
    context: { operationId: string; action: LifecyclePlanAction; templateId: string },
  ) => void | Promise<void>;
}

export interface RevisionDiff {
  templateId: string;
  fromRevisionId: string;
  toRevisionId: string;
  fieldChanges: Array<{ field: string; before: JsonValue; after: JsonValue }>;
  assets: {
    added: StoredRevisionAsset[];
    removed: StoredRevisionAsset[];
    changed: Array<{ logicalPath: string; before: StoredRevisionAsset; after: StoredRevisionAsset }>;
  };
}

export interface TemplateHistory {
  series: TemplateSeriesV1;
  revisions: Array<Pick<TemplateContentV1, "revisionId" | "parentRevisionId" | "restoredFromReleaseId" | "createdAt" | "contentDigest" | "title">>;
  releases: TemplateReleaseV1[];
}

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function jsonClone<T extends JsonValue>(value: T): T {
  return canonicalJsonClone(value);
}

function assertSafeSegment(value: string, label: string) {
  if (!SAFE_SEGMENT.test(value)) throw new Error(`unsafe ${label}: ${value}`);
  return assertPortableSegment(value, label);
}

function isSafeSegment(value: string) {
  try {
    assertSafeSegment(value, "path segment");
    return true;
  } catch {
    return false;
  }
}

export function validateRevisionAssetPath(value: string) {
  if (
    !value ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value)
  ) {
    throw new Error(`unsafe revision asset path: ${value}`);
  }
  const segments = value.split("/");
  if (
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        /[<>:"|?*]/u.test(segment) ||
        segment.endsWith(".") ||
        segment.endsWith(" "),
    )
  ) {
    throw new Error(`unsafe revision asset path: ${value}`);
  }
  for (const segment of segments) assertPortableFilesystemSegment(segment, "revision asset path segment");
  return segments.join("/");
}

export function legacyValidationStateFromExecutionStatus(
  executionStatus: ExecutionStatus,
  evidenceAssetPaths: string[] = [],
): ValidationStateV1 {
  if (!(["not_run", "passed", "failed"] as const).includes(executionStatus)) {
    throw new Error("invalid legacy executionStatus");
  }
  const normalizedEvidence = [...new Set(evidenceAssetPaths.map(validateRevisionAssetPath))].sort(
    compareCanonicalStrings,
  );
  return {
    schema: VALIDATION_STATE_SCHEMA,
    plotExecution: {
      status: executionStatus,
      scope: "unknown",
      ...(normalizedEvidence.length ? { evidenceAssetPaths: normalizedEvidence } : {}),
    },
    upstreamWorkflow: { status: "unknown" },
    scientificValidation: { status: "not_assessed" },
  };
}

export function effectiveValidationState(
  content: Pick<TemplateContentV1, "executionStatus" | "validationState" | "assets">,
): ValidationStateV1 {
  if (content.validationState) return canonicalJsonClone(content.validationState);
  return legacyValidationStateFromExecutionStatus(
    content.executionStatus,
    content.assets
      .filter((asset) => asset.role === "evidence")
      .map((asset) => asset.logicalPath),
  );
}

function resolveContained(root: string, relative: string) {
  const safe = validateRevisionAssetPath(relative);
  const resolved = path.resolve(root, ...safe.split("/"));
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (!resolved.startsWith(prefix)) throw new Error(`unsafe revision asset path: ${relative}`);
  return resolved;
}

function withoutDigest<T extends object, K extends keyof T>(value: T, field: K): Omit<T, K> {
  const copy = { ...value };
  delete (copy as Partial<T>)[field];
  return copy as Omit<T, K>;
}

function digestContent(content: Omit<TemplateContentV1, "contentDigest"> | TemplateContentV1) {
  return sha256(canonicalJson(withoutDigest(content as TemplateContentV1, "contentDigest")));
}

function digestReview(review: Omit<ReviewSnapshotV1, "reviewDigest"> | ReviewSnapshotV1) {
  return sha256(canonicalJson(withoutDigest(review as ReviewSnapshotV1, "reviewDigest")));
}

function digestRelease(release: Omit<TemplateReleaseV1, "releaseDigest"> | TemplateReleaseV1) {
  return sha256(canonicalJson(withoutDigest(release as TemplateReleaseV1, "releaseDigest")));
}

function digestOperationIntent(
  intent:
    | Omit<LifecycleOperationIntentV1, "intentDigest">
    | LifecycleOperationIntentV1,
) {
  return sha256(
    canonicalJson(
      withoutDigest(intent as LifecycleOperationIntentV1, "intentDigest"),
    ),
  );
}

export function templateSeriesDigest(series: TemplateSeriesV1) {
  return sha256(canonicalJson(series));
}

function issueId(prefix: string, issue: { code: string; message: string; path?: string }) {
  return `${prefix}-${sha256(canonicalJson(issue)).slice(0, 16)}`;
}

function uniqueStrings(values: string[] | undefined, label: string) {
  const result = [...(values ?? [])].map((item) => {
    if (typeof item !== "string") throw new Error(`${label} must contain strings`);
    return item.trim();
  });
  if (result.some((item) => !item)) throw new Error(`${label} must not contain empty values`);
  return [...new Set(result)];
}

function normalizedText(value: string | undefined) {
  return value?.trim() ?? "";
}

function nowIso() {
  return new Date().toISOString();
}

function generatedId(prefix: string) {
  return `${prefix}-${randomUUID()}`;
}

function inferredMediaType(logicalPath: string) {
  const extension = path.posix.extname(logicalPath).toLowerCase();
  return (
    {
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".webp": "image/webp",
      ".gif": "image/gif",
      ".svg": "image/svg+xml",
      ".pdf": "application/pdf",
      ".json": "application/json",
      ".md": "text/markdown",
      ".txt": "text/plain",
      ".r": "text/x-r",
      ".py": "text/x-python",
      ".jl": "text/x-julia",
      ".m": "text/x-matlab",
      ".csv": "text/csv",
      ".tsv": "text/tab-separated-values",
    }[extension] ?? "application/octet-stream"
  );
}

async function readAssetSource(input: RevisionAssetInput) {
  const provided = [input.sourcePath !== undefined, input.bytes !== undefined, input.text !== undefined].filter(
    Boolean,
  ).length;
  if (provided !== 1) {
    throw new Error(`asset ${input.logicalPath} must provide exactly one of sourcePath, bytes, or text`);
  }
  if (input.sourcePath !== undefined) {
    const absolute = path.resolve(input.sourcePath);
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`asset source is not a regular file: ${input.logicalPath}`);
    }
    if (stat.size > MAX_ASSET_BYTES) {
      throw new Error(`asset exceeds ${MAX_ASSET_BYTES} bytes: ${input.logicalPath}`);
    }
    const bytes = new Uint8Array(await fs.readFile(absolute));
    return { bytes, source: { logicalPath: input.logicalPath, sourcePath: absolute } };
  }
  const bytes = input.bytes ?? new TextEncoder().encode(input.text ?? "");
  if (bytes.byteLength > MAX_ASSET_BYTES) {
    throw new Error(`asset exceeds ${MAX_ASSET_BYTES} bytes: ${input.logicalPath}`);
  }
  const copy = new Uint8Array(bytes);
  return {
    bytes: copy,
    source: { logicalPath: input.logicalPath, bytesBase64: Buffer.from(copy).toString("base64") },
  };
}

async function bytesForPreparedSource(
  source: PreparedAssetSource,
  expected: StoredRevisionAsset,
) {
  let bytes: Uint8Array;
  if (source.sourcePath !== undefined && source.bytesBase64 === undefined) {
    const stat = await fs.lstat(source.sourcePath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`asset source is not a regular file: ${source.logicalPath}`);
    }
    bytes = new Uint8Array(await fs.readFile(source.sourcePath));
  } else if (source.bytesBase64 !== undefined && source.sourcePath === undefined) {
    bytes = new Uint8Array(Buffer.from(source.bytesBase64, "base64"));
  } else {
    throw new Error(`invalid prepared asset source: ${source.logicalPath}`);
  }
  if (bytes.byteLength !== expected.bytes || sha256(bytes) !== expected.sha256) {
    throw new Error(`asset changed after planning: ${source.logicalPath}`);
  }
  return bytes;
}

function normalizeValidationErrors(input: ValidationErrorInput[]) {
  return input.map((item) => {
    const code = normalizedText(item.code);
    const message = normalizedText(item.message);
    if (!code || !message) throw new Error("validation errors require code and message");
    const base = { code, message, ...(item.path ? { path: item.path } : {}) };
    return {
      id: item.id ? normalizedText(item.id) : issueId("validation", base),
      ...base,
      source: item.source ?? ("agent" as const),
    } satisfies ValidationErrorRecord;
  });
}

function normalizeBlockingGates(input: BlockingGateInput[]) {
  const gateIds = new Set<string>();
  return input.map((item) => {
    const gateId = normalizedText(item.gateId);
    const code = normalizedText(item.code);
    const message = normalizedText(item.message);
    if (!gateId || !code || !message) throw new Error("blocking gates require gateId, code, and message");
    if (gateIds.has(gateId)) throw new Error(`duplicate blocking gate: ${gateId}`);
    gateIds.add(gateId);
    return {
      gateId,
      code,
      message,
      ...(item.path ? { path: item.path } : {}),
      source: item.source ?? ("agent" as const),
      status: "open" as const,
    } satisfies BlockingGateRecord;
  });
}

function normalizeWarnings(input: ReviewWarningInput[]) {
  return input.map((item) => {
    const code = normalizedText(item.code);
    const message = normalizedText(item.message);
    if (!code || !message) throw new Error("review warnings require code and message");
    const base = { code, message, ...(item.path ? { path: item.path } : {}) };
    return {
      id: item.id ? normalizedText(item.id) : issueId("warning", base),
      ...base,
      source: item.source ?? ("agent" as const),
    } satisfies ReviewWarningRecord;
  });
}

function mergeUniqueBy<T>(items: T[], key: (item: T) => string) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function assertNoAbsoluteFilesystemPaths(value: JsonValue, label: string): JsonValue {
  const visit = (item: JsonValue, current: string): void => {
    if (typeof item === "string") {
      if (
        item.startsWith("file:") ||
        item.startsWith("\\\\") ||
        /^[A-Za-z]:[\\/]/u.test(item) ||
        (item.startsWith("/") && !item.startsWith("//"))
      ) {
        throw new Error(`${label} cannot persist an absolute filesystem path at ${current}`);
      }
      return;
    }
    if (Array.isArray(item)) {
      item.forEach((child, index) => visit(child, `${current}.${index}`));
      return;
    }
    if (item && typeof item === "object") {
      Object.entries(item).forEach(([key, child]) => visit(child, `${current}.${key}`));
    }
  };
  visit(value, label);
  return jsonClone(value);
}

function normalizeAssetRights(value: unknown): AssetRights | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.license !== "string" || !value.license.trim() || !["local_only", "public"].includes(String(value.distribution)) || (value.attribution !== undefined && typeof value.attribution !== "string")) throw new Error("invalid asset rights");
  return { license: value.license.trim(), distribution: value.distribution as AssetRights["distribution"], ...(value.attribution ? {attribution: value.attribution as string} : {}) };
}

function normalizeRuntimeClosure(
  value: unknown,
  assetsByPath: Map<string, StoredRevisionAsset>,
  canonicalPath?: string,
  primaryPreview?: string,
): RuntimeClosureV1 | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || value.schema !== "figure-library.runtime-closure.v1") {
    throw new Error("invalid runtime closure schema");
  }
  if (typeof value.entrypoint !== "string" || !value.entrypoint.trim()) throw new Error("runtime.entrypoint is required");
  const entrypoint = validateRevisionAssetPath(value.entrypoint);
  if (assetsByPath.get(entrypoint)?.role !== "code") throw new Error("runtime.entrypoint must reference code");
  if (canonicalPath && entrypoint !== canonicalPath) throw new Error("runtime.entrypoint must equal canonicalImplementation.assetPath");
  if (!Array.isArray(value.inputs)) throw new Error("runtime.inputs must be an array");
  const seen = new Set<string>();
  const inputs = value.inputs.map((raw, index) => {
    if (!isRecord(raw) || typeof raw.codePath !== "string" || typeof raw.assetPath !== "string" || raw.required !== true ||
        !["example_data", "source_data", "private_reference"].includes(String(raw.role))) {
      throw new Error(`invalid runtime input at index ${index}`);
    }
    const codePath = runtimePath(raw.codePath);
    const assetPath = validateRevisionAssetPath(raw.assetPath);
    const key = `${codePath}\u0000${assetPath}`;
    if (seen.has(key)) throw new Error(`duplicate runtime input: ${codePath}`);
    seen.add(key);
    if (assetsByPath.get(assetPath)?.role !== "reference") throw new Error(`runtime input must reference a reference asset: ${assetPath}`);
    return { codePath, assetPath, required: true as const, role: raw.role as RuntimeInputRole };
  });
  const dependencies = value.dependencies === undefined ? [] : value.dependencies;
  if (!Array.isArray(dependencies)) throw new Error("invalid runtime dependencies");
  const codeDependencies = dependencies.map(raw => {
    if (!isRecord(raw) || typeof raw.codePath !== "string" || typeof raw.assetPath !== "string" || assetsByPath.get(raw.assetPath)?.role !== "code") throw new Error("runtime dependency must reference code");
    return {codePath: runtimePath(raw.codePath), assetPath: validateRevisionAssetPath(raw.assetPath)};
  });
  assertUniqueRuntimePaths(["code/organized.R", "preview.png", ...inputs.map(i=>i.codePath), ...codeDependencies.map(i=>i.codePath)]);
  if (!isRecord(value.output) || value.output.mediaType !== "image/png" || typeof value.output.previewPath !== "string") {
    throw new Error("runtime.output must declare a PNG previewPath");
  }
  const previewPath = validateRevisionAssetPath(value.output.previewPath);
  if (primaryPreview && previewPath !== primaryPreview) throw new Error("runtime.output.previewPath must equal primaryPreview");
  if (assetsByPath.get(previewPath)?.role !== "visual") throw new Error("runtime.output.previewPath must reference a visual asset");
  return { schema: "figure-library.runtime-closure.v1", entrypoint, inputs: inputs.sort((a,b)=>compareCanonicalStrings(a.codePath,b.codePath)), ...(codeDependencies.length ? {dependencies: codeDependencies.sort((a,b)=>compareCanonicalStrings(a.codePath,b.codePath))} : {}), output: { previewPath, mediaType: "image/png" } };
}

function assertCanonicalAssetPath(
  logicalPath: string,
  role: RevisionAssetRole,
  visualRole?: VisualAssetRole,
) {
  const normalized = validateRevisionAssetPath(logicalPath);
  const requiredPrefix =
    role === "visual"
      ? visualRole === "source_reference"
        ? "visuals/source/"
        : visualRole === "rendered_output"
          ? "visuals/rendered/"
          : ""
      : role === "code"
        ? "code/"
        : role === "reference"
          ? "references/"
          : "evidence/";
  if (!requiredPrefix || !normalized.startsWith(requiredPrefix) || normalized === requiredPrefix) {
    throw new Error(
      `asset ${normalized} must use the canonical ${requiredPrefix || "visual role"} path`,
    );
  }
  return normalized;
}


function normalizeValidationState(
  value: ValidationStateInputV1 | undefined,
  fallbackStatus: ExecutionStatus,
  fallbackEvidenceAssetPaths: string[],
): ValidationStateV1 {
  if (value === undefined) {
    return legacyValidationStateFromExecutionStatus(fallbackStatus, fallbackEvidenceAssetPaths);
  }
  if (!isRecord(value) || value.schema !== VALIDATION_STATE_SCHEMA) {
    throw new Error("invalid validation state schema");
  }
  if (!isRecord(value.plotExecution)) throw new Error("invalid plotExecution validation state");
  if (!(["not_run", "passed", "failed"] as const).includes(value.plotExecution.status as ExecutionStatus)) {
    throw new Error("invalid plotExecution status");
  }
  if (!(["synthetic_data", "example_data", "real_data", "unknown"] as const).includes(
    value.plotExecution.scope as PlotExecutionScope,
  )) {
    throw new Error("invalid plotExecution scope");
  }
  if (!isRecord(value.upstreamWorkflow)) throw new Error("invalid upstreamWorkflow validation state");
  if (!(["unknown", "not_run", "partial", "passed", "failed", "not_applicable"] as const).includes(
    value.upstreamWorkflow.status as UpstreamWorkflowStatus,
  )) {
    throw new Error("invalid upstreamWorkflow status");
  }
  if (!isRecord(value.scientificValidation)) {
    throw new Error("invalid scientificValidation state");
  }
  if (!(["not_assessed", "limited", "validated", "rejected", "not_applicable"] as const).includes(
    value.scientificValidation.status as ScientificValidationStatus,
  )) {
    throw new Error("invalid scientificValidation status");
  }
  const normalizePaths = (paths: unknown, label: string) => {
    if (paths === undefined) return [] as string[];
    if (!Array.isArray(paths)) throw new Error(`${label} must be an array`);
    return uniqueStrings(paths as string[], label)
      .map(validateRevisionAssetPath)
      .sort(compareCanonicalStrings);
  };
  const plotEvidence = normalizePaths(
    value.plotExecution.evidenceAssetPaths,
    "plotExecution.evidenceAssetPaths",
  );
  const upstreamEvidence = normalizePaths(
    value.upstreamWorkflow.evidenceAssetPaths,
    "upstreamWorkflow.evidenceAssetPaths",
  );
  if (
    value.upstreamWorkflow.scope !== undefined &&
    typeof value.upstreamWorkflow.scope !== "string"
  ) {
    throw new Error("invalid upstreamWorkflow scope");
  }
  const upstreamScope = normalizedText(value.upstreamWorkflow.scope);
  const decisionSource = value.scientificValidation.decisionSource;
  if (
    decisionSource !== undefined &&
    decisionSource !== "user" &&
    decisionSource !== "external_review"
  ) {
    throw new Error("invalid scientificValidation decisionSource");
  }
  const assessmentAssetPath = value.scientificValidation.assessmentAssetPath;
  if (assessmentAssetPath !== undefined && typeof assessmentAssetPath !== "string") {
    throw new Error("invalid scientificValidation assessmentAssetPath");
  }
  return {
    schema: VALIDATION_STATE_SCHEMA,
    plotExecution: {
      status: value.plotExecution.status as ExecutionStatus,
      scope: value.plotExecution.scope as PlotExecutionScope,
      ...(plotEvidence.length ? { evidenceAssetPaths: plotEvidence } : {}),
    },
    upstreamWorkflow: {
      status: value.upstreamWorkflow.status as UpstreamWorkflowStatus,
      ...(upstreamScope ? { scope: upstreamScope } : {}),
      ...(upstreamEvidence.length ? { evidenceAssetPaths: upstreamEvidence } : {}),
    },
    scientificValidation: {
      status: value.scientificValidation.status as ScientificValidationStatus,
      ...(decisionSource ? { decisionSource } : {}),
      ...(assessmentAssetPath
        ? { assessmentAssetPath: validateRevisionAssetPath(assessmentAssetPath) }
        : {}),
    },
  };
}

interface CanonicalPreviewResolution {
  primaryPreview?: string;
  canonicalPreviewDecision?: CanonicalPreviewDecision;
  error?: { code: "canonical_preview_ambiguous" | "canonical_preview_override_required"; message: string };
}

function resolveCanonicalPreview(
  visualAssets: StoredRevisionAsset[],
  requestedPath: string | undefined,
  override: PrimaryPreviewOverride | undefined,
): CanonicalPreviewResolution {
  if (
    override &&
    (override.confirmedBy !== "user" ||
      typeof override.reason !== "string" ||
      !normalizedText(override.reason))
  ) {
    throw new Error("primaryPreviewOverride requires explicit user confirmation and a reason");
  }
  const requested = requestedPath ? validateRevisionAssetPath(requestedPath) : undefined;
  const sources = visualAssets.filter((asset) => asset.visualRole === "source_reference");
  if (!requested) {
    if (sources.length === 1) {
      return {
        primaryPreview: sources[0]!.logicalPath,
        canonicalPreviewDecision: {
          assetPath: sources[0]!.logicalPath,
          reason: "default_uploaded_source",
          selectedBy: "policy",
        },
      };
    }
    if (visualAssets.length === 1) {
      return {
        primaryPreview: visualAssets[0]!.logicalPath,
        canonicalPreviewDecision: {
          assetPath: visualAssets[0]!.logicalPath,
          reason: "only_visual_available",
          selectedBy: "policy",
        },
      };
    }
    if (visualAssets.length > 1) {
      return {
        error: {
          code: "canonical_preview_ambiguous",
          message: "Multiple eligible visuals require an explicit canonical preview selection",
        },
      };
    }
    return {};
  }
  const selected = visualAssets.find((asset) => asset.logicalPath === requested);
  if (!selected) return { primaryPreview: requested };
  if (selected.visualRole === "source_reference") {
    return {
      primaryPreview: requested,
      canonicalPreviewDecision: {
        assetPath: requested,
        reason: "user_selected_source",
        selectedBy: "user",
      },
    };
  }
  if (visualAssets.length === 1) {
    return {
      primaryPreview: requested,
      canonicalPreviewDecision: {
        assetPath: requested,
        reason: "only_visual_available",
        selectedBy: "policy",
      },
    };
  }
  if (override) {
    return {
      primaryPreview: requested,
      canonicalPreviewDecision: {
        assetPath: requested,
        reason: "user_override_rendered",
        selectedBy: "user",
        note: normalizedText(override.reason),
      },
    };
  }
  return {
    primaryPreview: requested,
    error: {
      code: "canonical_preview_override_required",
      message: "Selecting a rendered output over other eligible visuals requires a user-confirmed reason",
    },
  };
}

interface PreparedCandidate {
  content: TemplateContentV1;
  review: ReviewSnapshotV1;
  sources: PreparedAssetSource[];
}

async function prepareCandidate(options: {
  templateId: string;
  revisionId: string;
  reviewId: string;
  createdAt: string;
  parentRevisionId?: string;
  restoredFromReleaseId?: string;
  previousReviewId?: string;
  candidate: VersionedTemplateCandidate;
  assessment?: ReviewAssessmentInput;
}): Promise<PreparedCandidate> {
  const { candidate } = options;
  if (candidate.application !== undefined && (typeof candidate.application !== "string" || candidate.application.length > 8_000)) {
    throw new Error("invalid candidate application (maximum 8000 characters)");
  }
  const title = normalizedText(candidate.title);
  if (!title) throw new Error("template title is required");
  if (candidate.assetKind !== "plot_template" && candidate.assetKind !== "visual_reference") {
    throw new Error("invalid candidate assetKind");
  }
  if (!["none", "scaffold", "reviewed"].includes(candidate.codeStatus)) {
    throw new Error("invalid candidate codeStatus");
  }
  if (candidate.executionStatus && !["not_run", "passed", "failed"].includes(candidate.executionStatus)) {
    throw new Error("invalid candidate executionStatus");
  }
  if (!Array.isArray(candidate.assets) || !candidate.assets.length) {
    throw new Error("a complete candidate snapshot requires assets");
  }

  const logicalPaths = new Set<string>();
  const caseFoldedPaths = new Set<string>();
  const storedAssets: StoredRevisionAsset[] = [];
  const sources: PreparedAssetSource[] = [];
  const codeTexts = new Map<string,string>();
  let totalBytes = 0;
  for (const input of candidate.assets) {
    if (!["visual", "code", "reference", "evidence"].includes(input.role)) {
      throw new Error(`invalid revision asset role: ${String(input.role)}`);
    }
    if (
      (input.role === "visual" &&
        input.visualRole !== "source_reference" &&
        input.visualRole !== "rendered_output") ||
      (input.role !== "visual" && input.visualRole !== undefined)
    ) {
      throw new Error(`asset ${input.logicalPath} has an invalid visualRole`);
    }
    if (
      (input.role === "code" &&
        !["user_supplied", "author_provided", "agent_generated", "adapted"].includes(
          input.codeOrigin ?? "",
        )) ||
      (input.role !== "code" && input.codeOrigin !== undefined)
    ) {
      throw new Error(`asset ${input.logicalPath} has an invalid or missing codeOrigin`);
    }
    const logicalPath = assertCanonicalAssetPath(
      input.logicalPath,
      input.role,
      input.visualRole,
    );
    const folded = portableCaseFold(logicalPath);
    if (logicalPaths.has(logicalPath) || caseFoldedPaths.has(folded)) {
      throw new Error(`duplicate revision asset path: ${logicalPath}`);
    }
    logicalPaths.add(logicalPath);
    caseFoldedPaths.add(folded);
    const { bytes, source } = await readAssetSource({ ...input, logicalPath });
    if (input.role === "code") codeTexts.set(logicalPath, new TextDecoder().decode(bytes));
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_REVISION_BYTES) {
      throw new Error(`candidate assets exceed ${MAX_REVISION_BYTES} bytes`);
    }
    storedAssets.push({
      logicalPath,
      ...(input.rights ? {rights: normalizeAssetRights(input.rights)} : {}),
      file: `assets/${logicalPath}`,
      role: input.role,
      ...(input.visualRole ? { visualRole: input.visualRole } : {}),
      ...(input.codeOrigin ? { codeOrigin: input.codeOrigin } : {}),
      mediaType: normalizedText(input.mediaType) || inferredMediaType(logicalPath),
      ...(input.language ? { language: normalizedText(input.language) } : {}),
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
      ...(input.origin !== undefined
        ? { origin: assertNoAbsoluteFilesystemPaths(input.origin, `assets.${logicalPath}.origin`) }
        : {}),
    });
    sources.push({ ...source, logicalPath });
  }
  storedAssets.sort((left, right) => compareCanonicalStrings(left.logicalPath, right.logicalPath));
  sources.sort((left, right) => compareCanonicalStrings(left.logicalPath, right.logicalPath));

  const assetsByPath = new Map(storedAssets.map((asset) => [asset.logicalPath, asset]));
  const visualAssets = storedAssets.filter((asset) => asset.role === "visual");
  const codeAssets = storedAssets.filter((asset) => asset.role === "code");
  const evidenceAssetPaths = storedAssets
    .filter((asset) => asset.role === "evidence")
    .map((asset) => asset.logicalPath);
  const candidateValidationStatus =
    isRecord(candidate.validationState) &&
    isRecord(candidate.validationState.plotExecution) &&
    (["not_run", "passed", "failed"] as const).includes(
      candidate.validationState.plotExecution.status as ExecutionStatus,
    )
      ? (candidate.validationState.plotExecution.status as ExecutionStatus)
      : undefined;
  const fallbackExecutionStatus =
    candidate.executionStatus ?? candidateValidationStatus ?? "not_run";
  const validationState = normalizeValidationState(
    candidate.validationState,
    fallbackExecutionStatus,
    evidenceAssetPaths,
  );
  const executionStatus = validationState.plotExecution.status;
  const executionStatusConflict =
    candidate.executionStatus !== undefined &&
    candidate.executionStatus !== validationState.plotExecution.status;
  const previewResolution = resolveCanonicalPreview(
    visualAssets,
    candidate.primaryPreview,
    candidate.primaryPreviewOverride,
  );
  const { primaryPreview, canonicalPreviewDecision } = previewResolution;
  const canonicalImplementation = candidate.canonicalImplementation
    ? {
        assetPath: validateRevisionAssetPath(candidate.canonicalImplementation.assetPath),
        selectedBy: candidate.canonicalImplementation.selectedBy,
      }
    : undefined;
  if (canonicalImplementation && canonicalImplementation.selectedBy !== "user") {
    throw new Error("canonical implementation must be explicitly selected by the user");
  }
  const runtime = normalizeRuntimeClosure(
    candidate.runtime ?? (candidate.assetKind === "plot_template" && canonicalImplementation && primaryPreview && !inspectRuntimeReads(codeTexts.get(canonicalImplementation.assetPath) ?? "").length ? {
      schema: "figure-library.runtime-closure.v1", entrypoint: canonicalImplementation.assetPath, inputs: [], output: {previewPath:primaryPreview, mediaType:"image/png"}
    } : undefined),
    assetsByPath,
    canonicalImplementation?.assetPath,
    primaryPreview,
  );

  const figureCodeLinks = (candidate.figureCodeLinks ?? []).map((link) => ({
    visualAssetPath: validateRevisionAssetPath(link.visualAssetPath),
    codeAssetPaths: uniqueStrings(link.codeAssetPaths, "figureCodeLinks.codeAssetPaths").map(
      validateRevisionAssetPath,
    ),
    evidence: normalizedText(link.evidence),
    relationship: link.relationship,
    confirmedBy: link.confirmedBy,
    ...(link.confidence !== undefined ? { confidence: link.confidence } : {}),
  }));
  const relationships: FigureCodeRelationship[] = [
    "user_supplied_pair",
    "visual_inference",
    "adapted_from_template",
    "generated_output",
    "author_provided_original",
  ];
  if (
    figureCodeLinks.some(
      (link) =>
        !link.evidence ||
        !link.codeAssetPaths.length ||
        !relationships.includes(link.relationship) ||
        link.confirmedBy !== "user",
    )
  ) {
    throw new Error(
      "figure-code links require a relationship, evidence, code assets, and explicit user confirmation",
    );
  }
  if (
    figureCodeLinks.some(
      (link) =>
        link.confidence !== undefined &&
        (!Number.isFinite(link.confidence) || link.confidence < 0 || link.confidence > 1),
    )
  ) {
    throw new Error("figure-code link confidence must be between 0 and 1");
  }

  const visualGrouping = candidate.visualGrouping
    ? {
        visualAssetPaths: uniqueStrings(
          candidate.visualGrouping.visualAssetPaths,
          "visualGrouping.visualAssetPaths",
        ).map(validateRevisionAssetPath),
        confirmedBy: candidate.visualGrouping.confirmedBy,
        ...(candidate.visualGrouping.note
          ? { note: normalizedText(candidate.visualGrouping.note) }
          : {}),
      }
    : undefined;
  if (!visualGrouping || visualGrouping.confirmedBy !== "user") {
    throw new Error("Figure Unit grouping must be explicitly confirmed by the user");
  }

  const intakeBinding = candidate.intakeBinding
    ? {
        adapterId: assertSafeSegment(candidate.intakeBinding.adapterId, "adapterId"),
        importId: assertSafeSegment(candidate.intakeBinding.importId, "importId"),
        sourceManifest: assertNoAbsoluteFilesystemPaths(
          candidate.intakeBinding.sourceManifest,
          "intakeBinding.sourceManifest",
        ),
        requiredAssetSha256: uniqueStrings(
          candidate.intakeBinding.requiredAssetSha256,
          "intakeBinding.requiredAssetSha256",
        ).sort(),
      }
    : undefined;
  if (intakeBinding) {
    if (!intakeBinding.requiredAssetSha256.length) {
      throw new Error("intake binding requires at least one materialized asset digest");
    }
    if (intakeBinding.requiredAssetSha256.some((digest) => !HASH.test(digest))) {
      throw new Error("intake binding contains an invalid SHA-256 digest");
    }
    const inventory = new Set(storedAssets.map((asset) => asset.sha256));
    if (intakeBinding.requiredAssetSha256.some((digest) => !inventory.has(digest))) {
      throw new Error("intake binding is not self-contained in the candidate asset inventory");
    }
  }

  const contentWithoutDigest: Omit<TemplateContentV1, "contentDigest"> = {
    schema: TEMPLATE_CONTENT_SCHEMA,
    templateId: options.templateId,
    revisionId: options.revisionId,
    ...(options.parentRevisionId ? { parentRevisionId: options.parentRevisionId } : {}),
    ...(options.restoredFromReleaseId
      ? { restoredFromReleaseId: options.restoredFromReleaseId }
      : {}),
    createdAt: options.createdAt,
    title,
    description: normalizedText(candidate.description),
    tags: uniqueStrings(candidate.tags, "tags"),
    visualProfile: normalizedText(candidate.visualProfile),
    dataProfile: normalizedText(candidate.dataProfile),
    ...(normalizedText(candidate.application) ? { application: normalizedText(candidate.application) } : {}),
    ...(normalizedText(candidate.scientificQuestion)
      ? { scientificQuestion: normalizedText(candidate.scientificQuestion) }
      : {}),
    packages: uniqueStrings(candidate.packages, "packages"),
    license: normalizedText(candidate.license) || "unspecified",
    assetKind: candidate.assetKind,
    language: normalizedText(candidate.language) || "none",
    plotFamily: normalizedText(candidate.plotFamily),
    codeStatus: candidate.codeStatus,
    executionStatus,
    validationState,
    ...(primaryPreview ? { primaryPreview } : {}),
    ...(canonicalPreviewDecision ? { canonicalPreviewDecision } : {}),
    ...(canonicalImplementation ? { canonicalImplementation } : {}),
    ...(visualGrouping ? { visualGrouping } : {}),
    figureCodeLinks,
    ...(candidate.provenance !== undefined
      ? { provenance: assertNoAbsoluteFilesystemPaths(candidate.provenance, "provenance") }
      : {}),
    ...(candidate.annotations !== undefined
      ? { annotations: assertNoAbsoluteFilesystemPaths(candidate.annotations, "annotations") }
      : {}),
    ...(intakeBinding ? { intakeBinding } : {}),
    ...(runtime ? { runtime } : {}),
    assets: storedAssets,
  };
  const content: TemplateContentV1 = {
    ...contentWithoutDigest,
    contentDigest: digestContent(contentWithoutDigest),
  };

  const domainErrors: ValidationErrorRecord[] = [];
  const domainGates: BlockingGateRecord[] = [];
  const domainWarnings: ReviewWarningRecord[] = [];
  const addError = (code: string, message: string, fieldPath?: string) => {
    const base = { code, message, ...(fieldPath ? { path: fieldPath } : {}) };
    domainErrors.push({ id: issueId("validation", base), ...base, source: "system" });
  };
  const addGate = (gateId: string, code: string, message: string, fieldPath?: string) => {
    domainGates.push({
      gateId,
      code,
      message,
      ...(fieldPath ? { path: fieldPath } : {}),
      source: "rule",
      status: "open",
    });
  };
  const addWarning = (code: string, message: string, fieldPath?: string) => {
    const base = { code, message, ...(fieldPath ? { path: fieldPath } : {}) };
    domainWarnings.push({ id: issueId("warning", base), ...base, source: "rule" });
  };

  if (candidate.assetKind === "plot_template") {
    if (!runtime) addWarning("runtime_closure_missing", "This legacy revision has no runtime closure; public export requires an explicit closure", "runtime");
    else {
      try {
        const paths = [...runtime.inputs.map(i=>i.codePath), ...(runtime.dependencies ?? []).map(i=>i.codePath)];
        for (const codePath of [runtime.entrypoint,...(runtime.dependencies ?? []).map(i=>i.assetPath)]) assertRuntimeReads(codeTexts.get(codePath) ?? "", paths, codePath);
      } catch (e) { addError("runtime_input_incomplete", (e as Error).message, "runtime"); }
    }
  }
  if (executionStatusConflict) {
    addError(
      "execution_status_conflicts_with_validation_state",
      "executionStatus must match validationState.plotExecution.status",
      "executionStatus",
    );
  }
  if (previewResolution.error) {
    addError(previewResolution.error.code, previewResolution.error.message, "primaryPreview");
  }
  const plotEvidencePaths = validationState.plotExecution.evidenceAssetPaths ?? [];
  if (plotEvidencePaths.some((assetPath) => assetsByPath.get(assetPath)?.role !== "evidence")) {
    addError(
      "invalid_plot_execution_evidence",
      "Plot execution evidence must reference stored evidence assets",
      "validationState.plotExecution.evidenceAssetPaths",
    );
  }
  if (
    validationState.plotExecution.status === "passed" &&
    !plotEvidencePaths.length
  ) {
    addError(
      "passed_execution_requires_evidence",
      "A passed plot execution requires at least one evidence asset",
      "validationState.plotExecution.evidenceAssetPaths",
    );
  }
  const upstreamEvidencePaths = validationState.upstreamWorkflow.evidenceAssetPaths ?? [];
  if (upstreamEvidencePaths.some((assetPath) => assetsByPath.get(assetPath)?.role !== "evidence")) {
    addError(
      "invalid_upstream_workflow_evidence",
      "Upstream workflow evidence must reference stored evidence assets",
      "validationState.upstreamWorkflow.evidenceAssetPaths",
    );
  }
  if (["partial", "passed", "failed"].includes(validationState.upstreamWorkflow.status)) {
    if (!validationState.upstreamWorkflow.scope) {
      addError(
        "upstream_workflow_scope_required",
        "A partial, passed, or failed upstream workflow requires a non-empty scope",
        "validationState.upstreamWorkflow.scope",
      );
    }
    if (!upstreamEvidencePaths.length) {
      addError(
        "upstream_workflow_evidence_required",
        "A partial, passed, or failed upstream workflow requires evidence",
        "validationState.upstreamWorkflow.evidenceAssetPaths",
      );
    }
  }
  if (["limited", "validated", "rejected"].includes(validationState.scientificValidation.status)) {
    if (!validationState.scientificValidation.decisionSource) {
      addError(
        "scientific_validation_decision_source_required",
        "A scientific validation assessment requires a user or external-review decision source",
        "validationState.scientificValidation.decisionSource",
      );
    }
    const assessmentPath = validationState.scientificValidation.assessmentAssetPath;
    const assessmentRole = assessmentPath ? assetsByPath.get(assessmentPath)?.role : undefined;
    if (!assessmentPath || (assessmentRole !== "reference" && assessmentRole !== "evidence")) {
      addError(
        "scientific_validation_assessment_required",
        "A scientific validation assessment requires a stored reference or evidence asset",
        "validationState.scientificValidation.assessmentAssetPath",
      );
    }
  }
  if (!visualAssets.length) addError("missing_visual_asset", "A Figure Unit requires a visual asset", "assets");
  if (!primaryPreview && !previewResolution.error) {
    addError("primary_preview_required", "A primary preview must be selected", "primaryPreview");
  } else if (primaryPreview && assetsByPath.get(primaryPreview)?.role !== "visual") {
    addError("invalid_primary_preview", "The primary preview must reference a visual asset", "primaryPreview");
  }
  if (candidate.assetKind === "plot_template") {
    if (!codeAssets.length) addError("missing_code_asset", "A plot template requires code", "assets");
    if (candidate.codeStatus === "none") {
      addError("invalid_code_status", "A plot template cannot have codeStatus none", "codeStatus");
    }
    if (!canonicalImplementation) {
      addError(
        "canonical_implementation_required",
        "The user must explicitly select a canonical implementation",
        "canonicalImplementation",
      );
    } else if (assetsByPath.get(canonicalImplementation.assetPath)?.role !== "code") {
      addError(
        "invalid_canonical_implementation",
        "The canonical implementation must reference a code asset",
        "canonicalImplementation.assetPath",
      );
    } else if (
      !figureCodeLinks.some((link) =>
        link.codeAssetPaths.includes(canonicalImplementation.assetPath),
      )
    ) {
      addError(
        "canonical_implementation_evidence_required",
        "The canonical implementation must participate in an evidence-backed Figure/code link",
        "canonicalImplementation.assetPath",
      );
    }
  } else if (canonicalImplementation) {
    addError(
      "visual_reference_has_canonical_code",
      "A visual reference cannot declare canonical executable code",
      "canonicalImplementation",
    );
  }
  if (candidate.assetKind === "visual_reference" && codeAssets.length) {
    addError(
      "visual_reference_has_code",
      "A visual_reference cannot include executable code; use plot_template for code-backed units",
      "assets",
    );
  }
  const grouped = new Set(visualGrouping?.visualAssetPaths ?? []);
  const visualPaths = new Set(visualAssets.map((asset) => asset.logicalPath));
  if (
    grouped.size !== visualPaths.size ||
    [...grouped].some((assetPath) => !visualPaths.has(assetPath))
  ) {
    addError(
      "figure_unit_grouping_incomplete",
      "The user-confirmed Figure Unit grouping must contain exactly all visual assets",
      "visualGrouping",
    );
  }
  for (const [index, link] of figureCodeLinks.entries()) {
    if (assetsByPath.get(link.visualAssetPath)?.role !== "visual") {
      addError(
        "invalid_figure_code_visual",
        "Figure-code evidence must reference a visual asset",
        `figureCodeLinks.${index}.visualAssetPath`,
      );
    }
    if (link.codeAssetPaths.some((assetPath) => assetsByPath.get(assetPath)?.role !== "code")) {
      addError(
        "invalid_figure_code_code",
        "Figure-code evidence must reference code assets",
        `figureCodeLinks.${index}.codeAssetPaths`,
      );
    }
    const linkedVisual = assetsByPath.get(link.visualAssetPath);
    if (link.relationship === "generated_output" && linkedVisual?.visualRole !== "rendered_output") {
      addError(
        "generated_output_requires_rendered_visual",
        "A generated_output relationship must target a rendered_output visual",
        `figureCodeLinks.${index}.relationship`,
      );
    }
    if (link.relationship === "visual_inference" && linkedVisual?.visualRole !== "source_reference") {
      addError(
        "visual_inference_requires_source_reference",
        "A visual_inference relationship must target a source_reference visual",
        `figureCodeLinks.${index}.relationship`,
      );
    }
    if (link.relationship === "visual_inference") {
      if (candidate.codeStatus !== "scaffold" || content.executionStatus !== "not_run") {
        addError(
          "visual_inference_must_be_unrun_scaffold",
          "Code inferred from a source visual must remain scaffold/not_run",
          `figureCodeLinks.${index}.relationship`,
        );
      }
      if (
        link.codeAssetPaths.some(
          (assetPath) => assetsByPath.get(assetPath)?.codeOrigin !== "agent_generated",
        )
      ) {
        addError(
          "visual_inference_requires_agent_generated_origin",
          "Code linked by visual_inference must declare codeOrigin agent_generated",
          `figureCodeLinks.${index}.codeAssetPaths`,
        );
      }
      addWarning(
        "inspired_by_not_reproduced",
        "The scaffold was inferred from a visual reference and has not been run or reproduced",
        `figureCodeLinks.${index}`,
      );
    }
  }
  if (candidate.assetKind === "plot_template" && visualAssets.length && codeAssets.length) {
    const linkedVisuals = new Set(figureCodeLinks.map((link) => link.visualAssetPath));
    const linkedCode = new Set(figureCodeLinks.flatMap((link) => link.codeAssetPaths));
    if (codeAssets.some((asset) => !linkedCode.has(asset.logicalPath))) {
      addError(
        "unlinked_code_asset",
        "Every selected code asset must participate in an evidence-backed Figure/code relationship",
        "figureCodeLinks",
      );
    }
    if (
      visualAssets.some((asset) => !linkedVisuals.has(asset.logicalPath)) ||
      codeAssets.some((asset) => !linkedCode.has(asset.logicalPath))
    ) {
      addGate(
        "review-figure-code-pairing",
        "figure_code_pairing_review_required",
        "Every visual and code asset must participate in an evidence-backed Figure/code relationship",
        "figureCodeLinks",
      );
    }
  }
  if (candidate.codeStatus === "scaffold" && content.executionStatus !== "not_run") {
    addError(
      "scaffold_must_be_not_run",
      "Scaffold code cannot claim a passed or failed execution",
      "executionStatus",
    );
  }
  if (
    content.executionStatus === "passed" &&
    !visualAssets.some((asset) => asset.visualRole === "rendered_output")
  ) {
    addError(
      "passed_execution_requires_rendered_output",
      "A passed execution requires a rendered_output visual",
      "validationState.plotExecution.status",
    );
  }
  if (
    content.executionStatus === "passed" &&
    !figureCodeLinks.some((link) => link.relationship === "generated_output")
  ) {
    addError(
      "passed_execution_requires_generated_output",
      "A passed execution requires an evidence-backed generated_output relationship",
      "executionStatus",
    );
  }

  const validationErrors = mergeUniqueBy(
    [...domainErrors, ...normalizeValidationErrors(options.assessment?.validationErrors ?? [])],
    (item) => item.id,
  );
  const blockingGates = mergeUniqueBy(
    [...domainGates, ...normalizeBlockingGates(options.assessment?.blockingGates ?? [])],
    (item) => item.gateId,
  );
  const warnings = mergeUniqueBy(
    [...domainWarnings, ...normalizeWarnings(options.assessment?.warnings ?? [])],
    (item) => item.id,
  );
  const reviewWithoutDigest: Omit<ReviewSnapshotV1, "reviewDigest"> = {
    schema: REVIEW_SNAPSHOT_SCHEMA,
    templateId: options.templateId,
    reviewId: options.reviewId,
    revisionId: options.revisionId,
    ...(options.previousReviewId ? { previousReviewId: options.previousReviewId } : {}),
    createdAt: options.createdAt,
    validationErrors,
    blockingGates,
    warnings,
  };
  return {
    content,
    review: { ...reviewWithoutDigest, reviewDigest: digestReview(reviewWithoutDigest) },
    sources,
  };
}

function planDigest(plan: Omit<LifecyclePlan, "planDigest"> | LifecyclePlan) {
  const { planDigest: _planDigest, ...value } = plan as LifecyclePlan;
  if ("assetSources" in value) {
    value.assetSources = value.assetSources.map((source) => ({
      logicalPath: source.logicalPath,
      ...(source.sourcePath ? { sourcePath: "<verified-at-apply>" } : {}),
      ...(source.bytesBase64 ? { bytesBase64: "<verified-at-apply>" } : {}),
    }));
  }
  if (value.action === "adopt_legacy") {
    value.legacy = {
      ...value.legacy,
      assetSources: value.legacy.assetSources.map((source) => ({
        logicalPath: source.logicalPath,
        ...(source.sourcePath ? { sourcePath: "<verified-at-apply>" } : {}),
        ...(source.bytesBase64 ? { bytesBase64: "<verified-at-apply>" } : {}),
      })),
    };
  }
  return sha256(canonicalJson(value));
}

function publicKindAllowsAction(kind: PublicLifecyclePlanKind, action: LifecyclePlanAction) {
  if (kind === "working") return action === "create_working" || action === "update_working";
  if (kind === "gate") return action === "update_gates";
  if (kind === "publish") return action === "publish";
  if (kind === "discard") return action === "discard_working";
  if (kind === "restore") return action === "restore_release";
  if (kind === "adopt") return action === "adopt_legacy";
  return false;
}

function validatePublicPlanBinding(
  value: PublicLifecycleOperationBinding,
  action: LifecyclePlanAction,
  expectedSeriesDigest: string | null,
) {
  if (!publicKindAllowsAction(value.kind, action)) {
    throw new Error(`public lifecycle kind ${value.kind} does not match ${action}`);
  }
  assertHash(value.planDigest, "public lifecycle plan digest");
  if (value.expectedSeriesDigest !== null) {
    assertHash(value.expectedSeriesDigest, "public expected series digest");
  }
  if (value.expectedSeriesDigest !== expectedSeriesDigest) {
    throw new Error("public lifecycle binding does not match the backend expected state");
  }
  return value;
}

function withPlanDigest<T extends Omit<LifecyclePlan, "planDigest">>(plan: T): T & { planDigest: string } {
  return { ...plan, planDigest: planDigest(plan as Omit<LifecyclePlan, "planDigest">) };
}

async function exists(file: string) {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, "utf8")) as unknown;
}

async function atomicWriteJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  await fs.rename(temporary, file);
}

async function immutableWriteJson(file: string, value: unknown) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(file, serialized, { flag: "wx" });
    await fs.chmod(file, 0o444).catch(() => undefined);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((await fs.readFile(file, "utf8")) !== serialized) {
      throw new Error(`immutable object collision: ${file}`);
    }
  }
}

export interface VersionedLibraryStatus {
  root: string;
  directorySource: LibraryDirectorySource;
  libraryId?: string;
  configRevision: number | null;
  writesEnabled: boolean;
  legacyDefault: boolean;
  exists: boolean;
  readable: boolean;
  writable: boolean;
  seriesCount: number;
  publishedCount: number;
  workingCount: number;
}

export interface PublishedVersionedTemplateCandidate {
  templateId: string;
  revisionId: string;
  contentDigest: string;
  releaseId: string;
  publishedAt: string;
  title: string;
  description: string;
  tags: string[];
  visualProfile: string;
  dataProfile: string;
  scientificQuestion?: string;
  application?: string;
  packages: string[];
  license: string;
  assetKind: VersionedAssetKind;
  language: string;
  plotFamily: string;
  codeStatus: VersionedCodeStatus;
  executionStatus: ExecutionStatus;
  validationState: ValidationStateV1;
  primaryPreview?: string;
  canonicalPreviewDecision?: CanonicalPreviewDecision;
  previewAvailable: boolean;
}

export interface RevisionPreview {
  templateId: string;
  revisionId: string;
  contentDigest: string;
  logicalPath: string;
  mimeType: string;
  extension: string;
  bytes: Uint8Array;
}

export interface RevisionSelector {
  revisionId?: string;
  contentDigest?: string;
  scope?: "published" | "working";
}

export interface RevisionMaterializationOptions {
  templateId: string;
  revisionId: string;
  contentDigest: string;
  releaseId?: string;
  destination: string;
  operationId?: string;
  planDigest?: string;
}

export interface RevisionMaterializationResult {
  target: string;
  materializationSource: "versioned-library";
  templateId: string;
  revisionId: string;
  contentDigest: string;
  releaseId: string;
  files: string[];
  operationId?: string;
  idempotentReplay?: boolean;
}

export interface MaterializedFileInventoryEntry {
  relativePath: string;
  bytes: number;
  sha256: string;
}

export interface RevisionMaterializationPlanV1 {
  schema: typeof MATERIALIZATION_PLAN_SCHEMA;
  planId: string;
  templateId: string;
  revisionId: string;
  contentDigest: string;
  releaseId: string;
  releaseDigest: string;
  destination: string;
  targetName: string;
  expectedTargetAbsent: true;
  fileInventory: MaterializedFileInventoryEntry[];
  hostOperationId?: string;
  hostPlanDigest?: string;
  createdAt: string;
  planDigest: string;
}

export interface RevisionMaterializationReceiptV1 {
  schema: typeof MATERIALIZATION_RECEIPT_SCHEMA;
  receiptId: string;
  operationId: string;
  planId: string;
  planDigest: string;
  templateId: string;
  revisionId: string;
  contentDigest: string;
  releaseId: string;
  fileInventoryDigest: string;
  appliedAt: string;
}

export interface LegacyAdoptionOptions {
  templateId: string;
  canonicalImplementationAssetPath?: string;
  /** Binding id returned by copy_legacy; omitted for an in-place legacy root/templates source. */
  migrationBindingId?: string;
}

interface LegacyStoredFile {
  file: string;
  bytes: number;
  sha256: string;
}

interface LegacyTemplateV1 {
  schema: "figure-library.template.v1";
  templateId: string;
  sourceId: "user";
  title: string;
  description: string;
  tags: string[];
  visualProfile: string;
  dataProfile: string;
  scientificQuestion?: string;
  application?: string;
  packages: string[];
  license: string;
  importedAt: string;
  assetKind?: VersionedAssetKind;
  language?: string;
  plotFamily?: string;
  reviewStatus?: "draft" | "approved" | "archived";
  codeStatus?: VersionedCodeStatus;
  provenance?: JsonValue;
  registry?: JsonValue;
  preview?: LegacyStoredFile & { mediaType: string };
  code: LegacyStoredFile[];
  references?: Array<LegacyStoredFile & { role: "data" | "metadata" }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !HASH.test(value)) throw new Error(`invalid ${label}`);
}

function assertString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value) throw new Error(`invalid ${label}`);
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`invalid ${label}`);
  }
}

function validateLibraryOperationContextValue(value: unknown): LibraryOperationContext {
  if (!isRecord(value) || typeof value.libraryId !== "string" || !value.libraryId) {
    throw new Error("invalid lifecycle library context");
  }
  if (
    value.configRevision !== null &&
    (!Number.isSafeInteger(value.configRevision) || (value.configRevision as number) < 1)
  ) {
    throw new Error("invalid lifecycle library configRevision");
  }
  return {
    libraryId: value.libraryId,
    configRevision: value.configRevision as number | null,
  };
}

function validateStoredAsset(value: unknown): StoredRevisionAsset {
  if (!isRecord(value)) throw new Error("invalid stored revision asset");
  assertString(value.logicalPath, "stored asset logicalPath");
  const logicalPath = validateRevisionAssetPath(value.logicalPath);
  if (value.file !== `assets/${logicalPath}`) throw new Error(`invalid stored asset file: ${logicalPath}`);
  if (
    typeof value.role !== "string" ||
    !["visual", "code", "reference", "evidence"].includes(value.role)
  ) {
    throw new Error(`invalid stored asset role: ${logicalPath}`);
  }
  if (
    (value.role === "visual" &&
      value.visualRole !== "source_reference" &&
      value.visualRole !== "rendered_output") ||
    (value.role !== "visual" && value.visualRole !== undefined)
  ) {
    throw new Error(`invalid stored asset visualRole: ${logicalPath}`);
  }
  if (
    (value.role === "code" &&
      (typeof value.codeOrigin !== "string" ||
        !["user_supplied", "author_provided", "agent_generated", "adapted"].includes(
          value.codeOrigin,
        ))) ||
    (value.role !== "code" && value.codeOrigin !== undefined)
  ) {
    throw new Error(`invalid stored asset codeOrigin: ${logicalPath}`);
  }
  assertCanonicalAssetPath(
    logicalPath,
    value.role as RevisionAssetRole,
    value.visualRole as VisualAssetRole | undefined,
  );
  assertString(value.mediaType, "stored asset mediaType");
  if (!Number.isSafeInteger(value.bytes) || (value.bytes as number) < 0 || (value.bytes as number) > MAX_ASSET_BYTES) {
    throw new Error(`invalid stored asset byte count: ${logicalPath}`);
  }
  assertHash(value.sha256, `stored asset SHA-256: ${logicalPath}`);
  if (value.language !== undefined && typeof value.language !== "string") {
    throw new Error(`invalid stored asset language: ${logicalPath}`);
  }
  if (value.origin !== undefined) canonicalJson(value.origin);
  normalizeAssetRights(value.rights);
  return value as unknown as StoredRevisionAsset;
}

function validateContentValue(
  value: unknown,
  expectedTemplateId?: string,
  expectedRevisionId?: string,
): TemplateContentV1 {
  if (!isRecord(value) || value.schema !== TEMPLATE_CONTENT_SCHEMA) {
    throw new Error("invalid template content schema");
  }
  assertString(value.templateId, "content templateId");
  assertString(value.revisionId, "content revisionId");
  assertSafeSegment(value.templateId, "templateId");
  assertSafeSegment(value.revisionId, "revisionId");
  if (expectedTemplateId && value.templateId !== expectedTemplateId) {
    throw new Error(`content templateId mismatch: ${value.templateId}`);
  }
  if (expectedRevisionId && value.revisionId !== expectedRevisionId) {
    throw new Error(`content revisionId mismatch: ${value.revisionId}`);
  }
  assertString(value.createdAt, "content createdAt");
  assertString(value.title, "content title");
  for (const field of ["description", "visualProfile", "dataProfile", "license", "language", "plotFamily"] as const) {
    if (typeof value[field] !== "string") throw new Error(`invalid content ${field}`);
  }
  if (value.application !== undefined && (typeof value.application !== "string" || value.application.length > 8_000)) {
    throw new Error("invalid content application (maximum 8000 characters)");
  }
  if (value.scientificQuestion !== undefined) {
    if (typeof value.scientificQuestion !== "string") throw new Error("invalid content scientificQuestion");
    if (value.scientificQuestion.length > 2000) throw new Error("scientificQuestion exceeds 2000 characters");
  }
  assertStringArray(value.tags, "content tags");
  assertStringArray(value.packages, "content packages");
  if (value.assetKind !== "plot_template" && value.assetKind !== "visual_reference") {
    throw new Error("invalid content assetKind");
  }
  if (value.codeStatus !== "none" && value.codeStatus !== "scaffold" && value.codeStatus !== "reviewed") {
    throw new Error("invalid content codeStatus");
  }
  if (value.executionStatus !== "not_run" && value.executionStatus !== "passed" && value.executionStatus !== "failed") {
    throw new Error("invalid content executionStatus");
  }
  assertHash(value.contentDigest, "content digest");
  if (!Array.isArray(value.assets) || !value.assets.length) throw new Error("invalid content assets");
  const assets = value.assets.map(validateStoredAsset);
  const paths = new Set<string>();
  const folded = new Set<string>();
  let totalBytes = 0;
  for (const asset of assets) {
    const lower = portableCaseFold(asset.logicalPath);
    if (paths.has(asset.logicalPath) || folded.has(lower)) {
      throw new Error(`duplicate stored asset path: ${asset.logicalPath}`);
    }
    paths.add(asset.logicalPath);
    folded.add(lower);
    totalBytes += asset.bytes;
  }
  if (totalBytes > MAX_REVISION_BYTES) throw new Error("stored revision exceeds size limit");
  const byPath = new Map(assets.map((asset) => [asset.logicalPath, asset]));
  let validationState: ValidationStateV1 | undefined;
  if (value.validationState !== undefined) {
    validationState = normalizeValidationState(
      value.validationState as unknown as ValidationStateInputV1,
      value.executionStatus as ExecutionStatus,
      [],
    );
    if (canonicalJson(validationState) !== canonicalJson(value.validationState)) {
      throw new Error("validationState is not canonically normalized");
    }
    if (validationState.plotExecution.status !== value.executionStatus) {
      throw new Error("executionStatus conflicts with validationState.plotExecution.status");
    }
    const plotEvidence = validationState.plotExecution.evidenceAssetPaths ?? [];
    if (plotEvidence.some((assetPath) => byPath.get(assetPath)?.role !== "evidence")) {
      throw new Error("plotExecution evidence must reference evidence assets");
    }
    if (validationState.plotExecution.status === "passed" && !plotEvidence.length) {
      throw new Error("passed plotExecution requires evidence assets");
    }
    const upstreamEvidence = validationState.upstreamWorkflow.evidenceAssetPaths ?? [];
    if (upstreamEvidence.some((assetPath) => byPath.get(assetPath)?.role !== "evidence")) {
      throw new Error("upstreamWorkflow evidence must reference evidence assets");
    }
    if (["partial", "passed", "failed"].includes(validationState.upstreamWorkflow.status)) {
      if (!validationState.upstreamWorkflow.scope || !upstreamEvidence.length) {
        throw new Error("partial, passed, or failed upstreamWorkflow requires scope and evidence");
      }
    }
    if (["limited", "validated", "rejected"].includes(validationState.scientificValidation.status)) {
      const assessmentPath = validationState.scientificValidation.assessmentAssetPath;
      const assessmentRole = assessmentPath ? byPath.get(assessmentPath)?.role : undefined;
      if (
        !validationState.scientificValidation.decisionSource ||
        !assessmentPath ||
        (assessmentRole !== "reference" && assessmentRole !== "evidence")
      ) {
        throw new Error(
          "limited, validated, or rejected scientificValidation requires a decision source and assessment asset",
        );
      }
    }
  }
  if (value.primaryPreview !== undefined) {
    if (typeof value.primaryPreview !== "string") throw new Error("invalid primaryPreview");
    const preview = validateRevisionAssetPath(value.primaryPreview);
    if (byPath.get(preview)?.role !== "visual") throw new Error("primaryPreview must reference a visual asset");
  }
  if (value.canonicalPreviewDecision !== undefined) {
    if (!isRecord(value.canonicalPreviewDecision)) {
      throw new Error("invalid canonical preview decision");
    }
    assertString(value.canonicalPreviewDecision.assetPath, "canonical preview assetPath");
    const decisionPath = validateRevisionAssetPath(value.canonicalPreviewDecision.assetPath);
    if (decisionPath !== value.primaryPreview || byPath.get(decisionPath)?.role !== "visual") {
      throw new Error("canonical preview decision must match primaryPreview");
    }
    const selected = byPath.get(decisionPath)!;
    const visualAssets = assets.filter((asset) => asset.role === "visual");
    const reason = value.canonicalPreviewDecision.reason;
    if (reason === "default_uploaded_source") {
      if (
        value.canonicalPreviewDecision.selectedBy !== "policy" ||
        selected.visualRole !== "source_reference" ||
        visualAssets.filter((asset) => asset.visualRole === "source_reference").length !== 1
      ) {
        throw new Error("invalid default_uploaded_source decision");
      }
    } else if (reason === "only_visual_available") {
      if (value.canonicalPreviewDecision.selectedBy !== "policy" || visualAssets.length !== 1) {
        throw new Error("invalid only_visual_available decision");
      }
    } else if (reason === "user_selected_source") {
      if (value.canonicalPreviewDecision.selectedBy !== "user" || selected.visualRole !== "source_reference") {
        throw new Error("invalid user_selected_source decision");
      }
    } else if (reason === "user_override_rendered") {
      if (
        value.canonicalPreviewDecision.selectedBy !== "user" ||
        selected.visualRole !== "rendered_output" ||
        visualAssets.length <= 1 ||
        typeof value.canonicalPreviewDecision.note !== "string" ||
        !value.canonicalPreviewDecision.note.trim()
      ) {
        throw new Error("invalid user_override_rendered decision");
      }
    } else {
      throw new Error("invalid canonical preview decision reason");
    }
  }
  if (value.canonicalImplementation !== undefined) {
    if (!isRecord(value.canonicalImplementation) || value.canonicalImplementation.selectedBy !== "user") {
      throw new Error("invalid canonical implementation selection");
    }
    assertString(value.canonicalImplementation.assetPath, "canonical implementation assetPath");
    const selected = validateRevisionAssetPath(value.canonicalImplementation.assetPath);
    if (byPath.get(selected)?.role !== "code") throw new Error("canonical implementation must reference a code asset");
  }
  if (value.assetKind === "plot_template" && !value.canonicalImplementation) {
    throw new Error("plot template content lacks a canonical implementation");
  }
  if (value.assetKind === "visual_reference" && value.canonicalImplementation) {
    throw new Error("visual reference content cannot have a canonical implementation");
  }
  normalizeRuntimeClosure(
    value.runtime,
    byPath,
    isRecord(value.canonicalImplementation) && typeof value.canonicalImplementation.assetPath === "string"
      ? value.canonicalImplementation.assetPath
      : undefined,
    typeof value.primaryPreview === "string" ? value.primaryPreview : undefined,
  );
  if (!Array.isArray(value.figureCodeLinks)) throw new Error("invalid figureCodeLinks");
  for (const link of value.figureCodeLinks) {
    if (!isRecord(link) || typeof link.evidence !== "string" || !link.evidence.trim()) {
      throw new Error("invalid figure-code link evidence");
    }
    assertString(link.visualAssetPath, "figure-code visual path");
    if (byPath.get(validateRevisionAssetPath(link.visualAssetPath))?.role !== "visual") {
      throw new Error("figure-code link must reference a visual asset");
    }
    assertStringArray(link.codeAssetPaths, "figure-code paths");
    if (!link.codeAssetPaths.length || link.codeAssetPaths.some((item) => byPath.get(validateRevisionAssetPath(item))?.role !== "code")) {
      throw new Error("figure-code link must reference code assets");
    }
    if (
      typeof link.relationship !== "string" ||
      ![
        "user_supplied_pair",
        "visual_inference",
        "adapted_from_template",
        "generated_output",
        "author_provided_original",
      ].includes(link.relationship) ||
      link.confirmedBy !== "user"
    ) {
      throw new Error("invalid figure-code relationship confirmation");
    }
    const linkedVisual = byPath.get(validateRevisionAssetPath(link.visualAssetPath));
    if (
      link.relationship === "visual_inference" &&
      (linkedVisual?.visualRole !== "source_reference" ||
        value.codeStatus !== "scaffold" ||
        value.executionStatus !== "not_run" ||
        link.codeAssetPaths.some(
          (item) => byPath.get(validateRevisionAssetPath(item))?.codeOrigin !== "agent_generated",
        ))
    ) {
      throw new Error("visual_inference must be an agent-generated scaffold/not_run from source_reference");
    }
    if (link.relationship === "generated_output" && linkedVisual?.visualRole !== "rendered_output") {
      throw new Error("generated_output must target rendered_output");
    }
    if (link.confidence !== undefined && (typeof link.confidence !== "number" || !Number.isFinite(link.confidence) || link.confidence < 0 || link.confidence > 1)) {
      throw new Error("invalid figure-code confidence");
    }
  }
  if (validationState?.plotExecution.status === "passed") {
    if (!assets.some((asset) => asset.role === "visual" && asset.visualRole === "rendered_output")) {
      throw new Error("passed plotExecution requires a rendered_output visual");
    }
    if (!value.figureCodeLinks.some((link) => isRecord(link) && link.relationship === "generated_output")) {
      throw new Error("passed plotExecution requires a generated_output relationship");
    }
  }
  if (!isRecord(value.visualGrouping) || value.visualGrouping.confirmedBy !== "user") {
    throw new Error("invalid visual grouping confirmation");
  }
  assertStringArray(value.visualGrouping.visualAssetPaths, "visual grouping paths");
  const grouped = new Set(value.visualGrouping.visualAssetPaths.map(validateRevisionAssetPath));
  const visualPaths = assets.filter((asset) => asset.role === "visual").map((asset) => asset.logicalPath);
  if (
    grouped.size !== visualPaths.length ||
    visualPaths.some((item) => !grouped.has(item)) ||
    [...grouped].some((item) => byPath.get(item)?.role !== "visual")
  ) {
    throw new Error("visual grouping must contain exactly all visual assets");
  }
  if (value.intakeBinding !== undefined) {
    if (!isRecord(value.intakeBinding)) throw new Error("invalid intake binding");
    assertString(value.intakeBinding.adapterId, "adapterId");
    assertString(value.intakeBinding.importId, "importId");
    assertSafeSegment(value.intakeBinding.adapterId, "adapterId");
    assertSafeSegment(value.intakeBinding.importId, "importId");
    if (value.intakeBinding.sourceManifest === undefined) throw new Error("intake binding requires sourceManifest");
    assertNoAbsoluteFilesystemPaths(value.intakeBinding.sourceManifest as JsonValue, "intakeBinding.sourceManifest");
    assertStringArray(value.intakeBinding.requiredAssetSha256, "intake required hashes");
    if (!value.intakeBinding.requiredAssetSha256.length) throw new Error("intake binding requires asset hashes");
    const inventory = new Set(assets.map((asset) => asset.sha256));
    for (const digest of value.intakeBinding.requiredAssetSha256) {
      assertHash(digest, "intake required asset digest");
      if (!inventory.has(digest)) throw new Error("intake binding is not self-contained");
    }
  }
  if (value.parentRevisionId !== undefined) assertSafeSegment(String(value.parentRevisionId), "parentRevisionId");
  if (value.restoredFromReleaseId !== undefined) assertSafeSegment(String(value.restoredFromReleaseId), "restoredFromReleaseId");
  if (value.provenance !== undefined) assertNoAbsoluteFilesystemPaths(value.provenance as JsonValue, "provenance");
  if (value.annotations !== undefined) assertNoAbsoluteFilesystemPaths(value.annotations as JsonValue, "annotations");
  if (digestContent(value as unknown as TemplateContentV1) !== value.contentDigest) {
    throw new Error(`content digest mismatch: ${value.revisionId}`);
  }
  return value as unknown as TemplateContentV1;
}

function validateReviewValue(
  value: unknown,
  expectedTemplateId?: string,
  expectedReviewId?: string,
): ReviewSnapshotV1 {
  if (!isRecord(value) || value.schema !== REVIEW_SNAPSHOT_SCHEMA) {
    throw new Error("invalid review snapshot schema");
  }
  assertString(value.templateId, "review templateId");
  assertString(value.reviewId, "reviewId");
  assertString(value.revisionId, "review revisionId");
  assertString(value.createdAt, "review createdAt");
  assertSafeSegment(value.templateId, "templateId");
  assertSafeSegment(value.reviewId, "reviewId");
  assertSafeSegment(value.revisionId, "revisionId");
  if (value.previousReviewId !== undefined) assertSafeSegment(String(value.previousReviewId), "previousReviewId");
  if (expectedTemplateId && value.templateId !== expectedTemplateId) {
    throw new Error(`review templateId mismatch: ${value.templateId}`);
  }
  if (expectedReviewId && value.reviewId !== expectedReviewId) {
    throw new Error(`reviewId mismatch: ${value.reviewId}`);
  }
  if (!Array.isArray(value.validationErrors) || !Array.isArray(value.blockingGates) || !Array.isArray(value.warnings)) {
    throw new Error("invalid review issue collections");
  }
  const validateIssue = (issue: unknown, label: string, sources: ReviewSource[]) => {
    if (!isRecord(issue)) throw new Error(`invalid ${label}`);
    for (const field of ["id", "code", "message"] as const) assertString(issue[field], `${label} ${field}`);
    if (issue.path !== undefined && typeof issue.path !== "string") throw new Error(`invalid ${label} path`);
    if (typeof issue.source !== "string" || !sources.includes(issue.source as ReviewSource)) {
      throw new Error(`invalid ${label} source`);
    }
  };
  for (const issue of value.validationErrors) validateIssue(issue, "validation error", ["system", "rule", "agent", "migration"]);
  for (const issue of value.warnings) validateIssue(issue, "review warning", ["system", "rule", "agent", "user", "migration"]);
  const gateIds = new Set<string>();
  for (const gate of value.blockingGates) {
    if (!isRecord(gate)) throw new Error("invalid blocking gate record");
    for (const field of ["gateId", "code", "message"] as const) assertString(gate[field], `blocking gate ${field}`);
    const gateId = String(gate.gateId);
    if (gateIds.has(gateId)) throw new Error(`duplicate blocking gate: ${gateId}`);
    gateIds.add(gateId);
    if (gate.path !== undefined && typeof gate.path !== "string") throw new Error("invalid blocking gate path");
    if (gate.source !== "rule" && gate.source !== "agent" && gate.source !== "user" && gate.source !== "migration") {
      throw new Error("invalid blocking gate source");
    }
    if (gate.status !== "open" && gate.status !== "resolved") throw new Error("invalid blocking gate status");
    if (gate.status === "open" && gate.resolution !== undefined) throw new Error(`open gate has a resolution: ${gate.gateId}`);
    if (gate.status === "resolved") {
      if (!isRecord(gate.resolution) || gate.resolution.decision !== "resolved" || gate.resolution.source !== "user") {
        throw new Error(`resolved gate lacks a user resolution: ${gate.gateId}`);
      }
      assertString(gate.resolution.decidedAt, "gate resolution decidedAt");
      assertString(gate.resolution.note, "gate resolution note");
    }
  }
  assertHash(value.reviewDigest, "review digest");
  if (digestReview(value as unknown as ReviewSnapshotV1) !== value.reviewDigest) {
    throw new Error(`review digest mismatch: ${value.reviewId}`);
  }
  return value as unknown as ReviewSnapshotV1;
}

function validateReleaseValue(
  value: unknown,
  expectedTemplateId?: string,
  expectedReleaseId?: string,
): TemplateReleaseV1 {
  if (!isRecord(value) || value.schema !== TEMPLATE_RELEASE_SCHEMA) {
    throw new Error("invalid template release schema");
  }
  for (const field of ["templateId", "releaseId", "revisionId", "reviewId"] as const) {
    assertString(value[field], `release ${field}`);
    assertSafeSegment(value[field], field);
  }
  if (expectedTemplateId && value.templateId !== expectedTemplateId) {
    throw new Error(`release templateId mismatch: ${value.templateId}`);
  }
  if (expectedReleaseId && value.releaseId !== expectedReleaseId) {
    throw new Error(`releaseId mismatch: ${value.releaseId}`);
  }
  assertString(value.publishedAt, "release publishedAt");
  if (value.previousReleaseId !== undefined) assertSafeSegment(String(value.previousReleaseId), "previousReleaseId");
  if (value.restoredFromReleaseId !== undefined) assertSafeSegment(String(value.restoredFromReleaseId), "restoredFromReleaseId");
  assertHash(value.contentDigest, "release content digest");
  assertHash(value.reviewDigest, "release review digest");
  assertHash(value.releaseDigest, "release digest");
  if (digestRelease(value as unknown as TemplateReleaseV1) !== value.releaseDigest) {
    throw new Error(`release digest mismatch: ${value.releaseId}`);
  }
  return value as unknown as TemplateReleaseV1;
}

function validateSeriesValue(value: unknown, expectedTemplateId?: string): TemplateSeriesV1 {
  if (!isRecord(value) || value.schema !== TEMPLATE_SERIES_SCHEMA) {
    throw new Error("invalid template series schema");
  }
  assertString(value.templateId, "series templateId");
  assertSafeSegment(value.templateId, "templateId");
  if (expectedTemplateId && value.templateId !== expectedTemplateId) {
    throw new Error(`series templateId mismatch: ${value.templateId}`);
  }
  if (value.status !== "active" && value.status !== "archived") {
    throw new Error(`invalid series status: ${String(value.status)}`);
  }
  assertString(value.createdAt, "series createdAt");
  assertString(value.updatedAt, "series updatedAt");
  const validateHead = (head: unknown, label: string) => {
    if (!isRecord(head)) throw new Error(`invalid ${label}`);
    assertString(head.revisionId, `${label} revisionId`);
    assertSafeSegment(head.revisionId, "revisionId");
    assertHash(head.contentDigest, `${label} content digest`);
  };
  if (value.publishedHead !== undefined) {
    validateHead(value.publishedHead, "published head");
    const head = value.publishedHead as Record<string, unknown>;
    assertString(head.releaseId, "published head releaseId");
    assertSafeSegment(head.releaseId, "releaseId");
    assertString(head.publishedAt, "published head publishedAt");
  }
  if (value.workingHead !== undefined) {
    validateHead(value.workingHead, "working head");
    const head = value.workingHead as Record<string, unknown>;
    assertString(head.reviewId, "working head reviewId");
    assertSafeSegment(head.reviewId, "reviewId");
    assertHash(head.reviewDigest, "working head review digest");
    assertString(head.updatedAt, "working head updatedAt");
    if (head.baseReleaseId !== undefined) assertSafeSegment(String(head.baseReleaseId), "baseReleaseId");
  }
  return value as unknown as TemplateSeriesV1;
}

function parseLegacyStored(value: unknown, label: string): LegacyStoredFile {
  if (!isRecord(value)) throw new Error(`invalid legacy ${label}`);
  assertString(value.file, `legacy ${label} file`);
  validateRevisionAssetPath(value.file);
  if (!Number.isSafeInteger(value.bytes) || (value.bytes as number) < 0 || (value.bytes as number) > MAX_ASSET_BYTES) {
    throw new Error(`invalid legacy ${label} byte count`);
  }
  assertHash(value.sha256, `legacy ${label} SHA-256`);
  return value as unknown as LegacyStoredFile;
}

function parseLegacyTemplate(value: unknown, expectedTemplateId: string): LegacyTemplateV1 {
  if (!isRecord(value) || value.schema !== "figure-library.template.v1" || value.sourceId !== "user") {
    throw new Error("invalid legacy template schema");
  }
  assertString(value.templateId, "legacy templateId");
  if (value.templateId !== expectedTemplateId) throw new Error("legacy templateId does not match its directory");
  assertSafeSegment(value.templateId, "templateId");
  for (const field of ["title", "description", "visualProfile", "dataProfile", "license", "importedAt"] as const) {
    if (typeof value[field] !== "string") throw new Error(`invalid legacy ${field}`);
  }
  if (value.scientificQuestion !== undefined && typeof value.scientificQuestion !== "string") {
    throw new Error("invalid legacy scientificQuestion");
  }
  if (value.application !== undefined && (typeof value.application !== "string" || value.application.length > 8_000)) {
    throw new Error("invalid legacy application");
  }
  assertStringArray(value.tags, "legacy tags");
  assertStringArray(value.packages, "legacy packages");
  if (!Array.isArray(value.code)) throw new Error("invalid legacy code files");
  value.code.forEach((item, index) => parseLegacyStored(item, `code ${index}`));
  if (value.references !== undefined && !Array.isArray(value.references)) {
    throw new Error("invalid legacy references");
  }
  for (const [index, item] of ((value.references ?? []) as unknown[]).entries()) {
    parseLegacyStored(item, `reference ${index}`);
    if (!isRecord(item) || (item.role !== "data" && item.role !== "metadata")) {
      throw new Error(`invalid legacy reference role: ${index}`);
    }
  }
  if (value.preview !== undefined) {
    parseLegacyStored(value.preview, "preview");
    if (!isRecord(value.preview) || typeof value.preview.mediaType !== "string") {
      throw new Error("invalid legacy preview mediaType");
    }
  }
  if (value.assetKind !== undefined && value.assetKind !== "plot_template" && value.assetKind !== "visual_reference") {
    throw new Error("invalid legacy assetKind");
  }
  if (value.reviewStatus !== undefined && !["draft", "approved", "archived"].includes(String(value.reviewStatus))) {
    throw new Error("invalid legacy reviewStatus");
  }
  if (value.codeStatus !== undefined && !["none", "scaffold", "reviewed"].includes(String(value.codeStatus))) {
    throw new Error("invalid legacy codeStatus");
  }
  if (value.provenance !== undefined) canonicalJson(value.provenance);
  if (value.registry !== undefined) canonicalJson(value.registry);
  return value as unknown as LegacyTemplateV1;
}

function omitUndefinedJson(value: unknown): JsonValue {
  return JSON.parse(canonicalJson(value)) as JsonValue;
}

async function makeReadOnly(file: string, bytes: Uint8Array | string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes, { flag: "wx" });
  await fs.chmod(file, 0o444).catch(() => undefined);
}

export class VersionedTemplateLibrary {
  readonly root: string;
  readonly storeDirectory: string;
  readonly templatesDirectory: string;
  readonly legacyTemplatesDirectory: string;
  readonly operationsDirectory: string;
  readonly operationIntentsDirectory: string;
  readonly importsDirectory: string;
  readonly writeLockDirectory: string;
  readonly directorySource: LibraryDirectorySource;
  readonly configRevision: number | null;
  readonly writesEnabled: boolean;
  readonly runtimeContext?: LibraryOperationContext;
  private readonly faultInjector?: VersionedTemplateLibraryOptions["faultInjector"];
  private libraryId?: string;

  constructor(
    root?: string | LibraryRuntimeSnapshot,
    options: VersionedTemplateLibraryOptions = {},
  ) {
    const selected =
      typeof root === "string"
        ? resolveLibraryRuntimeSnapshotSync({ root })
        : root ?? resolveLibraryRuntimeSnapshotSync();
    this.directorySource = selected.directorySource;
    this.root = path.resolve(selected.root);
    this.storeDirectory = path.join(this.root, "store");
    this.templatesDirectory = path.join(this.storeDirectory, "templates");
    this.legacyTemplatesDirectory = path.join(this.root, "templates");
    this.operationsDirectory = path.join(this.storeDirectory, "operations");
    this.operationIntentsDirectory = path.join(this.operationsDirectory, "intents");
    this.importsDirectory = path.join(this.storeDirectory, "imports");
    this.writeLockDirectory = path.join(this.root, "locks", "write");
    this.configRevision = selected.configRevision;
    this.writesEnabled = selected.writesEnabled;
    this.libraryId = selected.libraryId;
    this.runtimeContext = operationContextForSnapshot(selected);
    this.faultInjector = options.faultInjector;
  }

  private templateDirectory(templateId: string) {
    return path.join(this.templatesDirectory, assertSafeSegment(templateId, "templateId"));
  }

  private legacyTemplateDirectory(templateId: string, migrationBindingId?: string) {
    const safeTemplateId = assertSafeSegment(templateId, "templateId");
    return migrationBindingId
      ? path.join(
          this.storeDirectory,
          "migrations",
          "flat-v1",
          assertSafeSegment(migrationBindingId, "migrationBindingId"),
          "source",
          "templates",
          safeTemplateId,
        )
      : path.join(this.legacyTemplatesDirectory, safeTemplateId);
  }

  private async assertNoTemplateIdCaseCollision(templateId: string) {
    const folded = portableCaseFold(assertSafeSegment(templateId, "templateId"));
    for (const directory of [this.templatesDirectory, this.legacyTemplatesDirectory]) {
      let entries: import("node:fs").Dirent[];
      try {
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const collision = entries.find(
        (entry) =>
          entry.isDirectory() &&
          entry.name !== templateId &&
          portableCaseFold(entry.name) === folded,
      );
      if (collision) {
        throw new Error(
          `portable case-fold collision for templateId: ${collision.name}, ${templateId}`,
        );
      }
    }
  }

  private seriesFile(templateId: string) {
    return path.join(this.templateDirectory(templateId), "series.json");
  }

  private revisionDirectory(templateId: string, revisionId: string) {
    return path.join(
      this.templateDirectory(templateId),
      "revisions",
      assertSafeSegment(revisionId, "revisionId"),
    );
  }

  private reviewFile(templateId: string, reviewId: string) {
    return path.join(
      this.templateDirectory(templateId),
      "reviews",
      `${assertSafeSegment(reviewId, "reviewId")}.json`,
    );
  }

  private releaseFile(templateId: string, releaseId: string) {
    return path.join(
      this.templateDirectory(templateId),
      "releases",
      `${assertSafeSegment(releaseId, "releaseId")}.json`,
    );
  }

  private operationFile(operationId: string) {
    return path.join(
      this.operationsDirectory,
      "receipts",
      `${assertSafeSegment(operationId, "operationId")}.json`,
    );
  }

  private operationIntentFile(operationId: string) {
    return path.join(
      this.operationIntentsDirectory,
      `${assertSafeSegment(operationId, "operationId")}.json`,
    );
  }

  private async injectFault(
    point: LifecycleFaultPoint,
    intent: Pick<LifecycleOperationIntentV1, "operationId" | "action" | "templateId">,
  ) {
    await this.faultInjector?.(point, {
      operationId: intent.operationId,
      action: intent.action,
      templateId: intent.templateId,
    });
  }

  private async withWriteLock<T>(operation: string, callback: () => Promise<T>) {
    if (!this.writesEnabled) {
      throw new Error(
        "library_not_bound: the legacy ~/.figure-library default is read-only until the global library is explicitly bound",
      );
    }
    const marker = await ensureLibraryRootMarker(this.root, this.libraryId);
    this.libraryId = marker.value.libraryId;
    return withCrossRuntimeWriteLock(
      {
        root: this.root,
        lockDirectory: this.writeLockDirectory,
        libraryId: marker.value.libraryId,
        operation: `versioned-library:${operation}`,
      },
      callback,
    );
  }

  async status(): Promise<VersionedLibraryStatus> {
    let rootExists = false;
    let readable = false;
    let writable = false;
    try {
      const stat = await fs.stat(this.root);
      rootExists = stat.isDirectory();
      if (rootExists) {
        await fs.access(this.root, fs.constants.R_OK);
        readable = true;
        await fs.access(this.root, fs.constants.W_OK);
        writable = true;
      }
    } catch {
      // Status must remain read-only and must not create a missing library directory.
    }
    const series = readable ? await this.listSeries({ includeArchived: true }) : [];
    return {
      root: this.root,
      directorySource: this.directorySource,
      ...(this.libraryId ? { libraryId: this.libraryId } : {}),
      configRevision: this.configRevision,
      writesEnabled: this.writesEnabled,
      legacyDefault: this.directorySource === "legacy-default",
      exists: rootExists,
      readable,
      writable,
      seriesCount: series.length,
      publishedCount: series.filter((item) => item.publishedHead).length,
      workingCount: series.filter((item) => item.workingHead).length,
    };
  }

  async getSeries(templateId: string): Promise<TemplateSeriesV1 | undefined> {
    const file = this.seriesFile(templateId);
    try {
      return validateSeriesValue(await readJson(file), templateId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async listSeries(options: { includeArchived?: boolean } = {}): Promise<TemplateSeriesV1[]> {
    let entries;
    try {
      entries = await fs.readdir(this.templatesDirectory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const result: TemplateSeriesV1[] = [];
    const directories = entries.filter((item) => item.isDirectory() && !item.name.startsWith("."));
    const safeNames = directories.filter((entry) => isSafeSegment(entry.name)).map((entry) => entry.name);
    assertNoPortableCaseCollision(safeNames, "template series directories");
    for (const entry of directories) {
      if (!isSafeSegment(entry.name)) continue;
      const series = await this.getSeries(entry.name);
      if (series && (options.includeArchived || series.status !== "archived")) result.push(series);
    }
    return result.sort((left, right) => compareCanonicalStrings(left.templateId, right.templateId));
  }

  async getContent(
    templateId: string,
    revisionId: string,
    expectedDigest?: string,
  ): Promise<TemplateContentV1 | undefined> {
    assertSafeSegment(templateId, "templateId");
    assertSafeSegment(revisionId, "revisionId");
    const file = path.join(this.revisionDirectory(templateId, revisionId), "content.json");
    try {
      const content = validateContentValue(await readJson(file), templateId, revisionId);
      if (expectedDigest && content.contentDigest !== expectedDigest) {
        throw new Error(`content digest does not match exact selector: ${revisionId}`);
      }
      return content;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async getReview(templateId: string, reviewId: string): Promise<ReviewSnapshotV1 | undefined> {
    try {
      return validateReviewValue(await readJson(this.reviewFile(templateId, reviewId)), templateId, reviewId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async getRelease(templateId: string, releaseId: string): Promise<TemplateReleaseV1 | undefined> {
    try {
      return validateReleaseValue(await readJson(this.releaseFile(templateId, releaseId)), templateId, releaseId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async requireSeries(templateId: string) {
    const series = await this.getSeries(templateId);
    if (!series) throw new Error(`unknown versioned template: ${templateId}`);
    return series;
  }

  private async requireContent(templateId: string, revisionId: string, digest?: string) {
    const content = await this.getContent(templateId, revisionId, digest);
    if (!content) throw new Error(`unknown template revision: ${templateId}/${revisionId}`);
    return content;
  }

  private async requireReview(templateId: string, reviewId: string) {
    const review = await this.getReview(templateId, reviewId);
    if (!review) throw new Error(`unknown template review: ${templateId}/${reviewId}`);
    return review;
  }

  private async requireRelease(templateId: string, releaseId: string) {
    const release = await this.getRelease(templateId, releaseId);
    if (!release) throw new Error(`unknown template release: ${templateId}/${releaseId}`);
    return release;
  }

  private async expectedSeriesDigest(templateId: string) {
    const series = await this.getSeries(templateId);
    return series ? templateSeriesDigest(series) : null;
  }

  async listPublishedCandidates(): Promise<PublishedVersionedTemplateCandidate[]> {
    const output: PublishedVersionedTemplateCandidate[] = [];
    for (const series of await this.listSeries()) {
      const head = series.publishedHead;
      if (!head) continue;
      const [content, release] = await Promise.all([
        this.requireContent(series.templateId, head.revisionId, head.contentDigest),
        this.requireRelease(series.templateId, head.releaseId),
      ]);
      if (
        release.revisionId !== head.revisionId ||
        release.contentDigest !== head.contentDigest ||
        release.publishedAt !== head.publishedAt
      ) {
        throw new Error(`published head does not match its release: ${series.templateId}`);
      }
      let previewAvailable = false;
      if (content.primaryPreview) {
        try {
          const { asset, bytes } = await this.checkedRevisionAsset(
            content,
            content.primaryPreview,
          );
          const extension = path.posix
            .extname(asset.logicalPath)
            .toLocaleLowerCase("en-US");
          if (asset.role !== "visual") {
            throw new Error("primary preview is not a visual asset");
          }
          assertMcpImageBytes({ bytes, mimeType: asset.mediaType, extension });
          previewAvailable = true;
        } catch {
          // Published content remains retrievable and materializable, but search must
          // not advertise malformed, missing, or corrupted bytes as an MCP image.
        }
      }
      output.push({
        templateId: series.templateId,
        revisionId: content.revisionId,
        contentDigest: content.contentDigest,
        releaseId: release.releaseId,
        publishedAt: release.publishedAt,
        title: content.title,
        description: content.description,
        tags: [...content.tags],
        visualProfile: content.visualProfile,
        dataProfile: content.dataProfile,
        ...(content.application ? { application: content.application } : {}),
        ...(content.scientificQuestion ? { scientificQuestion: content.scientificQuestion } : {}),
        packages: [...content.packages],
        license: content.license,
        assetKind: content.assetKind,
        language: content.language,
        plotFamily: content.plotFamily,
        codeStatus: content.codeStatus,
        executionStatus: content.executionStatus,
        validationState: effectiveValidationState(content),
        ...(content.primaryPreview ? { primaryPreview: content.primaryPreview } : {}),
        ...(content.canonicalPreviewDecision
          ? { canonicalPreviewDecision: canonicalJsonClone(content.canonicalPreviewDecision) }
          : {}),
        previewAvailable,
      });
    }
    return output.sort((left, right) => compareCanonicalStrings(left.templateId, right.templateId));
  }

  private async listReleases(templateId: string): Promise<TemplateReleaseV1[]> {
    const directory = path.join(this.templateDirectory(templateId), "releases");
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const releases: TemplateReleaseV1[] = [];
    for (const entry of entries.filter((item) => item.isFile() && item.name.endsWith(".json"))) {
      const releaseId = entry.name.slice(0, -5);
      if (!isSafeSegment(releaseId)) throw new Error(`unsafe release filename: ${entry.name}`);
      releases.push(await this.requireRelease(templateId, releaseId));
    }
    return releases.sort(
      (left, right) => compareCanonicalStrings(left.publishedAt, right.publishedAt) || compareCanonicalStrings(left.releaseId, right.releaseId),
    );
  }

  private async reachableReleases(
    templateId: string,
    seriesInput?: TemplateSeriesV1,
  ): Promise<TemplateReleaseV1[]> {
    const series = seriesInput ?? (await this.requireSeries(templateId));
    const head = series.publishedHead;
    if (!head) return [];
    const releasesById = new Map(
      (await this.listReleases(templateId)).map((release) => [release.releaseId, release]),
    );
    const newestFirst: TemplateReleaseV1[] = [];
    const visited = new Set<string>();
    let releaseId: string | undefined = head.releaseId;
    while (releaseId) {
      if (visited.has(releaseId)) throw new Error(`release history contains a cycle: ${releaseId}`);
      visited.add(releaseId);
      const release = releasesById.get(releaseId);
      if (!release) throw new Error(`published release is missing from history: ${releaseId}`);
      newestFirst.push(release);
      releaseId = release.previousReleaseId;
    }
    const current = newestFirst[0];
    if (
      !current ||
      current.revisionId !== head.revisionId ||
      current.contentDigest !== head.contentDigest ||
      current.publishedAt !== head.publishedAt
    ) {
      throw new Error(`published head does not match its reachable release: ${templateId}`);
    }
    return newestFirst.reverse();
  }

  private async requirePublishedRelease(templateId: string, releaseId: string) {
    const release = (await this.reachableReleases(templateId)).find(
      (item) => item.releaseId === releaseId,
    );
    if (!release) throw new Error(`release is not reachable from Published Head: ${templateId}/${releaseId}`);
    return release;
  }

  async history(templateId: string): Promise<TemplateHistory> {
    const series = await this.requireSeries(templateId);
    const directory = path.join(this.templateDirectory(templateId), "revisions");
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") entries = [];
      else throw error;
    }
    const revisions: TemplateHistory["revisions"] = [];
    for (const entry of entries.filter((item) => item.isDirectory() && !item.name.startsWith("."))) {
      if (!isSafeSegment(entry.name)) throw new Error(`unsafe revision directory: ${entry.name}`);
      const content = await this.requireContent(templateId, entry.name);
      revisions.push({
        revisionId: content.revisionId,
        ...(content.parentRevisionId ? { parentRevisionId: content.parentRevisionId } : {}),
        ...(content.restoredFromReleaseId ? { restoredFromReleaseId: content.restoredFromReleaseId } : {}),
        createdAt: content.createdAt,
        contentDigest: content.contentDigest,
        title: content.title,
      });
    }
    revisions.sort(
      (left, right) => compareCanonicalStrings(left.createdAt, right.createdAt) || compareCanonicalStrings(left.revisionId, right.revisionId),
    );
    return { series, revisions, releases: await this.reachableReleases(templateId, series) };
  }

  async diff(templateId: string, fromRevisionId: string, toRevisionId: string): Promise<RevisionDiff> {
    const [before, after] = await Promise.all([
      this.requireContent(templateId, fromRevisionId),
      this.requireContent(templateId, toRevisionId),
    ]);
    const ignored = new Set([
      "schema",
      "templateId",
      "revisionId",
      "parentRevisionId",
      "restoredFromReleaseId",
      "createdAt",
      "contentDigest",
      "assets",
    ]);
    const beforeRecord = before as unknown as Record<string, unknown>;
    const afterRecord = after as unknown as Record<string, unknown>;
    const fields = [...new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)])]
      .filter((field) => !ignored.has(field))
      .sort();
    const fieldChanges: RevisionDiff["fieldChanges"] = [];
    for (const field of fields) {
      if (
        canonicalJson(beforeRecord[field] ?? null) !==
        canonicalJson(afterRecord[field] ?? null)
      ) {
        fieldChanges.push({
          field,
          before: beforeRecord[field] === undefined ? null : omitUndefinedJson(beforeRecord[field]),
          after: afterRecord[field] === undefined ? null : omitUndefinedJson(afterRecord[field]),
        });
      }
    }
    const beforeAssets = new Map(before.assets.map((asset) => [asset.logicalPath, asset]));
    const afterAssets = new Map(after.assets.map((asset) => [asset.logicalPath, asset]));
    const added = after.assets.filter((asset) => !beforeAssets.has(asset.logicalPath));
    const removed = before.assets.filter((asset) => !afterAssets.has(asset.logicalPath));
    const changed: RevisionDiff["assets"]["changed"] = [];
    for (const asset of after.assets) {
      const previous = beforeAssets.get(asset.logicalPath);
      if (previous && canonicalJson(previous) !== canonicalJson(asset)) {
        changed.push({ logicalPath: asset.logicalPath, before: previous, after: asset });
      }
    }
    return {
      templateId,
      fromRevisionId,
      toRevisionId,
      fieldChanges,
      assets: { added, removed, changed },
    };
  }

  private async checkedRevisionAsset(content: TemplateContentV1, logicalPath: string) {
    const safePath = validateRevisionAssetPath(logicalPath);
    const asset = content.assets.find((item) => item.logicalPath === safePath);
    if (!asset) throw new Error(`unknown revision asset: ${logicalPath}`);
    const file = resolveContained(this.revisionDirectory(content.templateId, content.revisionId), asset.file);
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`revision asset is not a regular file: ${logicalPath}`);
    }
    if (stat.size !== asset.bytes) throw new Error(`revision asset size mismatch: ${logicalPath}`);
    const bytes = new Uint8Array(await fs.readFile(file));
    if (sha256(bytes) !== asset.sha256) throw new Error(`revision asset checksum mismatch: ${logicalPath}`);
    return { asset, bytes };
  }

  async readAsset(options: {
    templateId: string;
    revisionId: string;
    contentDigest: string;
    logicalPath: string;
  }) {
    const content = await this.requireContent(options.templateId, options.revisionId, options.contentDigest);
    const { asset, bytes } = await this.checkedRevisionAsset(content, options.logicalPath);
    return { templateId: options.templateId, revisionId: options.revisionId, contentDigest: options.contentDigest, asset, bytes };
  }

  private async releasedRevision(templateId: string, revisionId: string, contentDigest: string) {
    return (await this.reachableReleases(templateId)).find(
      (release) => release.revisionId === revisionId && release.contentDigest === contentDigest,
    );
  }

  async getPreview(templateId: string, selector: RevisionSelector = {}): Promise<RevisionPreview | undefined> {
    const series = await this.requireSeries(templateId);
    let revisionId: string;
    let contentDigest: string;
    if (selector.revisionId || selector.contentDigest) {
      if (!selector.revisionId || !selector.contentDigest) {
        throw new Error("an exact preview selector requires both revisionId and contentDigest");
      }
      revisionId = selector.revisionId;
      contentDigest = selector.contentDigest;
      if (selector.scope === "working") {
        if (
          series.workingHead?.revisionId !== revisionId ||
          series.workingHead.contentDigest !== contentDigest
        ) {
          throw new Error("the exact selector is not the current working revision");
        }
      } else if (!(await this.releasedRevision(templateId, revisionId, contentDigest))) {
        throw new Error("the exact selector is not a published release");
      }
    } else {
      const head = selector.scope === "working" ? series.workingHead : series.publishedHead;
      if (!head) return undefined;
      revisionId = head.revisionId;
      contentDigest = head.contentDigest;
    }
    const content = await this.requireContent(templateId, revisionId, contentDigest);
    if (!content.primaryPreview) return undefined;
    const { asset, bytes } = await this.checkedRevisionAsset(content, content.primaryPreview);
    if (asset.role !== "visual") throw new Error("primary preview is not a visual asset");
    if (!MCP_IMAGE_MEDIA_TYPES.has(asset.mediaType)) {
      throw new Error(
        `primary preview media type ${asset.mediaType} cannot be returned as an MCP image; materialize the exact template instead`,
      );
    }
    const extension = path.posix.extname(asset.logicalPath).toLocaleLowerCase();
    assertMcpImageBytes({ bytes, mimeType: asset.mediaType, extension });
    return {
      templateId,
      revisionId,
      contentDigest,
      logicalPath: asset.logicalPath,
      mimeType: asset.mediaType,
      extension,
      bytes,
    };
  }

  private async preparedMaterializationFiles(
    content: TemplateContentV1,
    release: TemplateReleaseV1,
    hostBinding?: { operationId: string; planDigest: string },
  ) {
    const files = new Map<string, Uint8Array>();
    for (const asset of content.assets) {
      const checked = await this.checkedRevisionAsset(content, asset.logicalPath);
      files.set(`assets/${asset.logicalPath}`, checked.bytes);
    }
    const guidance =
      `# ${content.title}\n\n${content.description || "Scientific figure reference."}\n\n` +
      `- Template ID: ${content.templateId}\n` +
      `- Revision ID: ${content.revisionId}\n` +
      `- Release ID: ${release.releaseId}\n` +
      `- Asset kind: ${content.assetKind}\n` +
      `- Language: ${content.language}\n` +
      `- Code status: ${content.codeStatus}\n` +
      `- Execution status: ${content.executionStatus}\n\n` +
      `## Guidance\n\n` +
      `- Treat files under \`assets/\` as immutable, untrusted reference material.\n` +
      `- Do not execute code or install dependencies automatically.\n` +
      `- \`not_run\` never means reproduced or verified.\n\n` +
      `## License\n\n${content.license}\n`;
    files.set("TEMPLATE.md", new TextEncoder().encode(guidance));
    const descriptor = {
      schema: "figure-library.materialized-template.v1",
      providerId: "org.scientificfigurelibrary.local",
      selector: {
        templateId: content.templateId,
        revisionId: content.revisionId,
        contentDigest: content.contentDigest,
        releaseId: release.releaseId,
      },
      content,
    };
    files.set(
      "template.json",
      new TextEncoder().encode(`${JSON.stringify(descriptor, null, 2)}\n`),
    );
    const portableInventory = () =>
      [...files.entries()]
        .map(([relativePath, bytes]) => ({
          relativePath,
          bytes: bytes.byteLength,
          sha256: sha256(bytes),
        }))
        .sort((left, right) => compareCanonicalStrings(left.relativePath, right.relativePath));
    const lock = {
      schema: "figure-library.template-lock.v1",
      providerId: "org.scientificfigurelibrary.local",
      selector: {
        templateId: content.templateId,
        revisionId: content.revisionId,
        contentDigest: content.contentDigest,
        releaseId: release.releaseId,
        releaseDigest: release.releaseDigest,
      },
      assetKind: content.assetKind,
      language: content.language,
      codeStatus: content.codeStatus,
      executionStatus: content.executionStatus,
      ...(hostBinding
        ? { operationId: hostBinding.operationId, planDigest: hostBinding.planDigest }
        : {}),
      files: portableInventory().map(({ relativePath, ...entry }) => ({
        file: relativePath,
        ...entry,
      })),
    };
    files.set(
      "template.lock.json",
      new TextEncoder().encode(`${JSON.stringify(lock, null, 2)}\n`),
    );
    return { files, inventory: portableInventory() };
  }

  private async inspectMaterializedDirectory(root: string) {
    const output: MaterializedFileInventoryEntry[] = [];
    const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      for (const entry of entries.sort((left, right) => compareCanonicalStrings(left.name, right.name))) {
        assertPortableFilesystemSegment(entry.name, "materialized path segment");
        const relativePath = relativeDirectory
          ? `${relativeDirectory}/${entry.name}`
          : entry.name;
        const file = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error(`materialized output contains a symbolic link: ${relativePath}`);
        if (entry.isDirectory()) {
          await walk(file, relativePath);
          continue;
        }
        if (!entry.isFile()) throw new Error(`materialized output contains a non-file: ${relativePath}`);
        const bytes = new Uint8Array(await fs.readFile(file));
        output.push({ relativePath, bytes: bytes.byteLength, sha256: sha256(bytes) });
      }
    };
    await walk(root, "");
    return output.sort((left, right) => compareCanonicalStrings(left.relativePath, right.relativePath));
  }

  async planMaterializeRevision(
    options: RevisionMaterializationOptions,
  ): Promise<RevisionMaterializationPlanV1> {
    const templateId = assertSafeSegment(options.templateId, "templateId");
    const revisionId = assertSafeSegment(options.revisionId, "revisionId");
    assertHash(options.contentDigest, "contentDigest");
    const release = await this.releasedRevision(templateId, revisionId, options.contentDigest);
    if (!release) throw new Error("only an exact published revision can be materialized");
    if (options.releaseId && options.releaseId !== release.releaseId) {
      throw new Error("exact materialization releaseId does not match the Published selector");
    }
    if ((options.operationId === undefined) !== (options.planDigest === undefined)) {
      throw new Error("operationId and planDigest must be provided together");
    }
    if (options.operationId) assertSafeSegment(options.operationId, "operationId");
    if (options.planDigest) assertHash(options.planDigest, "planDigest");
    const content = await this.requireContent(templateId, revisionId, options.contentDigest);
    const prepared = await this.preparedMaterializationFiles(
      content,
      release,
      options.operationId && options.planDigest
        ? { operationId: options.operationId, planDigest: options.planDigest }
        : undefined,
    );
    const withoutDigest: Omit<RevisionMaterializationPlanV1, "planDigest"> = {
      schema: MATERIALIZATION_PLAN_SCHEMA,
      planId: generatedId("materialization-plan"),
      templateId,
      revisionId,
      contentDigest: content.contentDigest,
      releaseId: release.releaseId,
      releaseDigest: release.releaseDigest,
      destination: path.resolve(options.destination),
      targetName: templateId,
      expectedTargetAbsent: true,
      fileInventory: prepared.inventory,
      ...(options.operationId ? { hostOperationId: options.operationId } : {}),
      ...(options.planDigest ? { hostPlanDigest: options.planDigest } : {}),
      createdAt: nowIso(),
    };
    return { ...withoutDigest, planDigest: sha256(canonicalJson(withoutDigest)) };
  }

  private validateMaterializationPlan(plan: RevisionMaterializationPlanV1) {
    if (!isRecord(plan) || plan.schema !== MATERIALIZATION_PLAN_SCHEMA) {
      throw new Error("invalid materialization plan schema");
    }
    const { planDigest: digest, ...withoutDigest } = plan;
    assertSafeSegment(plan.planId, "materialization planId");
    assertSafeSegment(plan.templateId, "templateId");
    assertSafeSegment(plan.revisionId, "revisionId");
    assertSafeSegment(plan.releaseId, "releaseId");
    assertHash(plan.contentDigest, "contentDigest");
    assertHash(plan.releaseDigest, "releaseDigest");
    assertHash(digest, "materialization planDigest");
    if (
      sha256(canonicalJson(withoutDigest)) !== digest ||
      !path.isAbsolute(plan.destination) ||
      plan.targetName !== plan.templateId ||
      plan.expectedTargetAbsent !== true ||
      !Array.isArray(plan.fileInventory) ||
      !plan.fileInventory.length
    ) {
      throw new Error("invalid materialization plan");
    }
    if ((plan.hostOperationId === undefined) !== (plan.hostPlanDigest === undefined)) {
      throw new Error("invalid host materialization binding");
    }
    if (plan.hostOperationId) assertSafeSegment(plan.hostOperationId, "host operationId");
    if (plan.hostPlanDigest) assertHash(plan.hostPlanDigest, "host planDigest");
    let previous = "";
    for (const entry of plan.fileInventory) {
      const relativePath = validateRevisionAssetPath(entry.relativePath);
      if (
        relativePath !== entry.relativePath ||
        (previous && compareCanonicalStrings(previous, relativePath) >= 0) ||
        !Number.isSafeInteger(entry.bytes) ||
        entry.bytes < 0
      ) {
        throw new Error("invalid materialization plan inventory");
      }
      assertHash(entry.sha256, "materialization file digest");
      previous = relativePath;
    }
  }

  async applyMaterializeRevision(
    plan: RevisionMaterializationPlanV1,
    operationId: string,
  ): Promise<RevisionMaterializationResult> {
    this.validateMaterializationPlan(plan);
    const safeOperationId = assertSafeSegment(operationId, "operationId");
    if (plan.hostOperationId && plan.hostOperationId !== safeOperationId) {
      throw new Error("materialization operationId does not match its host plan binding");
    }
    const receiptFile = path.join(
      this.operationsDirectory,
      "receipts",
      "materializations",
      `${safeOperationId}.json`,
    );
    const target = path.join(plan.destination, plan.targetName);
    const readReceipt = async () => {
      try {
        const value = await readJson(receiptFile);
        if (
          !isRecord(value) ||
          value.schema !== MATERIALIZATION_RECEIPT_SCHEMA ||
          value.operationId !== safeOperationId ||
          value.planDigest !== plan.planDigest ||
          value.planId !== plan.planId
        ) {
          throw new Error(`operationId was used for a different materialization: ${safeOperationId}`);
        }
        return value as unknown as RevisionMaterializationReceiptV1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    };
    return this.withWriteLock(`materialize:${safeOperationId}`, async () => {
      const prior = await readReceipt();
      const release = await this.requirePublishedRelease(plan.templateId, plan.releaseId);
      if (
        release.revisionId !== plan.revisionId ||
        release.contentDigest !== plan.contentDigest ||
        release.releaseDigest !== plan.releaseDigest
      ) {
        throw new Error("stale materialization plan: Published Release changed or is unreachable");
      }
      const content = await this.requireContent(plan.templateId, plan.revisionId, plan.contentDigest);
      const prepared = await this.preparedMaterializationFiles(
        content,
        release,
        plan.hostOperationId && plan.hostPlanDigest
          ? { operationId: plan.hostOperationId, planDigest: plan.hostPlanDigest }
          : undefined,
      );
      if (canonicalJson(prepared.inventory) !== canonicalJson(plan.fileInventory)) {
        throw new Error("stale materialization plan: prepared file inventory changed");
      }
      let targetExists = false;
      try {
        const stat = await fs.lstat(target);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`target is not a directory: ${target}`);
        targetExists = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (targetExists) {
        const observed = await this.inspectMaterializedDirectory(target);
        if (canonicalJson(observed) !== canonicalJson(plan.fileInventory)) {
          throw new Error(`target already exists with different contents: ${target}`);
        }
        if (!prior) {
          // A verified target without a receipt is the recoverable state after rename.
        }
      } else {
        if (prior) throw new Error(`materialization receipt exists but target is missing: ${target}`);
        await fs.mkdir(plan.destination, { recursive: true });
        const staging = path.join(
          plan.destination,
          `.figure-library-${plan.templateId}-${randomUUID()}.tmp`,
        );
        await fs.mkdir(staging);
        try {
          for (const [relativePath, bytes] of prepared.files) {
            await makeReadOnly(resolveContained(staging, relativePath), bytes);
          }
          await fs.rename(staging, target);
        } catch (error) {
          await fs.rm(staging, { recursive: true, force: true });
          throw error;
        }
      }
      const receipt: RevisionMaterializationReceiptV1 = prior ?? {
        schema: MATERIALIZATION_RECEIPT_SCHEMA,
        receiptId: `materialization-receipt-${randomUUID()}`,
        operationId: safeOperationId,
        planId: plan.planId,
        planDigest: plan.planDigest,
        templateId: plan.templateId,
        revisionId: plan.revisionId,
        contentDigest: plan.contentDigest,
        releaseId: plan.releaseId,
        fileInventoryDigest: sha256(canonicalJson(plan.fileInventory)),
        appliedAt: nowIso(),
      };
      if (!prior) await immutableWriteJson(receiptFile, receipt);
      return {
        target,
        materializationSource: "versioned-library",
        templateId: plan.templateId,
        revisionId: plan.revisionId,
        contentDigest: plan.contentDigest,
        releaseId: plan.releaseId,
        files: plan.fileInventory.map((entry) => entry.relativePath),
        operationId: safeOperationId,
        idempotentReplay: Boolean(prior || targetExists),
      };
    });
  }

  async materializeRevision(
    options: RevisionMaterializationOptions,
  ): Promise<RevisionMaterializationResult> {
    const plan = await this.planMaterializeRevision(options);
    return this.applyMaterializeRevision(
      plan,
      options.operationId ?? generatedId("materialize"),
    );
  }

  async planCreateWorking(options: {
    templateId?: string;
    candidate: VersionedTemplateCandidate;
    assessment?: ReviewAssessmentInput;
  }): Promise<WorkingRevisionPlan> {
    const templateId = assertSafeSegment(options.templateId ?? generatedId("template"), "templateId");
    await this.assertNoTemplateIdCaseCollision(templateId);
    const series = await this.getSeries(templateId);
    if (series?.status === "archived") throw new Error(`template series is archived: ${templateId}`);
    if (series?.workingHead) throw new Error(`template already has a working head: ${templateId}`);
    if (!series && (await exists(path.join(this.legacyTemplateDirectory(templateId), "template.json")))) {
      throw new Error(`legacy template requires explicit adoption before versioned writes: ${templateId}`);
    }
    const createdAt = nowIso();
    const prepared = await prepareCandidate({
      templateId,
      revisionId: generatedId("revision"),
      reviewId: generatedId("review"),
      createdAt,
      ...(series?.publishedHead ? { parentRevisionId: series.publishedHead.revisionId } : {}),
      candidate: options.candidate,
      assessment: options.assessment,
    });
    return withPlanDigest({
      schema: LIFECYCLE_PLAN_SCHEMA,
      action: "create_working",
      templateId,
      expectedSeriesDigest: series ? templateSeriesDigest(series) : null,
      ...(this.runtimeContext ? { libraryContext: this.runtimeContext } : {}),
      createdAt,
      content: prepared.content,
      review: prepared.review,
      assetSources: prepared.sources,
    });
  }

  async planUpdateWorking(options: {
    templateId: string;
    candidate: VersionedTemplateCandidate;
    assessment?: ReviewAssessmentInput;
  }): Promise<WorkingRevisionPlan> {
    const series = await this.requireSeries(options.templateId);
    if (series.status === "archived") throw new Error(`template series is archived: ${options.templateId}`);
    const working = series.workingHead;
    if (!working) throw new Error(`template has no working head: ${options.templateId}`);
    const createdAt = nowIso();
    const prepared = await prepareCandidate({
      templateId: options.templateId,
      revisionId: generatedId("revision"),
      reviewId: generatedId("review"),
      createdAt,
      parentRevisionId: working.revisionId,
      previousReviewId: working.reviewId,
      candidate: options.candidate,
      assessment: options.assessment,
    });
    return withPlanDigest({
      schema: LIFECYCLE_PLAN_SCHEMA,
      action: "update_working",
      templateId: options.templateId,
      expectedSeriesDigest: templateSeriesDigest(series),
      ...(this.runtimeContext ? { libraryContext: this.runtimeContext } : {}),
      createdAt,
      content: prepared.content,
      review: prepared.review,
      assetSources: prepared.sources,
    });
  }

  async planGateUpdate(options: {
    templateId: string;
    decisions: GateDecision[];
  }): Promise<GateUpdatePlan> {
    if (!options.decisions.length) throw new Error("at least one gate decision is required");
    const series = await this.requireSeries(options.templateId);
    const working = series.workingHead;
    if (!working) throw new Error(`template has no working head: ${options.templateId}`);
    const previous = await this.requireReview(options.templateId, working.reviewId);
    if (previous.revisionId !== working.revisionId || previous.reviewDigest !== working.reviewDigest) {
      throw new Error("working head does not match its review snapshot");
    }
    const decisions = new Map<string, GateDecision>();
    for (const decision of options.decisions) {
      const gateId = normalizedText(decision.gateId);
      const note = normalizedText(decision.note);
      if (decision.decision !== "resolved" && decision.decision !== "reopen") {
        throw new Error(`invalid gate decision: ${String(decision.decision)}`);
      }
      if (!gateId || !note) throw new Error("gate decisions require gateId and note");
      if (decisions.has(gateId)) throw new Error(`duplicate gate decision: ${gateId}`);
      decisions.set(gateId, { ...decision, gateId, note });
    }
    for (const gateId of decisions.keys()) {
      if (!previous.blockingGates.some((gate) => gate.gateId === gateId)) {
        throw new Error(`unknown blocking gate: ${gateId}`);
      }
    }
    const createdAt = nowIso();
    const reviewWithoutDigest: Omit<ReviewSnapshotV1, "reviewDigest"> = {
      schema: REVIEW_SNAPSHOT_SCHEMA,
      templateId: options.templateId,
      reviewId: generatedId("review"),
      revisionId: working.revisionId,
      previousReviewId: previous.reviewId,
      createdAt,
      validationErrors: previous.validationErrors,
      blockingGates: previous.blockingGates.map((gate) => {
        const decision = decisions.get(gate.gateId);
        if (!decision) return gate;
        if (decision.decision === "reopen") {
          const { resolution: _resolution, ...openGate } = gate;
          return { ...openGate, status: "open" as const };
        }
        return {
          ...gate,
          status: "resolved" as const,
          resolution: { decision: "resolved" as const, decidedAt: createdAt, note: decision.note, source: "user" as const },
        };
      }),
      warnings: previous.warnings,
    };
    const review = { ...reviewWithoutDigest, reviewDigest: digestReview(reviewWithoutDigest) };
    return withPlanDigest({
      schema: LIFECYCLE_PLAN_SCHEMA,
      action: "update_gates",
      templateId: options.templateId,
      expectedSeriesDigest: templateSeriesDigest(series),
      ...(this.runtimeContext ? { libraryContext: this.runtimeContext } : {}),
      createdAt,
      review,
    });
  }

  async validateRuntimeClosure(content: TemplateContentV1) {
    if (content.assetKind !== "plot_template") return;
    const r = normalizeRuntimeClosure(content.runtime, new Map(content.assets.map(a=>[a.logicalPath,a])), content.canonicalImplementation?.assetPath, content.primaryPreview);
    if (!r) {
      const canonicalPath = content.canonicalImplementation?.assetPath;
      if (!canonicalPath) return;
      const loaded = await this.readAsset({templateId:content.templateId, revisionId:content.revisionId,contentDigest:content.contentDigest,logicalPath:canonicalPath});
      const reads = inspectRuntimeReads(new TextDecoder().decode(loaded.bytes));
      if (reads.length) {
        const first = reads.find((read) => read.kind === "data") ?? reads[0]!;
        throw new Error(`cannot publish Local Published release: ${content.templateId}/${canonicalPath} requires an explicit runtime closure for ${first.path ?? first.expression} at line ${first.line}`);
      }
      return;
    }
    const paths = [...r.inputs.map(i=>i.codePath), ...(r.dependencies ?? []).map(i=>i.codePath)];
    for (const assetPath of [r.entrypoint,...(r.dependencies ?? []).map(i=>i.assetPath)]) {
      const loaded = await this.readAsset({templateId:content.templateId, revisionId:content.revisionId,contentDigest:content.contentDigest,logicalPath:assetPath});
      assertRuntimeReads(new TextDecoder().decode(loaded.bytes), paths, `${content.templateId}/${content.revisionId}/${assetPath}`);
    }
  }

  async planPublish(options: { templateId: string }): Promise<PublishPlan> {
    const series = await this.requireSeries(options.templateId);
    if (series.status === "archived") throw new Error(`template series is archived: ${options.templateId}`);
    const working = series.workingHead;
    if (!working) throw new Error(`template has no working head: ${options.templateId}`);
    const [content, review] = await Promise.all([
      this.requireContent(options.templateId, working.revisionId, working.contentDigest),
      this.requireReview(options.templateId, working.reviewId),
    ]);
    if (review.revisionId !== content.revisionId || review.reviewDigest !== working.reviewDigest) {
      throw new Error("working content and review snapshot do not match");
    }
    if (review.validationErrors.length) {
      throw new Error(`cannot publish with validation errors: ${review.validationErrors.map((item) => item.code).join(", ")}`);
    }
    const openGates = review.blockingGates.filter((gate) => gate.status === "open");
    if (openGates.length) {
      throw new Error(`cannot publish with blocking review gates: ${openGates.map((gate) => gate.gateId).join(", ")}`);
    }
    await this.validateRuntimeClosure(content);
    const publishedAt = nowIso();
    const releaseWithoutDigest: Omit<TemplateReleaseV1, "releaseDigest"> = {
      schema: TEMPLATE_RELEASE_SCHEMA,
      templateId: options.templateId,
      releaseId: generatedId("release"),
      revisionId: content.revisionId,
      contentDigest: content.contentDigest,
      reviewId: review.reviewId,
      reviewDigest: review.reviewDigest,
      publishedAt,
      ...(series.publishedHead ? { previousReleaseId: series.publishedHead.releaseId } : {}),
      ...(content.restoredFromReleaseId ? { restoredFromReleaseId: content.restoredFromReleaseId } : {}),
    };
    return withPlanDigest({
      schema: LIFECYCLE_PLAN_SCHEMA,
      action: "publish",
      templateId: options.templateId,
      expectedSeriesDigest: templateSeriesDigest(series),
      ...(this.runtimeContext ? { libraryContext: this.runtimeContext } : {}),
      createdAt: publishedAt,
      release: { ...releaseWithoutDigest, releaseDigest: digestRelease(releaseWithoutDigest) },
    });
  }

  async planDiscardWorking(options: { templateId: string }): Promise<DiscardWorkingPlan> {
    const series = await this.requireSeries(options.templateId);
    if (!series.workingHead) throw new Error(`template has no working head: ${options.templateId}`);
    const createdAt = nowIso();
    return withPlanDigest({
      schema: LIFECYCLE_PLAN_SCHEMA,
      action: "discard_working",
      templateId: options.templateId,
      expectedSeriesDigest: templateSeriesDigest(series),
      ...(this.runtimeContext ? { libraryContext: this.runtimeContext } : {}),
      createdAt,
      discardedRevisionId: series.workingHead.revisionId,
    });
  }

  async planRestoreRelease(options: { templateId: string; releaseId: string }): Promise<WorkingRevisionPlan> {
    const series = await this.requireSeries(options.templateId);
    if (series.status === "archived") throw new Error(`template series is archived: ${options.templateId}`);
    if (series.workingHead) throw new Error(`template already has a working head: ${options.templateId}`);
    const sourceRelease = await this.requirePublishedRelease(options.templateId, options.releaseId);
    const [source, priorReview] = await Promise.all([
      this.requireContent(options.templateId, sourceRelease.revisionId, sourceRelease.contentDigest),
      this.requireReview(options.templateId, sourceRelease.reviewId),
    ]);
    const createdAt = nowIso();
    const revisionId = generatedId("revision");
    const contentWithoutDigest: Omit<TemplateContentV1, "contentDigest"> = {
      ...source,
      revisionId,
      validationState: effectiveValidationState(source),
      ...(series.publishedHead ? { parentRevisionId: series.publishedHead.revisionId } : {}),
      restoredFromReleaseId: sourceRelease.releaseId,
      createdAt,
    };
    delete (contentWithoutDigest as Partial<TemplateContentV1>).contentDigest;
    if (!series.publishedHead) delete (contentWithoutDigest as Partial<TemplateContentV1>).parentRevisionId;
    const content: TemplateContentV1 = { ...contentWithoutDigest, contentDigest: digestContent(contentWithoutDigest) };
    const reviewWithoutDigest: Omit<ReviewSnapshotV1, "reviewDigest"> = {
      schema: REVIEW_SNAPSHOT_SCHEMA,
      templateId: options.templateId,
      reviewId: generatedId("review"),
      revisionId,
      createdAt,
      validationErrors: [],
      blockingGates: [
        {
          gateId: "review-restored-release",
          code: "restored_release_review_required",
          message: "A restored historical release must be reviewed before it can be republished",
          source: "rule",
          status: "open",
        },
      ],
      warnings: priorReview.warnings,
    };
    const assetSources = source.assets.map((asset) => ({
      logicalPath: asset.logicalPath,
      sourcePath: resolveContained(this.revisionDirectory(options.templateId, source.revisionId), asset.file),
    }));
    return withPlanDigest({
      schema: LIFECYCLE_PLAN_SCHEMA,
      action: "restore_release",
      templateId: options.templateId,
      expectedSeriesDigest: templateSeriesDigest(series),
      ...(this.runtimeContext ? { libraryContext: this.runtimeContext } : {}),
      createdAt,
      content,
      review: { ...reviewWithoutDigest, reviewDigest: digestReview(reviewWithoutDigest) },
      assetSources,
    });
  }

  private async checkedLegacyStored(directory: string, stored: LegacyStoredFile) {
    const file = resolveContained(directory, stored.file);
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`legacy asset is not a regular file: ${stored.file}`);
    if (stat.size !== stored.bytes) throw new Error(`legacy asset size mismatch: ${stored.file}`);
    const bytes = new Uint8Array(await fs.readFile(file));
    if (sha256(bytes) !== stored.sha256) throw new Error(`legacy asset checksum mismatch: ${stored.file}`);
    return file;
  }

  async planAdoptLegacy(options: LegacyAdoptionOptions): Promise<LegacyAdoptionPlan> {
    const templateId = assertSafeSegment(options.templateId, "templateId");
    await this.assertNoTemplateIdCaseCollision(templateId);
    if (await this.getSeries(templateId)) throw new Error(`template already has a versioned series: ${templateId}`);
    const directory = this.legacyTemplateDirectory(templateId, options.migrationBindingId);
    const sourceRelativeDirectory = options.migrationBindingId
      ? `store/migrations/flat-v1/${assertSafeSegment(options.migrationBindingId, "migrationBindingId")}/source/templates/${templateId}`
      : `templates/${templateId}`;
    const manifestFile = path.join(directory, "template.json");
    const manifestText = await fs.readFile(manifestFile, "utf8");
    const legacy = parseLegacyTemplate(JSON.parse(manifestText) as unknown, templateId);
    const assetKind = legacy.assetKind ?? (legacy.code.length ? "plot_template" : "visual_reference");
    const codeStatus = legacy.codeStatus ?? (legacy.code.length ? "reviewed" : "none");
    const assets: RevisionAssetInput[] = [];
    const legacyToCanonical = new Map<string, string>();
    if (legacy.preview) {
      const logicalPath = `visuals/source/${path.posix.basename(legacy.preview.file)}`;
      legacyToCanonical.set(legacy.preview.file, logicalPath);
      assets.push({
        logicalPath,
        role: "visual",
        visualRole: "source_reference",
        mediaType: legacy.preview.mediaType,
        sourcePath: await this.checkedLegacyStored(directory, legacy.preview),
        origin: { kind: "legacy_preview", legacyFile: legacy.preview.file },
      });
    }
    for (const stored of legacy.code) {
      const suffix = stored.file.startsWith("code/") ? stored.file.slice("code/".length) : stored.file;
      const logicalPath = `code/${suffix}`;
      legacyToCanonical.set(stored.file, logicalPath);
      assets.push({
        logicalPath,
        role: "code",
        codeOrigin: "user_supplied",
        sourcePath: await this.checkedLegacyStored(directory, stored),
        origin: { kind: "legacy_code", legacyFile: stored.file },
      });
    }
    for (const stored of legacy.references ?? []) {
      const suffix = stored.file.startsWith("reference/")
        ? stored.file.slice("reference/".length)
        : stored.file;
      const logicalPath = `references/${suffix}`;
      legacyToCanonical.set(stored.file, logicalPath);
      assets.push({
        logicalPath,
        role: "reference",
        sourcePath: await this.checkedLegacyStored(directory, stored),
        origin: { kind: `legacy_${stored.role}`, legacyFile: stored.file },
      });
    }
    const legacyCanonicalPath = options.canonicalImplementationAssetPath
      ? validateRevisionAssetPath(options.canonicalImplementationAssetPath)
      : undefined;
    const canonicalPath = legacyCanonicalPath
      ? legacyToCanonical.get(legacyCanonicalPath) ?? legacyCanonicalPath
      : undefined;
    if (assetKind === "plot_template") {
      if (!canonicalPath) {
        throw new Error("explicit legacy adoption of a plot template requires canonicalImplementationAssetPath");
      }
      if (!legacy.code.some((item) => legacyToCanonical.get(item.file) === canonicalPath)) {
        throw new Error("legacy canonicalImplementationAssetPath must reference a code asset");
      }
    } else if (canonicalPath) {
      throw new Error("a visual_reference cannot select a canonical implementation");
    }
    const createdAt = nowIso();
    const candidate: VersionedTemplateCandidate = {
      title: legacy.title,
      description: legacy.description,
      tags: legacy.tags,
      visualProfile: legacy.visualProfile,
      dataProfile: legacy.dataProfile,
      ...(legacy.application ? { application: legacy.application } : {}),
      ...(legacy.scientificQuestion ? { scientificQuestion: legacy.scientificQuestion } : {}),
      packages: legacy.packages,
      license: legacy.license,
      assetKind,
      language: legacy.language,
      plotFamily: legacy.plotFamily,
      codeStatus,
      executionStatus: "not_run",
      ...(legacy.preview ? { primaryPreview: legacyToCanonical.get(legacy.preview.file)! } : {}),
      ...(canonicalPath ? { canonicalImplementation: { assetPath: canonicalPath, selectedBy: "user" } } : {}),
      ...(legacy.preview && legacy.code.length
        ? {
            figureCodeLinks: [
              {
                visualAssetPath: legacyToCanonical.get(legacy.preview.file)!,
                codeAssetPaths: legacy.code.map((item) => legacyToCanonical.get(item.file)!),
                relationship: "user_supplied_pair" as const,
                confirmedBy: "user" as const,
                evidence: "The user explicitly preserved the legacy manifest's co-located preview/code association during adoption.",
              },
            ],
          }
        : {}),
      ...(legacy.provenance !== undefined ? { provenance: legacy.provenance } : {}),
      annotations: {
        migration: {
          legacySchema: "figure-library.template.v1",
          importedAt: legacy.importedAt,
          ...(legacy.registry !== undefined ? { registry: legacy.registry } : {}),
        },
      },
      visualGrouping: {
        visualAssetPaths: legacy.preview
          ? [legacyToCanonical.get(legacy.preview.file)!]
          : [],
        confirmedBy: "user",
        note: "The user explicitly confirmed the legacy Figure Unit boundary during adoption.",
      },
      assets,
    };
    const prepared = await prepareCandidate({
      templateId,
      revisionId: generatedId("revision"),
      reviewId: generatedId("review"),
      createdAt,
      candidate,
      assessment: {
        warnings: [
          {
            code: "legacy_execution_unverified",
            message: "Legacy adoption preserves assets but does not execute or reproduce the figure",
            source: "migration",
          },
        ],
      },
    });
    const reviewStatus = legacy.reviewStatus ?? "approved";
    let release: TemplateReleaseV1 | undefined;
    if (reviewStatus === "approved") {
      if (prepared.review.validationErrors.length || prepared.review.blockingGates.some((gate) => gate.status === "open")) {
        throw new Error("an approved legacy template cannot be adopted as published until validation errors and gates are resolved");
      }
      const releaseWithoutDigest: Omit<TemplateReleaseV1, "releaseDigest"> = {
        schema: TEMPLATE_RELEASE_SCHEMA,
        templateId,
        releaseId: generatedId("release"),
        revisionId: prepared.content.revisionId,
        contentDigest: prepared.content.contentDigest,
        reviewId: prepared.review.reviewId,
        reviewDigest: prepared.review.reviewDigest,
        publishedAt: createdAt,
      };
      release = { ...releaseWithoutDigest, releaseDigest: digestRelease(releaseWithoutDigest) };
    }
    return withPlanDigest({
      schema: LIFECYCLE_PLAN_SCHEMA,
      action: "adopt_legacy",
      templateId,
      expectedSeriesDigest: null,
      ...(this.runtimeContext ? { libraryContext: this.runtimeContext } : {}),
      createdAt,
      migrationId: generatedId("migration"),
      legacy: {
        sourceRelativeDirectory,
        legacyManifestSha256: sha256(manifestText),
        legacyReviewStatus: reviewStatus,
        content: prepared.content,
        review: prepared.review,
        ...(release ? { release } : {}),
        assetSources: prepared.sources,
      },
    });
  }

  private validateLifecyclePlan(plan: LifecyclePlan) {
    if (!isRecord(plan) || plan.schema !== LIFECYCLE_PLAN_SCHEMA) throw new Error("invalid lifecycle plan schema");
    const actions: LifecyclePlanAction[] = [
      "create_working",
      "update_working",
      "update_gates",
      "publish",
      "discard_working",
      "restore_release",
      "adopt_legacy",
    ];
    if (typeof plan.action !== "string" || !actions.includes(plan.action as LifecyclePlanAction)) {
      throw new Error(`invalid lifecycle plan action: ${String(plan.action)}`);
    }
    assertSafeSegment(plan.templateId, "templateId");
    assertString(plan.createdAt, "plan createdAt");
    if (plan.expectedSeriesDigest !== null) assertHash(plan.expectedSeriesDigest, "expected series digest");
    if (plan.libraryContext !== undefined) {
      const context = validateLibraryOperationContextValue(plan.libraryContext);
      assertLibraryOperationContext(this.runtimeContext, context);
    }
    assertHash(plan.planDigest, "plan digest");
    if (planDigest(plan) !== plan.planDigest) throw new Error("lifecycle plan digest mismatch");
    if (plan.action === "create_working" || plan.action === "update_working" || plan.action === "restore_release") {
      const content = validateContentValue(plan.content, plan.templateId, plan.content.revisionId);
      const review = validateReviewValue(plan.review, plan.templateId, plan.review.reviewId);
      if (review.revisionId !== content.revisionId) throw new Error("planned review does not target planned content");
      if (!Array.isArray(plan.assetSources)) throw new Error("invalid planned asset sources");
      const sourcePaths = plan.assetSources.map((item) => validateRevisionAssetPath(item.logicalPath)).sort();
      const assetPaths = content.assets.map((item) => item.logicalPath).sort();
      if (canonicalJson(sourcePaths) !== canonicalJson(assetPaths)) throw new Error("planned asset sources do not match content inventory");
    } else if (plan.action === "update_gates") {
      validateReviewValue(plan.review, plan.templateId, plan.review.reviewId);
    } else if (plan.action === "publish") {
      validateReleaseValue(plan.release, plan.templateId, plan.release.releaseId);
    } else if (plan.action === "discard_working") {
      assertSafeSegment(plan.discardedRevisionId, "discardedRevisionId");
    } else if (plan.action === "adopt_legacy") {
      assertSafeSegment(plan.migrationId, "migrationId");
      const legacySource = validateRevisionAssetPath(`${plan.legacy.sourceRelativeDirectory}/template.json`);
      if (!legacySource.endsWith("/template.json")) throw new Error("invalid legacy source directory");
      assertHash(plan.legacy.legacyManifestSha256, "legacy manifest digest");
      if (!["draft", "approved", "archived"].includes(plan.legacy.legacyReviewStatus)) {
        throw new Error("invalid legacy review status");
      }
      const content = validateContentValue(plan.legacy.content, plan.templateId, plan.legacy.content.revisionId);
      const review = validateReviewValue(plan.legacy.review, plan.templateId, plan.legacy.review.reviewId);
      if (review.revisionId !== content.revisionId) throw new Error("legacy review does not target adopted content");
      const sourcePaths = plan.legacy.assetSources.map((item) => validateRevisionAssetPath(item.logicalPath)).sort();
      const assetPaths = content.assets.map((item) => item.logicalPath).sort();
      if (canonicalJson(sourcePaths) !== canonicalJson(assetPaths)) throw new Error("legacy asset sources do not match content inventory");
      const release = plan.legacy.release;
      if (plan.legacy.legacyReviewStatus === "approved" && !release) throw new Error("approved legacy adoption requires a release");
      if (plan.legacy.legacyReviewStatus !== "approved" && release) throw new Error("only approved legacy adoption can contain a release");
      if (release) {
        validateReleaseValue(release, plan.templateId, release.releaseId);
        if (
          release.revisionId !== content.revisionId ||
          release.contentDigest !== content.contentDigest ||
          release.reviewId !== review.reviewId ||
          release.reviewDigest !== review.reviewDigest ||
          review.validationErrors.length ||
          review.blockingGates.some((gate) => gate.status === "open")
        ) {
          throw new Error("legacy release does not match publishable adopted content");
        }
      }
    }
  }

  private async verifyRevisionOnDisk(content: TemplateContentV1) {
    const stored = await this.requireContent(content.templateId, content.revisionId, content.contentDigest);
    if (canonicalJson(stored) !== canonicalJson(content)) throw new Error(`immutable revision collision: ${content.revisionId}`);
    for (const asset of stored.assets) await this.checkedRevisionAsset(stored, asset.logicalPath);
  }

  private async writePreparedRevision(
    content: TemplateContentV1,
    assetSources: PreparedAssetSource[],
  ) {
    const target = this.revisionDirectory(content.templateId, content.revisionId);
    if (await exists(target)) {
      await this.verifyRevisionOnDisk(content);
      return;
    }
    const parent = path.dirname(target);
    await fs.mkdir(parent, { recursive: true });
    const staging = path.join(parent, `.${content.revisionId}.${randomUUID()}.tmp`);
    await fs.mkdir(staging);
    try {
      const sourceMap = new Map(assetSources.map((source) => [source.logicalPath, source]));
      for (const asset of content.assets) {
        const source = sourceMap.get(asset.logicalPath);
        if (!source) throw new Error(`missing prepared asset source: ${asset.logicalPath}`);
        const bytes = await bytesForPreparedSource(source, asset);
        await makeReadOnly(resolveContained(staging, asset.file), bytes);
      }
      await fs.writeFile(path.join(staging, "content.json"), `${JSON.stringify(content, null, 2)}\n`, { flag: "wx" });
      await fs.chmod(path.join(staging, "content.json"), 0o444).catch(() => undefined);
      await fs.rename(staging, target);
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  private importReceiptForContent(content: TemplateContentV1, committedAt: string) {
    const binding = content.intakeBinding;
    if (!binding) return undefined;
    const sourceManifestDigest = sha256(canonicalJson(binding.sourceManifest));
    const receiptId = `import-receipt-${sha256(canonicalJson({
      adapterId: binding.adapterId,
      importId: binding.importId,
      templateId: content.templateId,
      revisionId: content.revisionId,
      contentDigest: content.contentDigest,
      sourceManifestDigest,
    })).slice(0, 24)}`;
    const receipt: ImportReceiptV1 = {
      schema: IMPORT_RECEIPT_SCHEMA,
      receiptId,
      adapterId: binding.adapterId,
      importId: binding.importId,
      sourceManifestDigest,
      templateId: content.templateId,
      revisionId: content.revisionId,
      contentDigest: content.contentDigest,
      requiredAssetSha256: [...binding.requiredAssetSha256],
      assetInventory: content.assets.map(({ logicalPath, role, bytes, sha256: digest }) => ({
        logicalPath,
        role,
        bytes,
        sha256: digest,
      })),
      committedAt,
      selfContained: true,
    };
    return receipt;
  }

  private importDirectory(adapterId: string, importId: string) {
    return path.join(
      this.importsDirectory,
      assertSafeSegment(adapterId, "adapterId"),
      assertSafeSegment(importId, "importId"),
    );
  }

  private importReceiptDirectory(receipt: ImportReceiptV1) {
    return path.join(
      this.importDirectory(receipt.adapterId, receipt.importId),
      "receipts",
      assertSafeSegment(receipt.receiptId, "receiptId"),
    );
  }

  private async writeImportReceipt(receipt: ImportReceiptV1, sourceManifest: JsonValue) {
    const directory = this.importReceiptDirectory(receipt);
    if (sha256(canonicalJson(sourceManifest)) !== receipt.sourceManifestDigest) {
      throw new Error("import source manifest digest mismatch");
    }
    await immutableWriteJson(path.join(directory, "source-manifest.json"), sourceManifest);
    await immutableWriteJson(path.join(directory, "receipt.json"), receipt);
  }

  async listImportReceipts(adapterId?: string, importId?: string): Promise<ImportReceiptV1[]> {
    if (importId && !adapterId) throw new Error("importId filter requires adapterId");
    const roots: string[] = [];
    if (adapterId && importId) {
      roots.push(this.importDirectory(adapterId, importId));
    } else {
      let adapters: import("node:fs").Dirent[];
      try {
        adapters = await fs.readdir(this.importsDirectory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      for (const adapter of adapters) {
        if (!adapter.isDirectory() || !isSafeSegment(adapter.name)) continue;
        if (adapterId && adapter.name !== assertSafeSegment(adapterId, "adapterId")) continue;
        const adapterRoot = path.join(this.importsDirectory, adapter.name);
        const imports = await fs.readdir(adapterRoot, { withFileTypes: true });
        roots.push(
          ...imports
            .filter((entry) => entry.isDirectory() && isSafeSegment(entry.name))
            .map((entry) => path.join(adapterRoot, entry.name)),
        );
      }
    }
    const receiptRoots: Array<{ directory: string; importRoot: string; legacy: boolean }> = [];
    for (const importRoot of roots) {
      try {
        const legacy = await fs.lstat(path.join(importRoot, "receipt.json"));
        if (legacy.isFile() && !legacy.isSymbolicLink()) {
          receiptRoots.push({ directory: importRoot, importRoot, legacy: true });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      try {
        const entries = await fs.readdir(path.join(importRoot, "receipts"), {
          withFileTypes: true,
        });
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.isSymbolicLink() || !isSafeSegment(entry.name)) {
            continue;
          }
          receiptRoots.push({
            directory: path.join(importRoot, "receipts", entry.name),
            importRoot,
            legacy: false,
          });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const output: ImportReceiptV1[] = [];
    for (const root of receiptRoots) {
      let value: unknown;
      let sourceManifest: unknown;
      try {
        value = await readJson(path.join(root.directory, "receipt.json"));
        sourceManifest = await readJson(path.join(root.directory, "source-manifest.json"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      const receipt = this.validateImportReceiptValue(value);
      if (
        path.basename(root.importRoot) !== receipt.importId ||
        path.basename(path.dirname(root.importRoot)) !== receipt.adapterId ||
        (!root.legacy && path.basename(root.directory) !== receipt.receiptId) ||
        sha256(canonicalJson(sourceManifest)) !== receipt.sourceManifestDigest
      ) {
        throw new Error(`import receipt path or source manifest mismatch: ${receipt.receiptId}`);
      }
      const content = await this.getContent(
        receipt.templateId,
        receipt.revisionId,
        receipt.contentDigest,
      );
      const binding = content?.intakeBinding;
      const expectedReceipt = content
        ? this.importReceiptForContent(content, receipt.committedAt)
        : undefined;
      const expectedInventory = content?.assets.map(
        ({ logicalPath, role, bytes, sha256: digest }) => ({
          logicalPath,
          role,
          bytes,
          sha256: digest,
        }),
      );
      if (
        !content ||
        !binding ||
        canonicalJson(expectedReceipt ?? null) !== canonicalJson(receipt) ||
        binding.adapterId !== receipt.adapterId ||
        binding.importId !== receipt.importId ||
        canonicalJson(binding.sourceManifest) !== canonicalJson(sourceManifest) ||
        canonicalJson([...binding.requiredAssetSha256].sort()) !==
          canonicalJson([...receipt.requiredAssetSha256].sort()) ||
        canonicalJson(expectedInventory) !== canonicalJson(receipt.assetInventory)
      ) {
        throw new Error(`import receipt does not match its immutable Revision: ${receipt.receiptId}`);
      }
      const inventoryHashes = new Set(content.assets.map((asset) => asset.sha256));
      if (binding.requiredAssetSha256.some((digest) => !inventoryHashes.has(digest))) {
        throw new Error(`import receipt Revision is missing a selected asset: ${receipt.receiptId}`);
      }
      for (const asset of content.assets) {
        await this.checkedRevisionAsset(content, asset.logicalPath);
      }
      output.push(receipt);
    }
    return output.sort(
      (left, right) =>
        compareCanonicalStrings(left.committedAt, right.committedAt) ||
        compareCanonicalStrings(left.receiptId, right.receiptId),
    );
  }

  private validateOperationResult(
    value: unknown,
    expected: {
      operationId: string;
      action: LifecyclePlanAction;
      templateId: string;
    },
  ): Omit<LifecycleApplyResult, "idempotentReplay"> {
    if (!isRecord(value)) throw new Error(`invalid lifecycle operation result: ${expected.operationId}`);
    if (
      value.operationId !== expected.operationId ||
      value.action !== expected.action ||
      value.templateId !== expected.templateId
    ) {
      throw new Error(`lifecycle operation result identity mismatch: ${expected.operationId}`);
    }
    assertString(value.appliedAt, "lifecycle operation appliedAt");
    if (Number.isNaN(Date.parse(value.appliedAt))) {
      throw new Error(`invalid lifecycle operation timestamp: ${expected.operationId}`);
    }
    assertHash(value.stateDigest, "lifecycle operation state digest");
    for (const field of ["revisionId", "reviewId", "releaseId", "importReceiptId", "migrationId"] as const) {
      if (value[field] !== undefined) assertSafeSegment(String(value[field]), field);
    }
    if (value.contentDigest !== undefined) assertHash(value.contentDigest, "lifecycle result content digest");
    return value as unknown as Omit<LifecycleApplyResult, "idempotentReplay">;
  }

  private validateImportReceiptValue(value: unknown): ImportReceiptV1 {
    if (!isRecord(value) || value.schema !== IMPORT_RECEIPT_SCHEMA || value.selfContained !== true) {
      throw new Error("invalid import receipt in lifecycle intent");
    }
    for (const field of ["receiptId", "adapterId", "importId", "templateId", "revisionId"] as const) {
      assertString(value[field], `import receipt ${field}`);
      assertSafeSegment(value[field], field);
    }
    assertHash(value.contentDigest, "import receipt content digest");
    assertHash(value.sourceManifestDigest, "import receipt source manifest digest");
    assertString(value.committedAt, "import receipt committedAt");
    if (Number.isNaN(Date.parse(value.committedAt))) throw new Error("invalid import receipt timestamp");
    assertStringArray(value.requiredAssetSha256, "import receipt required hashes");
    if (!value.requiredAssetSha256.length) throw new Error("import receipt requires asset hashes");
    value.requiredAssetSha256.forEach((digest) => assertHash(digest, "import receipt required hash"));
    if (!Array.isArray(value.assetInventory)) throw new Error("invalid import receipt asset inventory");
    for (const item of value.assetInventory) {
      if (!isRecord(item)) throw new Error("invalid import receipt asset inventory item");
      assertString(item.logicalPath, "import receipt logicalPath");
      validateRevisionAssetPath(item.logicalPath);
      if (typeof item.role !== "string" || !["visual", "code", "reference", "evidence"].includes(item.role)) {
        throw new Error("invalid import receipt asset role");
      }
      if (!Number.isSafeInteger(item.bytes) || (item.bytes as number) < 0 || (item.bytes as number) > MAX_ASSET_BYTES) {
        throw new Error("invalid import receipt asset byte count");
      }
      assertHash(item.sha256, "import receipt asset digest");
    }
    return value as unknown as ImportReceiptV1;
  }

  private validateAdoptionReceiptValue(value: unknown): LegacyAdoptionReceiptV1 {
    if (
      !isRecord(value) ||
      value.schema !== LEGACY_ADOPTION_RECEIPT_SCHEMA ||
      value.legacySchema !== "figure-library.template.v1" ||
      value.legacyManifestFile !== "template.json" ||
      value.nonDestructive !== true
    ) {
      throw new Error("invalid legacy adoption receipt in lifecycle intent");
    }
    for (const field of ["migrationId", "templateId", "revisionId"] as const) {
      assertString(value[field], `legacy adoption receipt ${field}`);
      assertSafeSegment(value[field], field);
    }
    if (value.releaseId !== undefined) assertSafeSegment(String(value.releaseId), "releaseId");
    assertHash(value.legacyManifestSha256, "legacy adoption manifest digest");
    assertHash(value.contentDigest, "legacy adoption content digest");
    assertString(value.adoptedAt, "legacy adoption adoptedAt");
    if (Number.isNaN(Date.parse(value.adoptedAt))) throw new Error("invalid legacy adoption timestamp");
    return value as unknown as LegacyAdoptionReceiptV1;
  }

  private validateOperationIntentValue(
    value: unknown,
    expectedOperationId?: string,
  ): LifecycleOperationIntentV1 {
    if (!isRecord(value) || value.schema !== LIFECYCLE_OPERATION_INTENT_SCHEMA) {
      throw new Error(`invalid lifecycle operation intent: ${expectedOperationId ?? "unknown"}`);
    }
    assertString(value.operationId, "lifecycle intent operationId");
    assertSafeSegment(value.operationId, "operationId");
    if (expectedOperationId && value.operationId !== expectedOperationId) {
      throw new Error(`lifecycle operation intent path mismatch: ${expectedOperationId}`);
    }
    assertString(value.templateId, "lifecycle intent templateId");
    assertSafeSegment(value.templateId, "templateId");
    const actions: LifecyclePlanAction[] = [
      "create_working",
      "update_working",
      "update_gates",
      "publish",
      "discard_working",
      "restore_release",
      "adopt_legacy",
    ];
    if (typeof value.action !== "string" || !actions.includes(value.action as LifecyclePlanAction)) {
      throw new Error("invalid lifecycle intent action");
    }
    assertHash(value.planDigest, "lifecycle intent plan digest");
    if (value.expectedSeriesDigest !== null) {
      assertHash(value.expectedSeriesDigest, "lifecycle intent expected series digest");
    }
    let libraryContext: LibraryOperationContext | undefined;
    if (value.libraryContext !== undefined) {
      libraryContext = validateLibraryOperationContextValue(value.libraryContext);
      assertLibraryOperationContext(this.runtimeContext, libraryContext);
    }
    const expectedSeries = value.expectedSeries === null
      ? null
      : validateSeriesValue(value.expectedSeries, value.templateId);
    const expectedDigest = expectedSeries ? templateSeriesDigest(expectedSeries) : null;
    if (expectedDigest !== value.expectedSeriesDigest) {
      throw new Error(`lifecycle intent expected state mismatch: ${value.operationId}`);
    }
    assertString(value.preparedAt, "lifecycle intent preparedAt");
    if (Number.isNaN(Date.parse(value.preparedAt))) throw new Error("invalid lifecycle intent timestamp");
    const nextSeries = validateSeriesValue(value.nextSeries, value.templateId);
    const action = value.action as LifecyclePlanAction;
    if (!isRecord(value.objects)) throw new Error("invalid lifecycle intent object bindings");
    const objects = value.objects as Record<string, unknown>;
    if (objects.content !== undefined) {
      if (!isRecord(objects.content)) throw new Error("invalid lifecycle intent content binding");
      assertString(objects.content.revisionId, "intent content revisionId");
      assertSafeSegment(objects.content.revisionId, "revisionId");
      assertHash(objects.content.contentDigest, "intent content digest");
    }
    if (objects.review !== undefined) {
      if (!isRecord(objects.review)) throw new Error("invalid lifecycle intent review binding");
      assertString(objects.review.reviewId, "intent reviewId");
      assertSafeSegment(objects.review.reviewId, "reviewId");
      assertString(objects.review.revisionId, "intent review revisionId");
      assertSafeSegment(objects.review.revisionId, "revisionId");
      assertHash(objects.review.reviewDigest, "intent review digest");
    }
    if (objects.release !== undefined) {
      if (!isRecord(objects.release)) throw new Error("invalid lifecycle intent release binding");
      assertString(objects.release.releaseId, "intent releaseId");
      assertSafeSegment(objects.release.releaseId, "releaseId");
      assertHash(objects.release.releaseDigest, "intent release digest");
    }
    const result = this.validateOperationResult(value.result, {
      operationId: value.operationId,
      action,
      templateId: value.templateId,
    });
    if (
      result.appliedAt !== value.preparedAt ||
      result.stateDigest !== templateSeriesDigest(nextSeries)
    ) {
      throw new Error(`lifecycle intent result does not match its post-state: ${value.operationId}`);
    }
    const contentBinding = objects.content as LifecycleOperationIntentV1["objects"]["content"];
    const reviewBinding = objects.review as LifecycleOperationIntentV1["objects"]["review"];
    const releaseBinding = objects.release as LifecycleOperationIntentV1["objects"]["release"];
    if (action !== "discard_working") {
      if (
        !contentBinding ||
        !reviewBinding ||
        contentBinding.revisionId !== result.revisionId ||
        contentBinding.contentDigest !== result.contentDigest ||
        reviewBinding.reviewId !== result.reviewId ||
        reviewBinding.revisionId !== result.revisionId
      ) {
        throw new Error(`lifecycle intent immutable object bindings are incomplete: ${value.operationId}`);
      }
    }
    if (action === "publish") {
      if (!releaseBinding || releaseBinding.releaseId !== result.releaseId) {
        throw new Error(`publish intent lacks its exact Release binding: ${value.operationId}`);
      }
    } else if (action === "adopt_legacy") {
      if ((releaseBinding?.releaseId ?? null) !== (result.releaseId ?? null)) {
        throw new Error(`adoption intent Release binding mismatch: ${value.operationId}`);
      }
    } else if (releaseBinding) {
      throw new Error(`unexpected Release binding in lifecycle intent: ${value.operationId}`);
    }
    let publicPlan: PublicLifecycleOperationBinding | undefined;
    if (value.publicPlan !== undefined) {
      if (!isRecord(value.publicPlan)) throw new Error("invalid public lifecycle binding in intent");
      publicPlan = validatePublicPlanBinding(
        value.publicPlan as unknown as PublicLifecycleOperationBinding,
        action,
        value.expectedSeriesDigest as string | null,
      );
    }
    const importReceipt = value.importReceipt === undefined
      ? undefined
      : this.validateImportReceiptValue(value.importReceipt);
    const adoptionReceipt = value.adoptionReceipt === undefined
      ? undefined
      : this.validateAdoptionReceiptValue(value.adoptionReceipt);
    if (
      (importReceipt?.receiptId ?? null) !== (result.importReceiptId ?? null) ||
      (adoptionReceipt?.migrationId ?? null) !== (result.migrationId ?? null)
    ) {
      throw new Error(`lifecycle intent auxiliary receipt mismatch: ${value.operationId}`);
    }
    if (importReceipt && action !== "create_working" && action !== "update_working" && action !== "restore_release") {
      throw new Error("import receipt is not valid for this lifecycle action");
    }
    if ((action === "adopt_legacy") !== Boolean(adoptionReceipt)) {
      throw new Error("legacy adoption intent must contain exactly one migration receipt");
    }
    assertHash(value.intentDigest, "lifecycle intent digest");
    const intent = {
      ...(value as unknown as LifecycleOperationIntentV1),
      expectedSeries,
      nextSeries,
      objects: value.objects as LifecycleOperationIntentV1["objects"],
      result,
      ...(libraryContext ? { libraryContext } : {}),
      ...(publicPlan ? { publicPlan } : {}),
      ...(importReceipt ? { importReceipt } : {}),
      ...(adoptionReceipt ? { adoptionReceipt } : {}),
    };
    if (digestOperationIntent(intent) !== intent.intentDigest) {
      throw new Error(`lifecycle operation intent digest mismatch: ${value.operationId}`);
    }
    return intent;
  }

  private async readOperationIntent(operationId: string): Promise<LifecycleOperationIntentV1 | undefined> {
    try {
      return this.validateOperationIntentValue(
        await readJson(this.operationIntentFile(operationId)),
        operationId,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private operationReceiptForIntent(intent: LifecycleOperationIntentV1): LifecycleOperationReceiptV1 {
    return {
      schema: LIFECYCLE_OPERATION_RECEIPT_SCHEMA,
      operationId: intent.operationId,
      planDigest: intent.planDigest,
      action: intent.action,
      templateId: intent.templateId,
      appliedAt: intent.result.appliedAt,
      ...(intent.libraryContext ? { libraryContext: intent.libraryContext } : {}),
      ...(intent.publicPlan ? { publicPlan: intent.publicPlan } : {}),
      result: intent.result,
    };
  }

  private async writeAuxiliaryReceipts(intent: LifecycleOperationIntentV1) {
    if (intent.importReceipt) {
      const content = await this.requireContent(
        intent.templateId,
        intent.importReceipt.revisionId,
        intent.importReceipt.contentDigest,
      );
      if (!content.intakeBinding) throw new Error("import receipt lacks its Revision intake binding");
      await this.writeImportReceipt(intent.importReceipt, content.intakeBinding.sourceManifest);
    }
    if (intent.adoptionReceipt) {
      await immutableWriteJson(
        path.join(
          this.storeDirectory,
          "migrations",
          "flat-v1",
          "adoptions",
          assertSafeSegment(intent.adoptionReceipt.migrationId, "migrationId"),
          "receipt.json",
        ),
        intent.adoptionReceipt,
      );
    }
  }

  private async intentImmutableObjectsReady(intent: LifecycleOperationIntentV1) {
    if (intent.action === "discard_working") return true;
    const contentBinding = intent.objects.content!;
    const reviewBinding = intent.objects.review!;
    const content = await this.getContent(
      intent.templateId,
      contentBinding.revisionId,
      contentBinding.contentDigest,
    );
    if (!content) return false;
    await this.verifyRevisionOnDisk(content);
    const review = await this.getReview(intent.templateId, reviewBinding.reviewId);
    if (!review) return false;
    if (
      review.reviewDigest !== reviewBinding.reviewDigest ||
      review.revisionId !== reviewBinding.revisionId
    ) {
      throw new Error(`lifecycle recovery immutable review mismatch: ${intent.operationId}`);
    }
    if (intent.objects.release) {
      const release = await this.getRelease(intent.templateId, intent.objects.release.releaseId);
      if (!release) return false;
      if (
        release.releaseDigest !== intent.objects.release.releaseDigest ||
        release.revisionId !== content.revisionId ||
        release.contentDigest !== content.contentDigest ||
        release.reviewId !== review.reviewId ||
        release.reviewDigest !== review.reviewDigest
      ) {
        throw new Error(`lifecycle recovery immutable Release mismatch: ${intent.operationId}`);
      }
    }
    if (intent.importReceipt) {
      const expected = this.importReceiptForContent(content, intent.result.appliedAt);
      if (canonicalJson(expected ?? null) !== canonicalJson(intent.importReceipt)) {
        throw new Error(`lifecycle recovery immutable intake binding mismatch: ${intent.operationId}`);
      }
    }
    return true;
  }

  private async rollForwardIntentFromPreState(intent: LifecycleOperationIntentV1) {
    const current = await this.getSeries(intent.templateId);
    if (canonicalJson(current ?? null) !== canonicalJson(intent.expectedSeries)) {
      throw new Error(`lifecycle recovery pre-state mismatch: ${intent.operationId}`);
    }
    if (!(await this.intentImmutableObjectsReady(intent))) return undefined;
    // Auxiliary objects use immutable, receipt-specific paths. Writing them
    // before the mutable Series pointer prevents a late collision from leaving
    // a committed Head without its receipt.
    await this.writeAuxiliaryReceipts(intent);
    await atomicWriteJson(this.seriesFile(intent.templateId), intent.nextSeries);
    await this.injectFault("after_series_write", intent);
    return this.completeCommittedIntent(intent, true);
  }

  private async verifyIntentPostState(intent: LifecycleOperationIntentV1) {
    const current = await this.getSeries(intent.templateId);
    if (canonicalJson(current ?? null) !== canonicalJson(intent.nextSeries)) {
      throw new Error(
        `lifecycle recovery post-state mismatch for ${intent.operationId}; manual recovery required`,
      );
    }
    const result = intent.result;
    if (intent.action === "create_working" || intent.action === "update_working" || intent.action === "restore_release") {
      const head = current?.workingHead;
      if (
        !head ||
        head.revisionId !== result.revisionId ||
        head.contentDigest !== result.contentDigest ||
        head.reviewId !== result.reviewId
      ) {
        throw new Error(`lifecycle recovery Working Head mismatch: ${intent.operationId}`);
      }
      const content = await this.requireContent(intent.templateId, head.revisionId, head.contentDigest);
      if (
        content.revisionId !== intent.objects.content?.revisionId ||
        content.contentDigest !== intent.objects.content?.contentDigest
      ) {
        throw new Error(`lifecycle recovery content binding mismatch: ${intent.operationId}`);
      }
      await this.verifyRevisionOnDisk(content);
      const review = await this.requireReview(intent.templateId, head.reviewId);
      if (
        review.revisionId !== head.revisionId ||
        review.reviewDigest !== head.reviewDigest ||
        review.reviewId !== intent.objects.review?.reviewId ||
        review.reviewDigest !== intent.objects.review?.reviewDigest
      ) {
        throw new Error(`lifecycle recovery review mismatch: ${intent.operationId}`);
      }
      const expectedImportReceipt = this.importReceiptForContent(content, result.appliedAt);
      if (canonicalJson(expectedImportReceipt ?? null) !== canonicalJson(intent.importReceipt ?? null)) {
        throw new Error(`lifecycle recovery import receipt mismatch: ${intent.operationId}`);
      }
    } else if (intent.action === "update_gates") {
      const head = current?.workingHead;
      if (!head || head.revisionId !== result.revisionId || head.reviewId !== result.reviewId) {
        throw new Error(`lifecycle recovery gate head mismatch: ${intent.operationId}`);
      }
      await this.requireContent(
        intent.templateId,
        String(intent.objects.content?.revisionId),
        intent.objects.content?.contentDigest,
      );
      const review = await this.requireReview(intent.templateId, head.reviewId);
      if (
        review.revisionId !== head.revisionId ||
        review.reviewDigest !== head.reviewDigest ||
        head.revisionId !== intent.objects.content?.revisionId ||
        head.contentDigest !== intent.objects.content?.contentDigest ||
        review.reviewId !== intent.objects.review?.reviewId ||
        review.reviewDigest !== intent.objects.review?.reviewDigest ||
        review.revisionId !== intent.objects.review?.revisionId
      ) {
        throw new Error(`lifecycle recovery gate review mismatch: ${intent.operationId}`);
      }
    } else if (intent.action === "publish") {
      const head = current?.publishedHead;
      if (
        !head ||
        current?.workingHead ||
        head.revisionId !== result.revisionId ||
        head.contentDigest !== result.contentDigest ||
        head.releaseId !== result.releaseId
      ) {
        throw new Error(`lifecycle recovery Published Head mismatch: ${intent.operationId}`);
      }
      const release = await this.requireRelease(intent.templateId, head.releaseId);
      if (
        release.revisionId !== head.revisionId ||
        release.contentDigest !== head.contentDigest ||
        release.reviewId !== result.reviewId ||
        release.publishedAt !== head.publishedAt ||
        release.releaseId !== intent.objects.release?.releaseId ||
        release.releaseDigest !== intent.objects.release?.releaseDigest
      ) {
        throw new Error(`lifecycle recovery Release mismatch: ${intent.operationId}`);
      }
      const content = await this.requireContent(intent.templateId, release.revisionId, release.contentDigest);
      if (
        content.revisionId !== intent.objects.content?.revisionId ||
        content.contentDigest !== intent.objects.content?.contentDigest
      ) {
        throw new Error(`lifecycle recovery publish content mismatch: ${intent.operationId}`);
      }
      const review = await this.requireReview(intent.templateId, release.reviewId);
      if (
        review.reviewDigest !== release.reviewDigest ||
        review.reviewId !== intent.objects.review?.reviewId ||
        review.reviewDigest !== intent.objects.review?.reviewDigest ||
        review.validationErrors.length ||
        review.blockingGates.some((gate) => gate.status === "open")
      ) {
        throw new Error(`lifecycle recovery publish review mismatch: ${intent.operationId}`);
      }
    } else if (intent.action === "discard_working") {
      if (current?.workingHead) throw new Error(`lifecycle recovery discard mismatch: ${intent.operationId}`);
    } else {
      const content = await this.requireContent(
        intent.templateId,
        String(result.revisionId),
        result.contentDigest,
      );
      if (
        content.revisionId !== intent.objects.content?.revisionId ||
        content.contentDigest !== intent.objects.content?.contentDigest
      ) {
        throw new Error(`lifecycle recovery adoption content binding mismatch: ${intent.operationId}`);
      }
      await this.verifyRevisionOnDisk(content);
      const review = await this.requireReview(intent.templateId, String(result.reviewId));
      if (
        review.revisionId !== content.revisionId ||
        review.reviewId !== intent.objects.review?.reviewId ||
        review.reviewDigest !== intent.objects.review?.reviewDigest
      ) {
        throw new Error(`lifecycle recovery adoption review mismatch: ${intent.operationId}`);
      }
      if (result.releaseId) {
        const release = await this.requireRelease(intent.templateId, result.releaseId);
        if (
          release.revisionId !== content.revisionId ||
          release.contentDigest !== content.contentDigest ||
          release.reviewId !== review.reviewId ||
          current?.publishedHead?.releaseId !== release.releaseId ||
          release.releaseId !== intent.objects.release?.releaseId ||
          release.releaseDigest !== intent.objects.release?.releaseDigest
        ) {
          throw new Error(`lifecycle recovery adoption Release mismatch: ${intent.operationId}`);
        }
      } else if (current?.workingHead) {
        if (
          current.workingHead.revisionId !== content.revisionId ||
          current.workingHead.reviewId !== review.reviewId
        ) {
          throw new Error(`lifecycle recovery adoption Working Head mismatch: ${intent.operationId}`);
        }
      }
      const expectedAdoptionReceipt: LegacyAdoptionReceiptV1 = {
        schema: LEGACY_ADOPTION_RECEIPT_SCHEMA,
        migrationId: String(result.migrationId),
        templateId: intent.templateId,
        legacySchema: "figure-library.template.v1",
        legacyManifestFile: "template.json",
        legacyManifestSha256: intent.adoptionReceipt!.legacyManifestSha256,
        revisionId: content.revisionId,
        contentDigest: content.contentDigest,
        ...(result.releaseId ? { releaseId: result.releaseId } : {}),
        adoptedAt: result.appliedAt,
        nonDestructive: true,
      };
      if (canonicalJson(expectedAdoptionReceipt) !== canonicalJson(intent.adoptionReceipt)) {
        throw new Error(`lifecycle recovery migration receipt mismatch: ${intent.operationId}`);
      }
    }
  }

  private async completeCommittedIntent(
    intent: LifecycleOperationIntentV1,
    idempotentReplay: boolean,
  ): Promise<LifecycleApplyResult> {
    await this.verifyIntentPostState(intent);
    await this.writeAuxiliaryReceipts(intent);
    await this.injectFault("after_auxiliary_receipts", intent);
    await this.injectFault("before_operation_receipt", intent);
    await immutableWriteJson(this.operationFile(intent.operationId), this.operationReceiptForIntent(intent));
    return { ...intent.result, idempotentReplay };
  }

  private async readOperationReceipt(operationId: string): Promise<LifecycleOperationReceiptV1 | undefined> {
    try {
      const value = await readJson(this.operationFile(operationId));
      if (!isRecord(value) || value.schema !== LIFECYCLE_OPERATION_RECEIPT_SCHEMA || value.operationId !== operationId) {
        throw new Error(`invalid lifecycle operation receipt: ${operationId}`);
      }
      assertHash(value.planDigest, "operation receipt plan digest");
      assertString(value.templateId, "operation receipt templateId");
      assertSafeSegment(value.templateId, "templateId");
      const actions: LifecyclePlanAction[] = [
        "create_working",
        "update_working",
        "update_gates",
        "publish",
        "discard_working",
        "restore_release",
        "adopt_legacy",
      ];
      if (typeof value.action !== "string" || !actions.includes(value.action as LifecyclePlanAction)) {
        throw new Error(`invalid lifecycle operation receipt action: ${operationId}`);
      }
      assertString(value.appliedAt, "operation receipt appliedAt");
      const receipt = value as unknown as LifecycleOperationReceiptV1;
      const result = this.validateOperationResult(receipt.result, {
        operationId,
        action: receipt.action,
        templateId: receipt.templateId,
      });
      if (receipt.appliedAt !== result.appliedAt) {
        throw new Error(`lifecycle operation receipt timestamp mismatch: ${operationId}`);
      }
      if (receipt.libraryContext !== undefined) {
        const context = validateLibraryOperationContextValue(receipt.libraryContext);
        assertLibraryOperationContext(this.runtimeContext, context);
      }
      if (receipt.publicPlan) {
        validatePublicPlanBinding(
          receipt.publicPlan,
          receipt.action,
          receipt.publicPlan.expectedSeriesDigest,
        );
      }
      return receipt;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async replayPublicOperation(
    input: PublicLifecycleReplayInput,
  ): Promise<LifecycleApplyResult | undefined> {
    const operationId = assertSafeSegment(input.operationId, "operationId");
    assertHash(input.planDigest, "public lifecycle plan digest");
    assertSafeSegment(input.expectedTemplateId, "expectedTemplateId");
    if (input.expectedSeriesDigest !== null) {
      assertHash(input.expectedSeriesDigest, "expected series digest");
    }
    const verifyBinding = (
      value: Pick<LifecycleOperationReceiptV1, "templateId" | "action" | "publicPlan">,
    ) => {
      const binding = value.publicPlan;
      if (!binding) {
        throw new Error(`operationId was not created by a public lifecycle Apply: ${operationId}`);
      }
      if (binding.kind !== input.kind || binding.planDigest !== input.planDigest) {
        throw new Error(`operationId was already used for a different public plan: ${operationId}`);
      }
      if (value.templateId !== input.expectedTemplateId) {
        throw new Error("expectedTemplateId does not match the completed public operation");
      }
      if (binding.expectedSeriesDigest !== input.expectedSeriesDigest) {
        throw new Error("expectedSeriesDigest does not match the completed public operation");
      }
      if (input.expectedAction !== undefined && value.action !== input.expectedAction) {
        throw new Error("expectedAction does not match the completed public operation");
      }
      if (!publicKindAllowsAction(input.kind, value.action)) {
        throw new Error(`public lifecycle kind ${input.kind} does not match ${value.action}`);
      }
    };
    const receipt = await this.readOperationReceipt(operationId);
    if (receipt) {
      verifyBinding(receipt);
      return { ...receipt.result, idempotentReplay: true };
    }
    const existingIntent = await this.readOperationIntent(operationId);
    if (!existingIntent) return undefined;
    verifyBinding(existingIntent);
    return this.withWriteLock(`lifecycle-recovery:${existingIntent.action}:${operationId}`, async () => {
      const completed = await this.readOperationReceipt(operationId);
      if (completed) {
        verifyBinding(completed);
        return { ...completed.result, idempotentReplay: true };
      }
      const intent = await this.readOperationIntent(operationId);
      if (!intent) throw new Error(`lifecycle operation intent disappeared: ${operationId}`);
      verifyBinding(intent);
      const current = await this.getSeries(intent.templateId);
      if (canonicalJson(current ?? null) === canonicalJson(intent.expectedSeries)) {
        return this.rollForwardIntentFromPreState(intent);
      }
      if (canonicalJson(current ?? null) !== canonicalJson(intent.nextSeries)) {
        throw new Error(
          `lifecycle recovery found neither the exact pre-state nor post-state for ${operationId}; manual recovery required`,
        );
      }
      return this.completeCommittedIntent(intent, true);
    });
  }

  async applyPlan(
    plan: LifecyclePlan,
    operationId: string,
    publicPlan?: Pick<PublicLifecycleOperationBinding, "kind" | "planDigest">,
  ): Promise<LifecycleApplyResult> {
    this.validateLifecyclePlan(plan);
    const safeOperationId = assertSafeSegment(operationId, "operationId");
    const publicBinding = publicPlan
      ? validatePublicPlanBinding(
          {
            ...publicPlan,
            expectedSeriesDigest: plan.expectedSeriesDigest,
          },
          plan.action,
          plan.expectedSeriesDigest,
        )
      : undefined;
    return this.withWriteLock(`lifecycle:${plan.action}:${safeOperationId}`, async () => {
      const priorReceipt = await this.readOperationReceipt(safeOperationId);
      if (priorReceipt) {
        if (
          priorReceipt.planDigest !== plan.planDigest ||
          priorReceipt.action !== plan.action ||
          priorReceipt.templateId !== plan.templateId
        ) {
          throw new Error(`operationId was already used for a different plan: ${safeOperationId}`);
        }
        if (
          canonicalJson(priorReceipt.publicPlan ?? null) !== canonicalJson(publicBinding ?? null)
        ) {
          throw new Error(
            `operationId was already used with a different public plan binding: ${safeOperationId}`,
          );
        }
        return { ...priorReceipt.result, idempotentReplay: true };
      }
      const priorIntent = await this.readOperationIntent(safeOperationId);
      if (
        priorIntent &&
        (
          priorIntent.planDigest !== plan.planDigest ||
          priorIntent.action !== plan.action ||
          priorIntent.templateId !== plan.templateId ||
          priorIntent.expectedSeriesDigest !== plan.expectedSeriesDigest ||
          canonicalJson(priorIntent.publicPlan ?? null) !== canonicalJson(publicBinding ?? null)
        )
      ) {
        throw new Error(`operationId was already used for a different plan or public binding: ${safeOperationId}`);
      }
      const current = await this.getSeries(plan.templateId);
      if (priorIntent) {
        if (canonicalJson(current ?? null) === canonicalJson(priorIntent.nextSeries)) {
          return this.completeCommittedIntent(priorIntent, true);
        }
        if (canonicalJson(current ?? null) !== canonicalJson(priorIntent.expectedSeries)) {
          throw new Error(
            `lifecycle recovery found neither the exact pre-state nor post-state for ${safeOperationId}; manual recovery required`,
          );
        }
        const rolledForward = await this.rollForwardIntentFromPreState(priorIntent);
        if (rolledForward) return rolledForward;
      } else {
        const actualDigest = current ? templateSeriesDigest(current) : null;
        if (actualDigest !== plan.expectedSeriesDigest) {
          throw new Error(`stale lifecycle plan for ${plan.templateId}: expected ${plan.expectedSeriesDigest ?? "missing"}, found ${actualDigest ?? "missing"}`);
        }
      }
      const appliedAt = priorIntent?.preparedAt ?? nowIso();
      let nextSeries: TemplateSeriesV1;
      let resultFields: Pick<LifecycleApplyResult, "revisionId" | "contentDigest" | "reviewId" | "releaseId" | "importReceiptId" | "migrationId"> = {};
      let operationIntent: LifecycleOperationIntentV1 | undefined;
      const faultContext = {
        operationId: safeOperationId,
        action: plan.action,
        templateId: plan.templateId,
      };

      const ensureIntent = async (options: {
        nextSeries: TemplateSeriesV1;
        resultFields: typeof resultFields;
        objects: LifecycleOperationIntentV1["objects"];
        importReceipt?: ImportReceiptV1;
        adoptionReceipt?: LegacyAdoptionReceiptV1;
      }) => {
        const stableResult: Omit<LifecycleApplyResult, "idempotentReplay"> = {
          operationId: safeOperationId,
          action: plan.action,
          templateId: plan.templateId,
          appliedAt,
          stateDigest: templateSeriesDigest(options.nextSeries),
          ...options.resultFields,
        };
        const withoutDigest: Omit<LifecycleOperationIntentV1, "intentDigest"> = {
          schema: LIFECYCLE_OPERATION_INTENT_SCHEMA,
          operationId: safeOperationId,
          planDigest: plan.planDigest,
          action: plan.action,
          templateId: plan.templateId,
          expectedSeriesDigest: plan.expectedSeriesDigest,
          ...(plan.libraryContext ? { libraryContext: plan.libraryContext } : {}),
          expectedSeries: current ?? null,
          preparedAt: appliedAt,
          ...(publicBinding ? { publicPlan: publicBinding } : {}),
          nextSeries: options.nextSeries,
          objects: options.objects,
          ...(options.importReceipt ? { importReceipt: options.importReceipt } : {}),
          ...(options.adoptionReceipt ? { adoptionReceipt: options.adoptionReceipt } : {}),
          result: stableResult,
        };
        const candidate = this.validateOperationIntentValue({
          ...withoutDigest,
          intentDigest: digestOperationIntent(withoutDigest),
        });
        if (priorIntent) {
          if (canonicalJson(priorIntent) !== canonicalJson(candidate)) {
            throw new Error(`lifecycle retry does not reproduce its durable intent: ${safeOperationId}`);
          }
          return priorIntent;
        }
        await immutableWriteJson(this.operationIntentFile(safeOperationId), candidate);
        await this.injectFault("after_intent_write", candidate);
        return candidate;
      };

      if (plan.action === "create_working" || plan.action === "update_working" || plan.action === "restore_release") {
        const { content, review } = plan;
        if (plan.action === "create_working") {
          if (current?.workingHead) throw new Error("create_working would replace an existing working head");
          const expectedParent = current?.publishedHead?.revisionId;
          if (content.parentRevisionId !== expectedParent) throw new Error("create_working parent revision is stale");
        } else if (plan.action === "update_working") {
          if (!current?.workingHead || content.parentRevisionId !== current.workingHead.revisionId) {
            throw new Error("update_working does not descend from the current working head");
          }
        } else {
          if (!current || current.workingHead) throw new Error("restore_release requires a series without a working head");
          if (!content.restoredFromReleaseId) throw new Error("restore_release content lacks provenance");
          if (content.parentRevisionId !== current.publishedHead?.revisionId) {
            throw new Error("restore_release parent revision is stale");
          }
          const sourceRelease = await this.requireRelease(plan.templateId, content.restoredFromReleaseId);
          const sourceContent = await this.requireContent(plan.templateId, sourceRelease.revisionId, sourceRelease.contentDigest);
          const stripRestoreMetadata = (item: TemplateContentV1) => {
            const {
              revisionId: _revisionId,
              parentRevisionId: _parentRevisionId,
              restoredFromReleaseId: _restoredFromReleaseId,
              createdAt: _createdAt,
              contentDigest: _contentDigest,
              ...rest
            } = item;
            return { ...rest, validationState: effectiveValidationState(item) };
          };
          if (canonicalJson(stripRestoreMetadata(content)) !== canonicalJson(stripRestoreMetadata(sourceContent))) {
            throw new Error("restore_release content differs from the selected historical release");
          }
          if (
            review.validationErrors.length ||
            review.blockingGates.length !== 1 ||
            review.blockingGates[0]?.gateId !== "review-restored-release" ||
            review.blockingGates[0]?.status !== "open"
          ) {
            throw new Error("restore_release must create an open re-review gate");
          }
        }
        const baseReleaseId =
          plan.action === "update_working"
            ? current?.workingHead?.baseReleaseId
            : current?.publishedHead?.releaseId;
        nextSeries = {
          schema: TEMPLATE_SERIES_SCHEMA,
          templateId: plan.templateId,
          status: current?.status ?? "active",
          createdAt: current?.createdAt ?? plan.createdAt,
          updatedAt: appliedAt,
          ...(current?.publishedHead ? { publishedHead: current.publishedHead } : {}),
          workingHead: {
            revisionId: content.revisionId,
            contentDigest: content.contentDigest,
            reviewId: review.reviewId,
            reviewDigest: review.reviewDigest,
            ...(baseReleaseId ? { baseReleaseId } : {}),
            updatedAt: appliedAt,
          },
        };
        const importReceipt = this.importReceiptForContent(content, appliedAt);
        resultFields = {
          revisionId: content.revisionId,
          contentDigest: content.contentDigest,
          reviewId: review.reviewId,
          ...(importReceipt ? { importReceiptId: importReceipt.receiptId } : {}),
        };
        await this.writePreparedRevision(content, plan.assetSources);
        await immutableWriteJson(this.reviewFile(plan.templateId, review.reviewId), review);
        await this.injectFault("after_immutable_objects", faultContext);
        operationIntent = await ensureIntent({
          nextSeries,
          resultFields,
          objects: {
            content: { revisionId: content.revisionId, contentDigest: content.contentDigest },
            review: {
              reviewId: review.reviewId,
              reviewDigest: review.reviewDigest,
              revisionId: review.revisionId,
            },
          },
          ...(importReceipt ? { importReceipt } : {}),
        });
        await this.writeAuxiliaryReceipts(operationIntent);
        await atomicWriteJson(this.seriesFile(plan.templateId), nextSeries);
        await this.injectFault("after_series_write", operationIntent);
      } else if (plan.action === "update_gates") {
        if (!current?.workingHead) throw new Error("gate update requires a working head");
        if (
          plan.review.previousReviewId !== current.workingHead.reviewId ||
          plan.review.revisionId !== current.workingHead.revisionId
        ) {
          throw new Error("gate update does not follow the current review snapshot");
        }
        const previousReview = await this.requireReview(plan.templateId, current.workingHead.reviewId);
        if (
          canonicalJson(previousReview.validationErrors) !== canonicalJson(plan.review.validationErrors) ||
          canonicalJson(previousReview.warnings) !== canonicalJson(plan.review.warnings)
        ) {
          throw new Error("gate updates cannot change validation errors or warnings");
        }
        const immutableGate = (gate: BlockingGateRecord) => {
          const { status: _status, resolution: _resolution, ...definition } = gate;
          return definition;
        };
        const priorGates = new Map(previousReview.blockingGates.map((gate) => [gate.gateId, gate]));
        if (
          plan.review.blockingGates.length !== previousReview.blockingGates.length ||
          plan.review.blockingGates.some((gate) => {
            const prior = priorGates.get(gate.gateId);
            return !prior || canonicalJson(immutableGate(prior)) !== canonicalJson(immutableGate(gate));
          })
        ) {
          throw new Error("gate updates cannot add, remove, or redefine blocking gates");
        }
        nextSeries = {
          ...current,
          updatedAt: appliedAt,
          workingHead: {
            ...current.workingHead,
            reviewId: plan.review.reviewId,
            reviewDigest: plan.review.reviewDigest,
            updatedAt: appliedAt,
          },
        };
        resultFields = {
          revisionId: current.workingHead.revisionId,
          contentDigest: current.workingHead.contentDigest,
          reviewId: plan.review.reviewId,
        };
        await immutableWriteJson(this.reviewFile(plan.templateId, plan.review.reviewId), plan.review);
        await this.injectFault("after_immutable_objects", faultContext);
        operationIntent = await ensureIntent({
          nextSeries,
          resultFields,
          objects: {
            content: {
              revisionId: current.workingHead.revisionId,
              contentDigest: current.workingHead.contentDigest,
            },
            review: {
              reviewId: plan.review.reviewId,
              reviewDigest: plan.review.reviewDigest,
              revisionId: plan.review.revisionId,
            },
          },
        });
        await atomicWriteJson(this.seriesFile(plan.templateId), nextSeries);
        await this.injectFault("after_series_write", operationIntent);
      } else if (plan.action === "publish") {
        await this.validateRuntimeClosure(await this.requireContent(plan.templateId,plan.release.revisionId,plan.release.contentDigest));
        if (!current?.workingHead) throw new Error("publish requires a working head");
        const { release } = plan;
        if (
          release.revisionId !== current.workingHead.revisionId ||
          release.contentDigest !== current.workingHead.contentDigest ||
          release.reviewId !== current.workingHead.reviewId ||
          release.reviewDigest !== current.workingHead.reviewDigest ||
          release.previousReleaseId !== current.publishedHead?.releaseId
        ) {
          throw new Error("release does not match the current working/published heads");
        }
        const review = await this.requireReview(plan.templateId, release.reviewId);
        if (review.validationErrors.length || review.blockingGates.some((gate) => gate.status === "open")) {
          throw new Error("publish cannot waive validation errors or blocking review gates");
        }
        await this.requireContent(plan.templateId, release.revisionId, release.contentDigest);
        const { workingHead: _workingHead, ...withoutWorking } = current;
        nextSeries = {
          ...withoutWorking,
          updatedAt: appliedAt,
          publishedHead: {
            revisionId: release.revisionId,
            contentDigest: release.contentDigest,
            releaseId: release.releaseId,
            publishedAt: release.publishedAt,
          },
        };
        resultFields = {
          revisionId: release.revisionId,
          contentDigest: release.contentDigest,
          reviewId: release.reviewId,
          releaseId: release.releaseId,
        };
        await immutableWriteJson(this.releaseFile(plan.templateId, release.releaseId), release);
        await this.injectFault("after_immutable_objects", faultContext);
        operationIntent = await ensureIntent({
          nextSeries,
          resultFields,
          objects: {
            content: { revisionId: release.revisionId, contentDigest: release.contentDigest },
            review: {
              reviewId: release.reviewId,
              reviewDigest: release.reviewDigest,
              revisionId: release.revisionId,
            },
            release: { releaseId: release.releaseId, releaseDigest: release.releaseDigest },
          },
        });
        await atomicWriteJson(this.seriesFile(plan.templateId), nextSeries);
        await this.injectFault("after_series_write", operationIntent);
      } else if (plan.action === "discard_working") {
        if (!current?.workingHead || current.workingHead.revisionId !== plan.discardedRevisionId) {
          throw new Error("discard plan does not match the current working head");
        }
        const { workingHead: _workingHead, ...withoutWorking } = current;
        nextSeries = { ...withoutWorking, updatedAt: appliedAt };
        resultFields = { revisionId: plan.discardedRevisionId };
        await this.injectFault("after_immutable_objects", faultContext);
        operationIntent = await ensureIntent({ nextSeries, resultFields, objects: {} });
        await atomicWriteJson(this.seriesFile(plan.templateId), nextSeries);
        await this.injectFault("after_series_write", operationIntent);
      } else {
        const legacyPlan = plan as LegacyAdoptionPlan;
        if (current) throw new Error("legacy adoption cannot replace a versioned series");
        const manifestFile = resolveContained(
          this.root,
          `${legacyPlan.legacy.sourceRelativeDirectory}/template.json`,
        );
        const manifestText = await fs.readFile(manifestFile, "utf8");
        if (sha256(manifestText) !== legacyPlan.legacy.legacyManifestSha256) {
          throw new Error("legacy manifest changed after planning");
        }
        const { content, review, release } = legacyPlan.legacy;
        nextSeries = {
          schema: TEMPLATE_SERIES_SCHEMA,
          templateId: plan.templateId,
          status: legacyPlan.legacy.legacyReviewStatus === "archived" ? "archived" : "active",
          createdAt: plan.createdAt,
          updatedAt: appliedAt,
          ...(release
            ? {
                publishedHead: {
                  revisionId: release.revisionId,
                  contentDigest: release.contentDigest,
                  releaseId: release.releaseId,
                  publishedAt: release.publishedAt,
                },
              }
            : legacyPlan.legacy.legacyReviewStatus === "draft"
              ? {
                  workingHead: {
                    revisionId: content.revisionId,
                    contentDigest: content.contentDigest,
                    reviewId: review.reviewId,
                    reviewDigest: review.reviewDigest,
                    updatedAt: appliedAt,
                  },
                }
              : {}),
        };
        const adoptionReceipt: LegacyAdoptionReceiptV1 = {
          schema: LEGACY_ADOPTION_RECEIPT_SCHEMA,
          migrationId: legacyPlan.migrationId,
          templateId: plan.templateId,
          legacySchema: "figure-library.template.v1",
          legacyManifestFile: "template.json",
          legacyManifestSha256: legacyPlan.legacy.legacyManifestSha256,
          revisionId: content.revisionId,
          contentDigest: content.contentDigest,
          ...(release ? { releaseId: release.releaseId } : {}),
          adoptedAt: appliedAt,
          nonDestructive: true,
        };
        resultFields = {
          revisionId: content.revisionId,
          contentDigest: content.contentDigest,
          reviewId: review.reviewId,
          ...(release ? { releaseId: release.releaseId } : {}),
          migrationId: legacyPlan.migrationId,
        };
        await this.writePreparedRevision(content, legacyPlan.legacy.assetSources);
        await immutableWriteJson(this.reviewFile(plan.templateId, review.reviewId), review);
        if (release) await immutableWriteJson(this.releaseFile(plan.templateId, release.releaseId), release);
        await this.injectFault("after_immutable_objects", faultContext);
        operationIntent = await ensureIntent({
          nextSeries,
          resultFields,
          objects: {
            content: { revisionId: content.revisionId, contentDigest: content.contentDigest },
            review: {
              reviewId: review.reviewId,
              reviewDigest: review.reviewDigest,
              revisionId: review.revisionId,
            },
            ...(release
              ? { release: { releaseId: release.releaseId, releaseDigest: release.releaseDigest } }
              : {}),
          },
          adoptionReceipt,
        });
        await this.writeAuxiliaryReceipts(operationIntent);
        await atomicWriteJson(this.seriesFile(plan.templateId), nextSeries);
        await this.injectFault("after_series_write", operationIntent);
      }
      if (!operationIntent) throw new Error(`lifecycle intent was not prepared: ${safeOperationId}`);
      return this.completeCommittedIntent(operationIntent, false);
    });
  }

  async applyCreateWorking(plan: WorkingRevisionPlan, operationId: string) {
    if (plan.action !== "create_working") throw new Error("expected create_working plan");
    return this.applyPlan(plan, operationId);
  }

  async applyUpdateWorking(plan: WorkingRevisionPlan, operationId: string) {
    if (plan.action !== "update_working") throw new Error("expected update_working plan");
    return this.applyPlan(plan, operationId);
  }

  async applyGateUpdate(plan: GateUpdatePlan, operationId: string) {
    return this.applyPlan(plan, operationId);
  }

  async applyPublish(plan: PublishPlan, operationId: string) {
    return this.applyPlan(plan, operationId);
  }

  async applyDiscardWorking(plan: DiscardWorkingPlan, operationId: string) {
    return this.applyPlan(plan, operationId);
  }

  async applyRestoreRelease(plan: WorkingRevisionPlan, operationId: string) {
    if (plan.action !== "restore_release") throw new Error("expected restore_release plan");
    return this.applyPlan(plan, operationId);
  }

  async applyAdoptLegacy(plan: LegacyAdoptionPlan, operationId: string) {
    return this.applyPlan(plan, operationId);
  }
}
