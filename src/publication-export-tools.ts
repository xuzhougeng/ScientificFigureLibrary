import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { PNG } from "pngjs";
import { z } from "zod";
import { canonicalJson, compareCanonicalStrings } from "./canonical-json.ts";
import { withCrossRuntimeWriteLock } from "./cross-runtime-lock.ts";
import type { CurrentLibraryContext, ToolOutcomeEnvelope } from "./library-binding-tools.ts";
import { assertLibraryOperationContext, readLibraryRootMarker, type LibraryOperationContext } from "./library-runtime.ts";
import {
  LOCAL_LIBRARY_PROVIDER_ID,
  assertLocalPublishedExactSelector,
  canonicalSelectorJson,
  exactSelectorDigest,
} from "./providers.ts";
import type { LocalPublishedExactSelector } from "./types.ts";
import type {
  StoredRevisionAsset,
  TemplateContentV1,
} from "./versioned-library.ts";

const HASH = /^[a-f0-9]{64}$/u;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SEMVER = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?$/u;
const TEMPLATE_ID = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;
const PRIVATE_PATH = /(?:\b[A-Za-z]:[\\/]|\\\\[^\\\s]+\\[^\\\s]+|\/(?:Users|home|mnt\/[a-z]|private\/var|var\/folders)\/)/u;
const PLAN_TTL_MS = 30 * 60 * 1_000;
const PLAN_LIMIT = 64;
const PUBLIC_PROVIDER_ID = "io.github.jarxunlai.scientific-figure-community";
const INTENT_SCHEMA = "figure-library.publication-export-intent.v1" as const;
const RECEIPT_SCHEMA = "figure-library.publication-export-receipt.v1" as const;

type PublicAssetRole = "code" | "synthetic_data" | "generated_preview" | "documentation";
type PublicAssetSource = "clean_room" | "generated" | "synthetic" | "authored";

export interface PublicationAssetDeclaration {
  logicalPath: string;
  include: boolean;
  publicPath?: string;
  role?: PublicAssetRole;
  license?: "MIT" | "CC-BY-4.0";
  source?: PublicAssetSource;
  generatedFrom?: string[];
}

export interface PublicationMetadata {
  title: string;
  description: string;
  application: string;
  dataProfile: string;
  plotFamily: string;
  language: string;
  tags: string[];
  provenance: Array<{ type: "doi" | "url" | "inspiration" | "note"; value: string }>;
}

export interface PublicationExportPlan {
  schema: "figure-library.publication-export-plan.v1";
  providerId: typeof LOCAL_LIBRARY_PROVIDER_ID;
  exactSelector: LocalPublishedExactSelector;
  releaseVersion: string;
  source: {
    libraryContext: LibraryOperationContext;
    releaseId: string;
    releaseDigest: string;
    contentDigest: string;
    reviewDigest: string;
  };
  target: string;
  publicMetadata: PublicationMetadata;
  metadataConflicts: Array<{ field: string; parent: unknown; publication: unknown }>;
  declarations: Array<PublicationAssetDeclaration & {
    sourceRole: StoredRevisionAsset["role"];
    sourceVisualRole?: StoredRevisionAsset["visualRole"];
    sourceBytes: number;
    sourceSha256: string;
    sourceMediaType: string;
  }>;
  render: {
    entrypoint: "payload/code/render.R";
    previewPath: "payload/preview/preview.png";
    sourceCode: string[];
    sourceData: string[];
    previewBytes: number;
    previewSha256: string;
    mediaType: "image/png";
    width: number;
    height: number;
    canonicalRgbaSha256: string;
  };
  rightsAttestation: {
    publisher: string;
    codeRightsConfirmed: true;
    syntheticDataConfirmed: true;
    generatedPreviewConfirmed: true;
    noThirdPartyMediaConfirmed: true;
    immutableReleaseAcknowledged: true;
  };
  excludedPrivateState: string[];
  expectedTargetState: "missing";
  written: false;
  planDigest: string;
}

interface CachedPlan {
  plan: PublicationExportPlan;
  expiresAt: number;
}

interface ExportIntent {
  schema: typeof INTENT_SCHEMA;
  intentId: string;
  libraryContext: LibraryOperationContext;
  operationId: string;
  planDigest: string;
  exactSelector: LocalPublishedExactSelector;
  exactSelectorDigest: string;
  targetPathDigest: string;
  expectedTargetState: "missing";
  plan: PublicationExportPlan;
  createdAt: string;
}

interface ExportReceipt {
  schema: typeof RECEIPT_SCHEMA;
  receiptId: string;
  libraryContext: LibraryOperationContext;
  operationId: string;
  planDigest: string;
  exactSelector: LocalPublishedExactSelector;
  exactSelectorDigest: string;
  targetPathDigest: string;
  submissionContentDigest: string;
  inventory: FileInventoryEntry[];
  inventoryDigest: string;
  appliedAt: string;
}

interface FileInventoryEntry {
  path: string;
  bytes: number;
  sha256: string;
}

type PublicationExportFaultPoint = "after_export_intent" | "before_export_receipt";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function digest(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function sha256(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

function envelope(
  result: ToolOutcomeEnvelope["outcome"],
  code: string,
  summary: string,
  nextAction: ToolOutcomeEnvelope["nextAction"] = "none",
): ToolOutcomeEnvelope {
  return {
    schema: "figure-library.tool-outcome.v1",
    outcome: result,
    terminal: true,
    retrySameCall: false,
    code,
    summary,
    nextAction,
  };
}

function reply(
  value: ToolOutcomeEnvelope,
  details: Record<string, unknown> = {},
  lines: string[] = [],
): CallToolResult {
  return {
    content: [{
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
    }],
    structuredContent: { envelope: value, ...details },
  };
}

function failure(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLocaleLowerCase("en-US");
  const conflict = lower.includes("stale") || lower.includes("already exists") || lower.includes("collision");
  const blocked = lower.includes("forbidden") || lower.includes("rights") || lower.includes("published release");
  return reply(
    envelope(
      conflict ? "conflict" : blocked ? "blocked" : "failed",
      conflict ? "publication_export_conflict" : blocked ? "publication_export_blocked" : "publication_export_failed",
      `Publication export was not completed: ${message}`,
      conflict ? "create_new_plan" : "none",
    ),
  );
}

function assertPortablePublicPath(value: string) {
  if (
    !value || value.includes("\\") || value.includes("\0") || value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value) || path.posix.normalize(value) !== value ||
    value.split("/").some((segment) => !segment || segment === "." || segment === ".." || /[<>:"|?*]/u.test(segment) || segment.endsWith(".") || segment.endsWith(" "))
  ) {
    throw new Error(`non-portable public asset path: ${value}`);
  }
  return value;
}

function expectedPublicPrefix(role: PublicAssetRole) {
  if (role === "code") return "payload/code/";
  if (role === "synthetic_data") return "payload/data/";
  if (role === "generated_preview") return "payload/preview/";
  return "payload/docs/";
}

function publicMetadataConflicts(content: TemplateContentV1, publication: PublicationMetadata) {
  const pairs: Array<[string, unknown, unknown]> = [
    ["title", content.title, publication.title],
    ["description", content.description, publication.description],
    ["application", content.visualProfile, publication.application],
    ["dataProfile", content.dataProfile, publication.dataProfile],
    ["plotFamily", content.plotFamily, publication.plotFamily],
    ["language", content.language, publication.language],
    ["tags", content.tags, publication.tags],
    ["license", content.license, { code: "MIT", content: "CC-BY-4.0", documentation: "CC-BY-4.0" }],
  ];
  return pairs
    .filter(([, parent, value]) => canonicalJson(parent) !== canonicalJson(value))
    .map(([field, parent, value]) => ({ field, parent, publication: value }));
}

function validateMetadata(value: PublicationMetadata) {
  for (const field of ["title", "description", "application", "dataProfile", "plotFamily", "language"] as const) {
    if (typeof value[field] !== "string" || !value[field].trim()) {
      throw new Error(`publicMetadata.${field} must be non-empty`);
    }
    if (PRIVATE_PATH.test(value[field])) throw new Error(`publicMetadata.${field} contains an absolute machine path`);
  }
  if (!Array.isArray(value.tags) || value.tags.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error("publicMetadata.tags must contain non-empty strings");
  }
  if (!Array.isArray(value.provenance)) throw new Error("publicMetadata.provenance must be an array");
  for (const item of value.provenance) {
    if (!isRecord(item) || !["doi", "url", "inspiration", "note"].includes(String(item.type)) || typeof item.value !== "string" || !item.value.trim()) {
      throw new Error("publicMetadata.provenance has an invalid entry");
    }
    if (PRIVATE_PATH.test(item.value)) throw new Error("publicMetadata.provenance contains an absolute machine path");
  }
  return {
    ...value,
    title: value.title.trim(),
    description: value.description.trim(),
    application: value.application.trim(),
    dataProfile: value.dataProfile.trim(),
    plotFamily: value.plotFamily.trim(),
    language: value.language.trim(),
    tags: [...new Set(value.tags.map((item) => item.trim()))].sort(compareCanonicalStrings),
    provenance: value.provenance.map((item) => ({ type: item.type, value: item.value.trim() })),
  } satisfies PublicationMetadata;
}

function validateDeclarations(content: TemplateContentV1, declarations: PublicationAssetDeclaration[]) {
  if (!Array.isArray(declarations) || declarations.length !== content.assets.length) {
    throw new Error("assetDeclarations must explicitly include or exclude every source asset");
  }
  const byPath = new Map(content.assets.map((asset) => [asset.logicalPath, asset]));
  const seen = new Set<string>();
  const publicPaths = new Set<string>();
  const output: PublicationExportPlan["declarations"] = [];
  for (const declaration of declarations) {
    if (!declaration || typeof declaration.logicalPath !== "string" || seen.has(declaration.logicalPath)) {
      throw new Error("assetDeclarations contain a duplicate or invalid logicalPath");
    }
    seen.add(declaration.logicalPath);
    const asset = byPath.get(declaration.logicalPath);
    if (!asset) throw new Error(`assetDeclarations reference an unknown source asset: ${declaration.logicalPath}`);
    if (!declaration.include) {
      if (declaration.publicPath || declaration.role || declaration.license || declaration.source || declaration.generatedFrom) {
        throw new Error(`excluded asset must not carry publication fields: ${declaration.logicalPath}`);
      }
      output.push({
        ...declaration,
        include: false,
        sourceRole: asset.role,
        ...(asset.visualRole ? { sourceVisualRole: asset.visualRole } : {}),
        sourceBytes: asset.bytes,
        sourceSha256: asset.sha256,
        sourceMediaType: asset.mediaType,
      });
      continue;
    }
    if (!declaration.publicPath || !declaration.role || !declaration.license || !declaration.source) {
      throw new Error(`included asset lacks role/path/license/source: ${declaration.logicalPath}`);
    }
    const publicPath = assertPortablePublicPath(declaration.publicPath);
    if (!publicPath.startsWith(expectedPublicPrefix(declaration.role))) {
      throw new Error(`public path does not match asset role: ${publicPath}`);
    }
    if (publicPaths.has(publicPath)) throw new Error(`public path collision: ${publicPath}`);
    publicPaths.add(publicPath);
    if (asset.role === "evidence" || asset.visualRole === "source_reference") {
      throw new Error(`forbidden source-reference/evidence asset cannot be published: ${declaration.logicalPath}`);
    }
    if (/\b(?:application\/pdf|image\/svg\+xml)\b/iu.test(asset.mediaType) || /\.(?:pdf|tiff?)$/iu.test(asset.logicalPath)) {
      throw new Error(`forbidden document/image format cannot be published: ${declaration.logicalPath}`);
    }
    if (declaration.role === "code") {
      if (asset.role !== "code" || declaration.license !== "MIT" || !/\.r$/iu.test(publicPath)) {
        throw new Error(`public code must be an R code asset licensed MIT: ${declaration.logicalPath}`);
      }
      if (!(["clean_room", "authored"] as const).includes(declaration.source as "clean_room" | "authored")) {
        throw new Error(`public code must be clean_room or authored: ${declaration.logicalPath}`);
      }
    } else {
      if (declaration.license !== "CC-BY-4.0") throw new Error(`non-code public assets require CC-BY-4.0: ${declaration.logicalPath}`);
      if (declaration.role === "generated_preview") {
        if (asset.role !== "visual" || asset.visualRole !== "rendered_output" || asset.mediaType !== "image/png" || publicPath !== "payload/preview/preview.png" || declaration.source !== "generated") {
          throw new Error("generated preview must be the rendered PNG at payload/preview/preview.png");
        }
      } else if (declaration.role === "synthetic_data") {
        if (asset.role !== "reference" || declaration.source !== "synthetic") {
          throw new Error(`synthetic data must be an explicitly synthetic reference asset: ${declaration.logicalPath}`);
        }
      } else if (asset.role !== "reference" || !(["clean_room", "authored"] as const).includes(declaration.source as "clean_room" | "authored")) {
        throw new Error(`documentation must be a clean-room/authored reference asset: ${declaration.logicalPath}`);
      }
    }
    output.push({
      ...declaration,
      publicPath,
      sourceRole: asset.role,
      ...(asset.visualRole ? { sourceVisualRole: asset.visualRole } : {}),
      sourceBytes: asset.bytes,
      sourceSha256: asset.sha256,
      sourceMediaType: asset.mediaType,
    });
  }
  if (seen.size !== byPath.size) throw new Error("assetDeclarations do not cover every source asset");
  const included = output.filter((item) => item.include);
  if (!included.some((item) => item.publicPath === "payload/code/render.R")) {
    throw new Error("publication requires a fixed payload/code/render.R entrypoint");
  }
  const preview = included.filter((item) => item.role === "generated_preview");
  if (preview.length !== 1) throw new Error("publication requires exactly one generated preview");
  const generatedFrom = preview[0]!.generatedFrom;
  if (!Array.isArray(generatedFrom) || generatedFrom.length < 2 || generatedFrom.some((item) => typeof item !== "string" || !seen.has(item))) {
    throw new Error("generated preview requires explicit code/data source trace");
  }
  const traced = generatedFrom.map((logicalPath) => output.find((item) => item.logicalPath === logicalPath)!);
  if (!traced.some((item) => item.include && item.role === "code") || !traced.some((item) => item.include && item.role === "synthetic_data")) {
    throw new Error("generated preview trace must include published code and synthetic data");
  }
  return output.sort((left, right) => compareCanonicalStrings(left.logicalPath, right.logicalPath));
}

async function resolveLocalRelease(context: CurrentLibraryContext, selector: LocalPublishedExactSelector) {
  assertLocalPublishedExactSelector(selector);
  const identity = selector.identity;
  const [content, release, history] = await Promise.all([
    context.versionedLibrary.getContent(identity.templateId, identity.revisionId, identity.contentDigest),
    context.versionedLibrary.getRelease(identity.templateId, identity.releaseId),
    context.versionedLibrary.history(identity.templateId),
  ]);
  if (
    !content || !release || release.revisionId !== identity.revisionId ||
    release.contentDigest !== identity.contentDigest ||
    !history.releases.some((item) => item.releaseId === identity.releaseId && item.revisionId === identity.revisionId && item.contentDigest === identity.contentDigest)
  ) {
    throw new Error("stale or unreachable Local Published release");
  }
  const review = await context.versionedLibrary.getReview(identity.templateId, release.reviewId);
  if (!review || review.revisionId !== release.revisionId || review.reviewDigest !== release.reviewDigest) {
    throw new Error("Published release no longer matches its immutable review");
  }
  return { content, release, review };
}

async function requireLibraryContext(context: CurrentLibraryContext): Promise<LibraryOperationContext> {
  if (!context.snapshot.writesEnabled) throw new Error("a writable global Library is required for export receipts");
  const marker = await readLibraryRootMarker(context.snapshot.root);
  if (!marker) throw new Error("global Library root marker is missing");
  if (context.snapshot.libraryId && marker.value.libraryId !== context.snapshot.libraryId) {
    throw new Error("stale Library runtime: libraryId changed");
  }
  return { libraryId: marker.value.libraryId, configRevision: context.snapshot.configRevision };
}

function targetPathDigest(target: string) {
  let normalized = path.resolve(target).normalize("NFC");
  if (process.platform === "win32") normalized = normalized.toLocaleLowerCase("en-US");
  return digest({ schema: "figure-library.native-target-path.v1", platform: process.platform, path: normalized });
}

function intentPath(context: CurrentLibraryContext, operationId: string) {
  return path.join(context.snapshot.root, "store", "operations", "intents", "publication-exports", `${operationId}.json`);
}

function receiptPath(context: CurrentLibraryContext, operationId: string) {
  return path.join(context.snapshot.root, "store", "operations", "receipts", "publication-exports", `${operationId}.json`);
}

async function readJsonIfExists(file: string) {
  try {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`operation record is not a regular file: ${file}`);
    return JSON.parse(await fs.readFile(file, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function validateIntent(value: unknown): ExportIntent {
  if (!isRecord(value) || value.schema !== INTENT_SCHEMA || typeof value.intentId !== "string" || typeof value.operationId !== "string" || !OPERATION_ID.test(value.operationId) || typeof value.planDigest !== "string" || !HASH.test(value.planDigest) || !isRecord(value.libraryContext) || typeof value.targetPathDigest !== "string" || !HASH.test(value.targetPathDigest) || value.expectedTargetState !== "missing" || !isRecord(value.plan)) {
    throw new Error("invalid publication export intent");
  }
  assertLocalPublishedExactSelector(value.exactSelector);
  const plan = value.plan as unknown as PublicationExportPlan;
  if (
    plan.schema !== "figure-library.publication-export-plan.v1" ||
    plan.planDigest !== value.planDigest ||
    digest((({ planDigest: _planDigest, ...withoutDigest }) => withoutDigest)(plan)) !== plan.planDigest ||
    canonicalJson(plan.exactSelector) !== canonicalJson(value.exactSelector) ||
    value.exactSelectorDigest !== exactSelectorDigest(value.exactSelector)
  ) {
    throw new Error("publication export intent plan or selector digest mismatch");
  }
  return value as unknown as ExportIntent;
}

function validateReceipt(value: unknown): ExportReceipt {
  if (!isRecord(value) || value.schema !== RECEIPT_SCHEMA || typeof value.receiptId !== "string" || typeof value.operationId !== "string" || !OPERATION_ID.test(value.operationId) || typeof value.planDigest !== "string" || !HASH.test(value.planDigest) || !isRecord(value.libraryContext) || typeof value.targetPathDigest !== "string" || !HASH.test(value.targetPathDigest) || typeof value.submissionContentDigest !== "string" || !HASH.test(value.submissionContentDigest) || typeof value.inventoryDigest !== "string" || !HASH.test(value.inventoryDigest) || !Array.isArray(value.inventory)) {
    throw new Error("invalid publication export receipt");
  }
  assertLocalPublishedExactSelector(value.exactSelector);
  if (
    value.inventory.some((entry) =>
      !isRecord(entry) ||
      typeof entry.path !== "string" ||
      typeof entry.bytes !== "number" ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 0 ||
      typeof entry.sha256 !== "string" ||
      !HASH.test(entry.sha256)
    ) ||
    value.exactSelectorDigest !== exactSelectorDigest(value.exactSelector) ||
    value.inventoryDigest !== digest(value.inventory)
  ) {
    throw new Error("publication export receipt digest mismatch");
  }
  return value as unknown as ExportReceipt;
}

function intentBinding(value: ExportIntent) {
  return {
    schema: value.schema,
    libraryContext: value.libraryContext,
    operationId: value.operationId,
    planDigest: value.planDigest,
    exactSelector: value.exactSelector,
    exactSelectorDigest: value.exactSelectorDigest,
    targetPathDigest: value.targetPathDigest,
    expectedTargetState: value.expectedTargetState,
    plan: value.plan,
  };
}

function assertIntentMatches(actual: ExportIntent, expected: ExportIntent) {
  if (canonicalJson(intentBinding(actual)) !== canonicalJson(intentBinding(expected))) {
    throw new Error("operationId was already used for a different publication export intent");
  }
}

function receiptBinding(value: ExportReceipt) {
  return {
    schema: value.schema,
    libraryContext: value.libraryContext,
    operationId: value.operationId,
    planDigest: value.planDigest,
    exactSelector: value.exactSelector,
    exactSelectorDigest: value.exactSelectorDigest,
    targetPathDigest: value.targetPathDigest,
    submissionContentDigest: value.submissionContentDigest,
    inventory: value.inventory,
    inventoryDigest: value.inventoryDigest,
  };
}

function assertReceiptMatches(actual: ExportReceipt, expected: ExportReceipt) {
  if (canonicalJson(receiptBinding(actual)) !== canonicalJson(receiptBinding(expected))) {
    throw new Error("operationId was already finalized for a different publication export");
  }
}

async function targetAbsent(target: string) {
  try {
    await fs.lstat(target);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

async function writeNewJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${canonicalJson(value)}\n`, { flag: "wx" });
  await fs.chmod(file, 0o444).catch(() => undefined);
}

function pngIdentity(bytes: Uint8Array) {
  const decoded = PNG.sync.read(Buffer.from(bytes), { checkCRC: true });
  if (!decoded.width || !decoded.height || decoded.width > 16_384 || decoded.height > 16_384) {
    throw new Error("generated preview has unsafe dimensions");
  }
  return {
    width: decoded.width,
    height: decoded.height,
    canonicalRgbaSha256: sha256(decoded.data),
  };
}

function assertNoPrivatePathText(bytes: Uint8Array, mediaType: string, logicalPath: string) {
  if (!/^(?:text\/|application\/(?:json|yaml|x-yaml))/u.test(mediaType) && !/\.(?:r|md|txt|csv|tsv|json|ya?ml)$/iu.test(logicalPath)) return;
  const text = Buffer.from(bytes).toString("utf8");
  if (text.includes("\uFFFD")) throw new Error(`public text asset is not valid UTF-8: ${logicalPath}`);
  if (PRIVATE_PATH.test(text)) throw new Error(`public asset contains an absolute/private machine path: ${logicalPath}`);
}

export async function createPublicationExportPlan(input: {
  context: CurrentLibraryContext;
  exactSelector: LocalPublishedExactSelector;
  releaseVersion: string;
  target: string;
  publicMetadata: PublicationMetadata;
  assetDeclarations: PublicationAssetDeclaration[];
  confirmMetadataConflicts: boolean;
  rightsAttestation: PublicationExportPlan["rightsAttestation"];
}): Promise<PublicationExportPlan> {
  if (!SEMVER.test(input.releaseVersion)) throw new Error("releaseVersion must be semantic version syntax");
  if (!path.isAbsolute(input.target)) throw new Error("publication export target must be absolute");
  if (!(await targetAbsent(path.resolve(input.target)))) throw new Error(`publication export target already exists: ${path.resolve(input.target)}`);
  const libraryContext = await requireLibraryContext(input.context);
  const { content, release } = await resolveLocalRelease(input.context, input.exactSelector);
  if (!TEMPLATE_ID.test(content.templateId)) throw new Error("Local templateId is not portable for public publication");
  const publicMetadata = validateMetadata(input.publicMetadata);
  const declarations = validateDeclarations(content, input.assetDeclarations);
  const metadataConflicts = publicMetadataConflicts(content, publicMetadata);
  if (metadataConflicts.length && input.confirmMetadataConflicts !== true) {
    throw new Error("parent metadata/license conflicts require explicit confirmation");
  }
  const rights = input.rightsAttestation;
  if (!rights || typeof rights.publisher !== "string" || !rights.publisher.trim() || rights.codeRightsConfirmed !== true || rights.syntheticDataConfirmed !== true || rights.generatedPreviewConfirmed !== true || rights.noThirdPartyMediaConfirmed !== true || rights.immutableReleaseAcknowledged !== true) {
    throw new Error("complete per-publication rights attestation is required");
  }
  if (PRIVATE_PATH.test(rights.publisher)) {
    throw new Error("rightsAttestation.publisher contains an absolute machine path");
  }
  const previewDeclaration = declarations.find((item) => item.include && item.role === "generated_preview")!;
  const preview = await input.context.versionedLibrary.readAsset({
    templateId: content.templateId,
    revisionId: content.revisionId,
    contentDigest: content.contentDigest,
    logicalPath: previewDeclaration.logicalPath,
  });
  const png = pngIdentity(preview.bytes);
  const traced = previewDeclaration.generatedFrom ?? [];
  const render = {
    entrypoint: "payload/code/render.R" as const,
    previewPath: "payload/preview/preview.png" as const,
    sourceCode: declarations.filter((item) => item.include && item.role === "code" && traced.includes(item.logicalPath)).map((item) => item.publicPath!).sort(compareCanonicalStrings),
    sourceData: declarations.filter((item) => item.include && item.role === "synthetic_data" && traced.includes(item.logicalPath)).map((item) => item.publicPath!).sort(compareCanonicalStrings),
    previewBytes: preview.asset.bytes,
    previewSha256: preview.asset.sha256,
    mediaType: "image/png" as const,
    ...png,
  };
  const withoutDigest = {
    schema: "figure-library.publication-export-plan.v1" as const,
    providerId: LOCAL_LIBRARY_PROVIDER_ID as typeof LOCAL_LIBRARY_PROVIDER_ID,
    exactSelector: input.exactSelector,
    releaseVersion: input.releaseVersion,
    source: {
      libraryContext,
      releaseId: release.releaseId,
      releaseDigest: release.releaseDigest,
      contentDigest: content.contentDigest,
      reviewDigest: release.reviewDigest,
    },
    target: path.resolve(input.target),
    publicMetadata,
    metadataConflicts,
    declarations,
    render,
    rightsAttestation: { ...rights, publisher: rights.publisher.trim() },
    excludedPrivateState: [
      "library.json", "libraryId", "series/history", "working revisions", "operations", "receipts",
      "imports", "quarantine", "locator", "absolute machine paths", "unselected assets", "other templates",
    ],
    expectedTargetState: "missing" as const,
    written: false as const,
  };
  return { ...withoutDigest, planDigest: digest(withoutDigest) };
}

function outputTemplate(plan: PublicationExportPlan, contentDigest: string) {
  return {
    schema: "figure-library.public-template-archive.v1",
    providerId: PUBLIC_PROVIDER_ID,
    templateId: plan.exactSelector.identity.templateId,
    releaseVersion: plan.releaseVersion,
    contentDigest,
    metadata: {
      ...plan.publicMetadata,
      upstreamStatus: "published",
      publisherVerified: false,
      curationStatus: "unreviewed",
      renderValidation: "publisher_attested",
      localReviewStatus: "not_reviewed",
      plotExecutionByRecipient: "not_run",
    },
    licenses: { code: "MIT", syntheticData: "CC-BY-4.0", preview: "CC-BY-4.0", documentation: "CC-BY-4.0" },
    render: plan.render,
    codeExecutedBySflClient: false,
  };
}

function publicationContentDigest(plan: PublicationExportPlan) {
  const selected = plan.declarations.filter((item) => item.include);
  return digest({
    schema: "figure-library.public-template-content-digest.v1",
    providerId: PUBLIC_PROVIDER_ID,
    templateId: plan.exactSelector.identity.templateId,
    releaseVersion: plan.releaseVersion,
    metadata: plan.publicMetadata,
    licenses: { code: "MIT", content: "CC-BY-4.0", documentation: "CC-BY-4.0" },
    assets: selected.map((item) => ({
      path: item.publicPath,
      bytes: item.sourceBytes,
      sha256: item.sourceSha256,
      role: item.role,
      license: item.license,
      source: item.source,
    })),
    render: plan.render,
  });
}

interface PreparedPublicationOutput {
  contentDigest: string;
  inventory: FileInventoryEntry[];
  files: Map<string, Uint8Array>;
}

async function preparePublicationOutput(
  context: CurrentLibraryContext,
  plan: PublicationExportPlan,
): Promise<PreparedPublicationOutput> {
  const resolved = await resolveLocalRelease(context, plan.exactSelector);
  if (
    resolved.content.contentDigest !== plan.source.contentDigest ||
    resolved.release.releaseDigest !== plan.source.releaseDigest ||
    resolved.release.reviewDigest !== plan.source.reviewDigest
  ) {
    throw new Error("stale Local Published release changed after publication Plan");
  }
  const selected = plan.declarations.filter((item) => item.include);
  const sourceBytes = new Map<string, Uint8Array>();
  for (const declaration of selected) {
    const loaded = await context.versionedLibrary.readAsset({
      templateId: plan.exactSelector.identity.templateId,
      revisionId: plan.exactSelector.identity.revisionId,
      contentDigest: plan.exactSelector.identity.contentDigest,
      logicalPath: declaration.logicalPath,
    });
    if (loaded.asset.sha256 !== declaration.sourceSha256 || loaded.asset.bytes !== declaration.sourceBytes) {
      throw new Error(`stale source asset changed after publication Plan: ${declaration.logicalPath}`);
    }
    assertNoPrivatePathText(loaded.bytes, loaded.asset.mediaType, declaration.logicalPath);
    sourceBytes.set(declaration.logicalPath, loaded.bytes);
  }
  const contentDigest = publicationContentDigest(plan);
  const template = outputTemplate(plan, contentDigest);
  const licenses = { schema: "figure-library.publication-licenses.v1", code: "MIT", syntheticData: "CC-BY-4.0", preview: "CC-BY-4.0", documentation: "CC-BY-4.0" };
  const renderReceipt = {
    schema: "figure-library.render-receipt.v1",
    entrypoint: plan.render.entrypoint,
    inputPaths: plan.render.sourceData,
    codePaths: plan.render.sourceCode,
    previewPath: plan.render.previewPath,
    previewBytes: plan.render.previewBytes,
    previewSha256: plan.render.previewSha256,
    mediaType: plan.render.mediaType,
    width: plan.render.width,
    height: plan.render.height,
    canonicalRgbaSha256: plan.render.canonicalRgbaSha256,
    sourceExecution: "publisher_attested",
    codeExecutedBySflClient: false,
  };
  const submissionAssets = [
    ...selected.map((item) => ({
      path: item.publicPath!, role: item.role!, include: true as const, source: item.source!, license: item.license!, bytes: item.sourceBytes, sha256: item.sourceSha256,
      ...(item.generatedFrom ? { generatedFrom: item.generatedFrom.map((logicalPath) => plan.declarations.find((candidate) => candidate.logicalPath === logicalPath)?.publicPath).filter((value): value is string => Boolean(value)) } : {}),
    })),
  ];
  const submission = {
    schema: "figure-library.publication-submission.v1",
    providerId: PUBLIC_PROVIDER_ID,
    templateId: plan.exactSelector.identity.templateId,
    releaseVersion: plan.releaseVersion,
    contentDigest,
    parentLocalRelease: {
      relationship: "sanitized-export-from-local-published",
      explicitlySelectedAssetsOnly: true,
      privateLifecycleIdentifiersIncluded: false,
    },
    assets: submissionAssets,
    rightsAttestation: plan.rightsAttestation,
    excludedPrivateState: plan.excludedPrivateState,
    createdAt: resolved.release.publishedAt,
  };
  const files = new Map<string, Uint8Array>(
    selected.map((item) => [item.publicPath!, sourceBytes.get(item.logicalPath)!]),
  );
  const generated = new Map<string, Uint8Array>([
    ["submission.json", Buffer.from(`${canonicalJson(submission)}\n`, "utf8")],
    ["licenses.json", Buffer.from(`${canonicalJson(licenses)}\n`, "utf8")],
    ["render-receipt.json", Buffer.from(`${canonicalJson(renderReceipt)}\n`, "utf8")],
    ["payload/template.json", Buffer.from(`${canonicalJson(template)}\n`, "utf8")],
  ]);
  for (const [relative, bytes] of generated) files.set(relative, bytes);
  const inventory: FileInventoryEntry[] = [
    ...selected.map((item) => ({ path: item.publicPath!, bytes: item.sourceBytes, sha256: item.sourceSha256 })),
    ...[...generated.entries()].map(([relative, bytes]) => ({ path: relative, bytes: bytes.byteLength, sha256: sha256(bytes) })),
  ].sort((left, right) => compareCanonicalStrings(left.path, right.path));
  const inventoryText = `${inventory.map((item) => canonicalJson(item)).join("\n")}\n`;
  files.set("inventory.jsonl", Buffer.from(inventoryText, "utf8"));
  return { contentDigest, inventory, files };
}

async function writePreparedOutput(staging: string, prepared: PreparedPublicationOutput) {
  await fs.mkdir(staging, { recursive: false });
  for (const [relative, bytes] of [...prepared.files.entries()].sort(([left], [right]) => compareCanonicalStrings(left, right))) {
    assertPortablePublicPath(relative);
    const target = path.join(staging, ...relative.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes, { flag: "wx" });
  }
}

async function inspectExportTarget(target: string) {
  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("publication export target is not a regular directory");
  const inventory: FileInventoryEntry[] = [];
  const walk = async (directory: string, relativeDirectory = ""): Promise<void> => {
    const entries = (await fs.readdir(directory, { withFileTypes: true })).sort((left, right) => compareCanonicalStrings(left.name, right.name));
    for (const entry of entries) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      assertPortablePublicPath(relative);
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`publication export contains a symlink: ${relative}`);
      if (entry.isDirectory()) await walk(absolute, relative);
      else if (entry.isFile() && relative !== "inventory.jsonl") {
        const bytes = new Uint8Array(await fs.readFile(absolute));
        inventory.push({ path: relative, bytes: bytes.byteLength, sha256: sha256(bytes) });
      } else if (!entry.isFile()) throw new Error(`publication export contains a non-file: ${relative}`);
    }
  };
  await walk(target);
  inventory.sort((left, right) => compareCanonicalStrings(left.path, right.path));
  const declared = (await fs.readFile(path.join(target, "inventory.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as FileInventoryEntry);
  if (canonicalJson(declared) !== canonicalJson(inventory)) throw new Error("publication export inventory does not match target files");
  const template = JSON.parse(await fs.readFile(path.join(target, "payload", "template.json"), "utf8")) as unknown;
  if (!isRecord(template) || template.schema !== "figure-library.public-template-archive.v1" || typeof template.contentDigest !== "string" || !HASH.test(template.contentDigest)) {
    throw new Error("publication export template manifest is invalid");
  }
  return { inventory, contentDigest: template.contentDigest };
}

const ExactSelectorSchema = z.record(z.string(), z.unknown());
const PublicMetadataSchema = z.object({
  title: z.string().min(1).max(300),
  description: z.string().min(1).max(4_000),
  application: z.string().min(1).max(4_000),
  dataProfile: z.string().min(1).max(4_000),
  plotFamily: z.string().min(1).max(200),
  language: z.string().min(1).max(100),
  tags: z.array(z.string().min(1).max(100)).max(100),
  provenance: z.array(z.object({ type: z.enum(["doi", "url", "inspiration", "note"]), value: z.string().min(1).max(4_000) })).max(100),
});
const AssetDeclarationSchema = z.object({
  logicalPath: z.string().min(1).max(1_000),
  include: z.boolean(),
  publicPath: z.string().min(1).max(1_000).optional(),
  role: z.enum(["code", "synthetic_data", "generated_preview", "documentation"]).optional(),
  license: z.enum(["MIT", "CC-BY-4.0"]).optional(),
  source: z.enum(["clean_room", "generated", "synthetic", "authored"]).optional(),
  generatedFrom: z.array(z.string().min(1).max(1_000)).max(100).optional(),
});
const RightsSchema = z.object({
  publisher: z.string().min(1).max(200),
  codeRightsConfirmed: z.literal(true),
  syntheticDataConfirmed: z.literal(true),
  generatedPreviewConfirmed: z.literal(true),
  noThirdPartyMediaConfirmed: z.literal(true),
  immutableReleaseAcknowledged: z.literal(true),
});
const PlanInput = z.object({
  providerId: z.literal(LOCAL_LIBRARY_PROVIDER_ID),
  exactSelector: ExactSelectorSchema,
  releaseVersion: z.string().regex(SEMVER),
  target: z.string().min(1).max(4_000),
  publicMetadata: PublicMetadataSchema,
  assetDeclarations: z.array(AssetDeclarationSchema).min(1).max(10_000),
  confirmMetadataConflicts: z.boolean().default(false),
  rightsAttestation: RightsSchema,
});
const ApplyInput = z.object({
  planDigest: z.string().regex(HASH),
  operationId: z.string().regex(OPERATION_ID),
  expectedTarget: z.string().min(1).max(4_000),
});

export function registerPublicationExportTools(options: {
  server: McpServer;
  currentLibraries: () => Promise<CurrentLibraryContext>;
  faultInjector?: (
    point: PublicationExportFaultPoint,
    operation: { operationId: string; planDigest: string; target: string },
  ) => Promise<void> | void;
}) {
  const plans = new Map<string, CachedPlan>();
  const prune = () => {
    const now = Date.now();
    for (const [key, value] of plans) if (value.expiresAt <= now) plans.delete(key);
    while (plans.size > PLAN_LIMIT) {
      const oldest = plans.keys().next().value as string | undefined;
      if (!oldest) break;
      plans.delete(oldest);
    }
  };

  options.server.registerTool(
    "figure_library_plan_publication_export",
    {
      title: "Plan a sanitized public-template submission export",
      description: "Resolve one exact reachable Local Published Release and show every included/excluded asset, rights declaration, public metadata conflict, render trace, and target without writing files.",
      inputSchema: PlanInput.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input): Promise<CallToolResult> => {
      try {
        const exactSelector = input.exactSelector as unknown as LocalPublishedExactSelector;
        assertLocalPublishedExactSelector(exactSelector);
        const plan = await createPublicationExportPlan({
          context: await options.currentLibraries(),
          exactSelector,
          releaseVersion: input.releaseVersion,
          target: input.target,
          publicMetadata: input.publicMetadata,
          assetDeclarations: input.assetDeclarations,
          confirmMetadataConflicts: input.confirmMetadataConflicts,
          rightsAttestation: input.rightsAttestation,
        });
        prune();
        plans.set(plan.planDigest, { plan, expiresAt: Date.now() + PLAN_TTL_MS });
        return reply(
          envelope("needs_user_confirmation", "publication_export_plan_ready", "No files were written. Review every included/excluded asset, rights declaration, metadata conflict, render trace, and target before Apply.", "apply_confirmed_plan"),
          { plan },
          [
            `PLAN_DIGEST: ${plan.planDigest}`,
            `EXACT_SELECTOR: ${canonicalSelectorJson(plan.exactSelector)}`,
            `TARGET: ${plan.target}`,
            `INCLUDED: ${plan.declarations.filter((item) => item.include).map((item) => `${item.logicalPath}->${item.publicPath}`).join(", ")}`,
            `EXCLUDED: ${plan.declarations.filter((item) => !item.include).map((item) => item.logicalPath).join(", ") || "none"}`,
            `METADATA_CONFLICTS: ${canonicalJson(plan.metadataConflicts)}`,
            "WRITTEN: false",
          ],
        );
      } catch (error) {
        return failure(error);
      }
    },
  );

  options.server.registerTool(
    "figure_library_apply_publication_export",
    {
      title: "Apply a confirmed sanitized publication export",
      description: "Revalidate the exact Local Published Release and selected asset bytes, then atomically create one deterministic sanitized submission at a new target. This call never uses the network, signs content, or creates a PR.",
      inputSchema: ApplyInput.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input): Promise<CallToolResult> => {
      try {
        if (!path.isAbsolute(input.expectedTarget)) throw new Error("expectedTarget must be absolute");
        const target = path.resolve(input.expectedTarget);
        const context = await options.currentLibraries();
        const libraryContext = await requireLibraryContext(context);
        const receiptFile = receiptPath(context, input.operationId);
        const intentFile = intentPath(context, input.operationId);
        const priorReceiptValue = await readJsonIfExists(receiptFile);
        if (priorReceiptValue) {
          const receipt = validateReceipt(priorReceiptValue);
          assertLibraryOperationContext(libraryContext, receipt.libraryContext);
          if (receipt.planDigest !== input.planDigest || receipt.operationId !== input.operationId || receipt.targetPathDigest !== targetPathDigest(target)) {
            throw new Error("operationId was already used for a different publication export");
          }
          const observed = await inspectExportTarget(target);
          if (observed.contentDigest !== receipt.submissionContentDigest || canonicalJson(observed.inventory) !== canonicalJson(receipt.inventory)) {
            throw new Error("existing publication export disagrees with its authoritative receipt");
          }
          return reply(envelope("replayed", "publication_export_replayed", `Verified the existing sanitized submission at ${target}.`), { planDigest: input.planDigest, target, receipt });
        }
        prune();
        const cached = plans.get(input.planDigest);
        const priorIntentValue = await readJsonIfExists(intentFile);
        if (!cached && !priorIntentValue) {
          return reply(envelope("blocked", "publication_export_plan_not_available", "The publication Plan expired or belongs to another server process. Create and review a new Plan.", "create_new_plan"));
        }
        const priorIntent = priorIntentValue ? validateIntent(priorIntentValue) : undefined;
        const plan = cached?.plan ?? priorIntent?.plan;
        if (!plan || plan.planDigest !== input.planDigest) {
          throw new Error("an unfinished publication export intent does not contain the expected authoritative Plan");
        }
        if (plan.target !== target) throw new Error("expectedTarget does not match the publication Plan");
        const expectedIntent: ExportIntent = {
          schema: INTENT_SCHEMA,
          intentId: `publication-export-intent-${randomUUID()}`,
          libraryContext,
          operationId: input.operationId,
          planDigest: input.planDigest,
          exactSelector: plan.exactSelector,
          exactSelectorDigest: exactSelectorDigest(plan.exactSelector),
          targetPathDigest: targetPathDigest(target),
          expectedTargetState: "missing",
          plan,
          createdAt: new Date().toISOString(),
        };
        if (priorIntent) {
          assertIntentMatches(priorIntent, expectedIntent);
        } else {
          await withCrossRuntimeWriteLock(
            { root: context.snapshot.root, lockDirectory: path.join(context.snapshot.root, "locks", "write"), libraryId: libraryContext.libraryId, operation: `publication-export-intent:${input.operationId}` },
            async () => {
              const existing = await readJsonIfExists(intentFile);
              if (existing) assertIntentMatches(validateIntent(existing), expectedIntent);
              else await writeNewJson(intentFile, expectedIntent);
            },
          );
        }
        await options.faultInjector?.("after_export_intent", {
          operationId: input.operationId,
          planDigest: plan.planDigest,
          target,
        });
        const prepared = await preparePublicationOutput(context, plan);
        let applied: { contentDigest: string; inventory: FileInventoryEntry[] };
        let recovered = Boolean(priorIntent);
        if (!(await targetAbsent(target))) {
          if (!priorIntent) throw new Error(`publication export target already exists: ${target}`);
          const observed = await inspectExportTarget(target);
          if (
            observed.contentDigest !== prepared.contentDigest ||
            canonicalJson(observed.inventory) !== canonicalJson(prepared.inventory)
          ) {
            throw new Error("existing publication export disagrees with its authoritative intent");
          }
          applied = observed;
          recovered = true;
        } else {
          const parent = path.dirname(target);
          await fs.mkdir(parent, { recursive: true });
          const staging = path.join(parent, `.${path.basename(target)}.${randomUUID()}.tmp`);
          try {
            await writePreparedOutput(staging, prepared);
            applied = { contentDigest: prepared.contentDigest, inventory: prepared.inventory };
            await fs.rename(staging, target);
          } catch (error) {
            await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
            throw error;
          }
        }
        const receipt: ExportReceipt = {
          schema: RECEIPT_SCHEMA,
          receiptId: `publication-export-receipt-${randomUUID()}`,
          libraryContext,
          operationId: input.operationId,
          planDigest: plan.planDigest,
          exactSelector: plan.exactSelector,
          exactSelectorDigest: exactSelectorDigest(plan.exactSelector),
          targetPathDigest: targetPathDigest(target),
          submissionContentDigest: applied.contentDigest,
          inventory: applied.inventory,
          inventoryDigest: digest(applied.inventory),
          appliedAt: new Date().toISOString(),
        };
        await options.faultInjector?.("before_export_receipt", {
          operationId: input.operationId,
          planDigest: plan.planDigest,
          target,
        });
        let authoritativeReceipt = receipt;
        await withCrossRuntimeWriteLock(
          { root: context.snapshot.root, lockDirectory: path.join(context.snapshot.root, "locks", "write"), libraryId: libraryContext.libraryId, operation: `publication-export-receipt:${input.operationId}` },
          async () => {
            const existing = await readJsonIfExists(receiptFile);
            if (existing) {
              authoritativeReceipt = validateReceipt(existing);
              assertReceiptMatches(authoritativeReceipt, receipt);
            }
            else await writeNewJson(receiptFile, receipt);
          },
        );
        plans.delete(plan.planDigest);
        return reply(
          envelope(
            recovered ? "replayed" : "applied",
            recovered ? "publication_export_recovered" : "publication_export_applied",
            `${recovered ? "Recovered and verified" : "Created"} one sanitized deterministic public submission at ${target}. No network, signing, PR creation, package installation, or template code execution occurred.`,
          ),
          { planDigest: plan.planDigest, target, receipt: authoritativeReceipt, recovered },
        );
      } catch (error) {
        return failure(error);
      }
    },
  );
}
