import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { buildSearchIntent, CatalogIndex } from "./catalog.ts";
import {
  inspectFigureYaSourcePack,
  materializeFigureYaTemplate,
} from "./materialize.ts";
import type { TemplateCandidate } from "./types.ts";
import { managementReference, UserTemplateLibrary } from "./user-library.ts";

const VERSION = "0.3.0";
const RESOURCE_URI = "ui://figure-library/candidates.html";
const APP_HTML = path.resolve(import.meta.dirname, "mcp-app.html");

const ImportAdapterSchema = z.enum(["direct", "gallery", "figure-transfer-package"]);
const IdentityModeSchema = z.enum(["stable-source", "content-addressed"]);
const FingerprintsSchema = z.object({
  algorithm: z.literal("figure-library.asset-fingerprints.v1"),
  previewSha256: z.string().optional(),
  executableCodeSetSha256: z.string().optional(),
  dataSetSha256: z.string().optional(),
  metadataSetSha256: z.string().optional(),
  fullAssetSha256: z.string(),
});
const ManagementSchema = z.object({
  templateId: z.string(),
  adapter: ImportAdapterSchema.optional(),
  registrySourceId: z.string().optional(),
  galleryId: z.string().optional(),
  identityMode: IdentityModeSchema.optional(),
  canArchive: z.boolean(),
  canUpdate: z.boolean(),
  updateVia: z.enum(["plan-apply", "diff-upsert", "gallery-sync"]).optional(),
});

const CandidateSchema = z.object({
  templateId: z.string(),
  sourceId: z.enum(["figureya", "user"]),
  sourceLabel: z.string(),
  title: z.string(),
  retrievalScore: z.number(),
  matchedTerms: z.array(z.string()),
  reasons: z.array(z.string()),
  warnings: z.array(z.string()),
  excerpt: z.string(),
  description: z.string(),
  application: z.string(),
  dataProfile: z.string(),
  inputFiles: z.array(z.string()),
  codeFiles: z.array(z.string()),
  packages: z.array(z.string()),
  materializable: z.boolean(),
  previewAvailable: z.boolean(),
  assetKind: z.enum(["plot_template", "visual_reference"]),
  language: z.string(),
  plotFamily: z.string(),
  reviewStatus: z.enum(["draft", "approved", "archived"]),
  codeStatus: z.enum(["none", "scaffold", "reviewed"]),
  license: z.string(),
  sourceUrl: z.string().optional(),
  reportUrl: z.string().optional(),
  previewDataUrl: z.string().optional(),
  management: ManagementSchema,
});

const SearchInput = z.object({
  query: z
    .string()
    .min(1)
    .max(2_000)
    .describe("Plotting intent and scientific purpose, in Chinese or English."),
  dataProfile: z
    .string()
    .max(2_000)
    .optional()
    .describe("Compact shape, column/type, semantic-role, and missingness summary. No raw data."),
  visualProfile: z
    .string()
    .max(2_000)
    .optional()
    .describe("Compact chart family, layout, axes, encodings, labels, and style summary."),
  assetKind: z
    .enum(["plot_template", "visual_reference"])
    .optional()
    .describe("Filter reusable plotting templates separately from visual-only references."),
  language: z.string().min(1).max(100).optional(),
  plotFamily: z.string().min(1).max(200).optional(),
  reviewStatus: z.enum(["draft", "approved", "archived"]).optional(),
  codeStatus: z.enum(["none", "scaffold", "reviewed"]).optional(),
  sourceIds: z
    .array(z.enum(["figureya", "user"]))
    .min(1)
    .max(2)
    .optional()
    .default(["figureya", "user"])
    .describe("Optional source filter. By default both FigureYa and the user library are searched."),
  limit: z.number().int().min(1).max(12).optional().default(6),
});

const SearchOutput = z.object({
  query: z.string(),
  libraryVersion: z.string(),
  intentFamilies: z.array(z.string()),
  reviewRequired: z.boolean(),
  sources: z.array(
    z.object({
      sourceId: z.enum(["figureya", "user"]),
      sourceLabel: z.string(),
      matched: z.number().int(),
    }),
  ),
  candidates: z.array(CandidateSchema),
});

const OpenInput = z.object({});

const ImportInput = z
  .object({
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(4_000).optional(),
    tags: z.array(z.string().min(1).max(100)).max(40).optional(),
    visualProfile: z.string().max(2_000).optional(),
    dataProfile: z.string().max(2_000).optional(),
    packages: z.array(z.string().min(1).max(100)).max(40).optional(),
    license: z.string().max(500).optional(),
    assetKind: z.enum(["plot_template", "visual_reference"]).optional(),
    language: z.string().min(1).max(100).optional(),
    plotFamily: z.string().max(200).optional(),
    reviewStatus: z.enum(["draft", "approved", "archived"]).optional(),
    codeStatus: z.enum(["none", "scaffold", "reviewed"]).optional(),
    packagePath: z
      .string()
      .min(1)
      .max(2_000)
      .optional()
      .describe("Host-local path to a versioned Figure Transfer Package ZIP."),
    imagePath: z
      .string()
      .min(1)
      .max(2_000)
      .optional()
      .describe("Host-local path to a PNG, JPEG, WebP, SVG, or PDF reference."),
    codePaths: z
      .array(z.string().min(1).max(2_000))
      .max(20)
      .optional()
      .describe("Host-local paths to code/reference files. Files are copied but never executed."),
    sourceKey: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Portable stable source key for updateable direct imports. Never use a host path or secret."),
  })
  .superRefine((value, context) => {
    const direct = Boolean(value.imagePath || value.codePaths?.length);
    if (Boolean(value.packagePath) === direct) {
      context.addIssue({
        code: "custom",
        message: "provide packagePath, or title plus imagePath/codePaths, but not both",
      });
    }
    if (direct && !value.title) {
      context.addIssue({ code: "custom", message: "title is required for a direct import" });
    }
  });

const ImportOutput = z.object({
  templateId: z.string(),
  sourceId: z.literal("user"),
  title: z.string(),
  directory: z.string(),
  files: z.array(z.string()),
  existed: z.boolean(),
  action: z.enum(["create", "unchanged", "update"]),
  contentHash: z.string().optional(),
  reviewStatus: z.enum(["draft", "approved", "archived"]),
  warning: z.string(),
});

const DirectImportInput = z
  .object({
    title: z.string().min(1).max(200),
    description: z.string().max(4_000).optional(),
    tags: z.array(z.string().min(1).max(100)).max(40).optional(),
    visualProfile: z.string().max(2_000).optional(),
    dataProfile: z.string().max(2_000).optional(),
    packages: z.array(z.string().min(1).max(100)).max(40).optional(),
    license: z.string().max(500).optional(),
    assetKind: z.enum(["plot_template", "visual_reference"]).optional(),
    language: z.string().min(1).max(100).optional(),
    plotFamily: z.string().max(200).optional(),
    reviewStatus: z.enum(["draft", "approved", "archived"]).optional(),
    codeStatus: z.enum(["none", "scaffold", "reviewed"]).optional(),
    imagePath: z.string().min(1).max(2_000).optional(),
    codePaths: z.array(z.string().min(1).max(2_000)).max(20).optional(),
    sourceKey: z.string().min(1).max(200).optional(),
  })
  .refine((value) => Boolean(value.imagePath || value.codePaths?.length), {
    message: "provide imagePath or at least one codePaths entry",
  });

const ImportSourceInput = z
  .object({
    packagePath: z.string().min(1).max(2_000).optional(),
    galleryPath: z.string().min(1).max(2_000).optional(),
    sourceCommit: z.string().min(1).max(200).optional(),
  })
  .refine((value) => Boolean(value.packagePath) !== Boolean(value.galleryPath), {
    message: "provide exactly one of packagePath or galleryPath",
  });

const ImportChangeSchema = z.object({
  field: z.string(),
  before: z.unknown(),
  after: z.unknown(),
});

const DirectImportActionSchema = z.enum([
  "create",
  "unchanged",
  "update",
  "duplicate_candidate",
  "source_conflict",
]);
const DirectImportMatchSchema = z.object({
  templateId: z.string(),
  title: z.string(),
  matchKinds: z.array(z.string()),
  manifestSha256: z.string(),
});
const DirectImportPlanOutput = z.object({
  action: DirectImportActionSchema,
  normalizedTitle: z.string(),
  proposedTemplateId: z.string(),
  registrySourceId: z.string(),
  identityMode: IdentityModeSchema,
  fingerprints: FingerprintsSchema,
  contentHash: z.string(),
  changes: z.array(ImportChangeSchema),
  matches: z.array(DirectImportMatchSchema),
  planDigest: z.string(),
  written: z.literal(false),
});
const DirectImportApplyInput = z.object({
  ...DirectImportInput.shape,
  planDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  expectedAction: DirectImportActionSchema,
  expectedTemplateId: z.string().min(1).max(200),
  operationId: z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
  duplicateResolution: z
    .union([
      z.object({
        action: z.literal("reuse"),
        templateId: z.string().min(1).max(200),
        reason: z.string().min(1).max(1_000),
      }),
      z.object({
        action: z.literal("create_separate"),
        reason: z.string().min(1).max(1_000),
      }),
    ])
    .optional(),
  sourceConflictResolution: z
    .object({
      action: z.literal("replace_source"),
      reason: z.string().min(1).max(1_000),
    })
    .optional(),
});
const DirectImportApplyOutput = z.object({
  templateId: z.string(),
  title: z.string(),
  directory: z.string(),
  action: z.enum(["create", "unchanged", "update", "reused"]),
  replayed: z.boolean(),
  plan: DirectImportPlanOutput,
  warning: z.string(),
});

const ImportDiffSchema = z.object({
  action: z.enum(["create", "unchanged", "update", "skipped"]),
  adapter: ImportAdapterSchema,
  sourceId: z.string(),
  galleryId: z.string().optional(),
  templateId: z.string(),
  incomingContentHash: z.string(),
  existingContentHash: z.string().optional(),
  sourceCommit: z.string().optional(),
  reviewStatus: z.enum(["draft", "approved", "archived"]),
  changes: z.array(ImportChangeSchema),
  reason: z.string().optional(),
});

const UpsertOutput = z.object({
  templateId: z.string(),
  sourceId: z.literal("user"),
  title: z.string(),
  directory: z.string(),
  action: z.enum(["create", "unchanged", "update"]),
  contentHash: z.string(),
  reviewStatus: z.enum(["draft", "approved", "archived"]),
  diff: ImportDiffSchema.optional(),
  warning: z.string(),
});

const GallerySyncInput = z.object({
  galleryDirectory: z
    .string()
    .min(1)
    .max(2_000)
    .optional()
    .describe("Personal Gallery root; otherwise FIGURE_GALLERY_DIR is used."),
  dryRun: z.boolean().optional().default(true),
  sourceCommit: z.string().min(1).max(200).optional(),
  assetKind: z.enum(["plot_template", "visual_reference"]).optional(),
  language: z.string().min(1).max(100).optional(),
  plotFamily: z.string().min(1).max(200).optional(),
  reviewStatus: z.enum(["draft", "approved", "archived"]).optional(),
  codeStatus: z.enum(["none", "scaffold", "reviewed"]).optional(),
});

const GallerySyncOutput = z.object({
  galleryDirectory: z.string(),
  dryRun: z.boolean(),
  entries: z.number().int(),
  create: z.number().int(),
  update: z.number().int(),
  unchanged: z.number().int(),
  skipped: z.number().int(),
  results: z.array(ImportDiffSchema),
});

const ArchiveInput = z
  .object({
    templateId: z.string().min(1).max(200).optional(),
    galleryId: z.string().min(1).max(300).optional(),
    registrySourceId: z.string().min(1).max(300).optional(),
    adapter: ImportAdapterSchema.optional(),
  })
  .superRefine((value, context) => {
    const references = [value.templateId, value.galleryId, value.registrySourceId].filter(Boolean);
    if (references.length !== 1) {
      context.addIssue({
        code: "custom",
        message: "provide exactly one of templateId, galleryId, or registrySourceId + adapter",
      });
    }
    if (value.registrySourceId && !value.adapter) {
      context.addIssue({ code: "custom", message: "adapter is required with registrySourceId" });
    }
  });
const ArchiveOutput = z.object({
  templateId: z.string(),
  galleryId: z.string().optional(),
  registrySourceId: z.string().optional(),
  adapter: ImportAdapterSchema.optional(),
  previousReviewStatus: z.enum(["draft", "approved", "archived"]),
  reviewStatus: z.literal("archived"),
  directory: z.string(),
  changed: z.boolean(),
  alreadyArchived: z.boolean(),
  filesRetained: z.literal(true),
  // v0.2.0 compatibility: existed meant "already archived".
  existed: z.boolean(),
  warning: z.string(),
});

const ProvenanceSchema = z.object({
  producer: z.string().optional(),
  producerVersion: z.string().optional(),
  exportedAt: z.string().optional(),
  sourceId: z.string().optional(),
  figureId: z.string().optional(),
  parentFigureId: z.string().optional(),
  figureLabel: z.string().optional(),
  subfigureLabels: z.array(z.string()).optional(),
  caption: z.string().optional(),
  paperTitle: z.string().optional(),
  authors: z.array(z.string()).optional(),
  year: z.string().optional(),
  journal: z.string().optional(),
  doi: z.string().optional(),
  page: z.string().optional(),
  url: z.string().optional(),
  licenseScope: z.string().optional(),
  rights: z.string().optional(),
});

const RegistrySchema = z.object({
  adapter: ImportAdapterSchema,
  sourceId: z.string(),
  templateId: z.string().optional(),
  galleryId: z.string().optional(),
  contentHash: z.string(),
  sourceCommit: z.string().optional(),
  identityMode: IdentityModeSchema.optional(),
  fingerprints: FingerprintsSchema.optional(),
});

const DescribeInput = z.object({
  templateId: z.string().min(1).max(200),
});

const DescribeOutput = z.object({
  templateId: z.string(),
  sourceId: z.enum(["figureya", "user"]),
  sourceLabel: z.string(),
  title: z.string(),
  description: z.string(),
  application: z.string(),
  dataProfile: z.string(),
  inputFiles: z.array(z.string()),
  codeFiles: z.array(z.string()),
  packages: z.array(z.string()),
  materializable: z.boolean(),
  previewAvailable: z.boolean(),
  assetKind: z.enum(["plot_template", "visual_reference"]),
  language: z.string(),
  plotFamily: z.string(),
  reviewStatus: z.enum(["draft", "approved", "archived"]),
  codeStatus: z.enum(["none", "scaffold", "reviewed"]),
  license: z.string(),
  sourceUrl: z.string().optional(),
  reportUrl: z.string().optional(),
  sourceRevision: z.string().optional(),
  archiveRevision: z.string().optional(),
  citation: z.string().optional(),
  importedAt: z.string().optional(),
  previewFile: z.string().optional(),
  provenance: ProvenanceSchema.optional(),
  registry: RegistrySchema.optional(),
  management: ManagementSchema,
});

const PreviewInput = z.object({
  templateId: z.string().min(1).max(200),
  destination: z
    .string()
    .min(1)
    .max(2_000)
    .optional()
    .describe(
      "Optional directory for a local preview copy. Wisp Agents should provide a project-local directory, then call view_image on the returned path.",
    ),
});

const PreviewOutput = z.object({
  templateId: z.string(),
  sourceId: z.enum(["figureya", "user"]),
  mimeType: z.string(),
  bytes: z.number().int(),
  sha256: z.string(),
  path: z.string().optional(),
  instruction: z.string(),
});

const MaterializeInput = z.object({
  templateId: z.string().min(1).max(200),
  destination: z
    .string()
    .min(1)
    .max(2_000)
    .describe("Parent directory. The tool creates destination/<templateId> and never overwrites it."),
  mode: z
    .enum(["template", "full"])
    .optional()
    .default("template")
    .describe("For FigureYa, template selects reference files and full extracts its complete archive."),
  sourcePackDir: z
    .string()
    .min(1)
    .max(2_000)
    .optional()
    .describe(
      "Optional FigureYa Source Pack containing <templateId>.zip or archives/<templateId>.zip.",
    ),
  allowNetwork: z
    .boolean()
    .optional()
    .default(true)
    .describe("For FigureYa only. When false, fail instead of trying mirrors or GitHub."),
});

const MaterializeOutput = z.object({
  templateId: z.string(),
  sourceId: z.enum(["figureya", "user"]),
  target: z.string(),
  mode: z.enum(["template", "full"]),
  materializationSource: z.enum(["user-library", "source-pack", "network"]),
  sourceLocation: z.string().optional(),
  archiveSha256: z.string().optional(),
  files: z.array(z.string()),
  warning: z.string(),
});

const SourceStatusInput = z.object({
  sourcePackDir: z
    .string()
    .min(1)
    .max(2_000)
    .optional()
    .describe("FigureYa Source Pack directory; otherwise FIGUREYA_SOURCE_PACK_DIR is used."),
  galleryDirectory: z
    .string()
    .min(1)
    .max(2_000)
    .optional()
    .describe("Personal Gallery directory to inspect; otherwise FIGURE_GALLERY_DIR is used."),
});

const SourceStatusOutput = z.object({
  libraryDirectory: z.string(),
  libraryDirectorySource: z.enum(["FIGURE_LIBRARY_DIR", "default"]),
  galleryDirectory: z.string().optional(),
  galleryDirectorySource: z.enum(["argument", "FIGURE_GALLERY_DIR", "unset"]),
  galleryDirectoryAccessible: z.boolean(),
  userTemplateCount: z.number().int(),
  activeUserTemplateCount: z.number().int(),
  archivedUserTemplateCount: z.number().int(),
  legacyTemplateCount: z.number().int(),
  invalidTemplateCount: z.number().int(),
  duplicateGroupCount: z.number().int(),
  figureYa: z.object({
    catalogTemplates: z.number().int(),
    sourcePackConfigured: z.boolean(),
    sourcePackDirectory: z.string(),
    availableTemplates: z.array(z.string()),
    invalidTemplates: z.array(z.string()),
    missingCount: z.number().int(),
    availableBytes: z.number().int(),
    archiveRevision: z.string(),
  }),
});

const AuditInput = z.object({
  scope: z.enum(["duplicates", "legacy", "integrity", "all"]).optional().default("all"),
  includeArchived: z.boolean().optional().default(true),
});
const AuditTemplateSchema = z.object({
  templateId: z.string(),
  title: z.string(),
  reviewStatus: z.enum(["draft", "approved", "archived"]),
  codeStatus: z.enum(["none", "scaffold", "reviewed"]),
  importedAt: z.string(),
  adapter: ImportAdapterSchema.optional(),
  registrySourceId: z.string().optional(),
  galleryId: z.string().optional(),
  identityMode: IdentityModeSchema.optional(),
  contentHash: z.string().optional(),
  fingerprints: FingerprintsSchema,
  manifestSha256: z.string(),
  verifiedFileSetDigest: z.string(),
  integrityStatus: z.literal("valid"),
  legacy: z.boolean(),
  management: ManagementSchema,
  metadataCompleteness: z.number().int(),
});
const DiagnosticSchema = z.object({
  directoryName: z.string(),
  directory: z.string(),
  templateId: z.string().optional(),
  error: z.string(),
});
const AuditOutput = z.object({
  scope: z.enum(["duplicates", "legacy", "integrity", "all"]),
  includeArchived: z.boolean(),
  libraryDirectory: z.string(),
  userTemplateCount: z.number().int(),
  legacyTemplateCount: z.number().int(),
  invalidTemplateCount: z.number().int(),
  duplicateGroupCount: z.number().int(),
  invalid: z.array(DiagnosticSchema),
  templates: z.array(AuditTemplateSchema),
  duplicateGroups: z.array(
    z.object({
      groupId: z.string(),
      templateIds: z.array(z.string()),
      evidence: z.array(
        z.object({ left: z.string(), right: z.string(), matchKinds: z.array(z.string()) }),
      ),
      recommendedCanonicalTemplateId: z.string(),
      recommendationOnly: z.literal(true),
    }),
  ),
});

const ExpectedStateSchema = z.object({
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  verifiedFileSetDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  reviewStatus: z.enum(["draft", "approved", "archived"]),
});
const ReconcileInput = z.object({
  mode: z.enum(["dry-run", "apply", "rollback"]).optional().default("dry-run"),
  reconcileId: z.string().min(1).max(100).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
  canonicalTemplateId: z.string().min(1).max(200),
  duplicateTemplateIds: z.array(z.string().min(1).max(200)).min(1),
  strategy: z.literal("archive_duplicates"),
  expectedState: z.record(z.string(), ExpectedStateSchema),
  reason: z.string().min(1).max(2_000),
});
const ReconcileOutput = z.object({
  reconcileId: z.string(),
  mode: z.enum(["dry-run", "apply", "rollback"]),
  strategy: z.literal("archive_duplicates").optional(),
  canonicalTemplateId: z.string(),
  duplicateTemplateIds: z.array(z.string()).optional(),
  restoredTemplateIds: z.array(z.string()).optional(),
  recoveredIncomplete: z.boolean().optional(),
  changes: z
    .array(
      z.object({
        templateId: z.string(),
        beforeReviewStatus: z.enum(["draft", "approved", "archived"]),
        afterReviewStatus: z.literal("archived"),
        retainedFiles: z.number().int(),
      }),
    )
    .optional(),
  filesRetained: z.number().int().optional(),
  written: z.boolean(),
});

function candidateText(candidates: TemplateCandidate[]) {
  if (candidates.length === 0) return "No matching scientific figure templates were found.";
  const list = candidates
    .map((candidate, index) => {
      const reasons = candidate.reasons.join("; ") || "catalog metadata match";
      const warnings = candidate.warnings.length
        ? ` Warnings: ${candidate.warnings.join("; ")}.`
        : "";
      return (
        `${index + 1}. ${candidate.templateId} [${candidate.sourceLabel}] — ` +
        `retrieval score ${candidate.retrievalScore}/100. ${reasons}.${warnings}`
      );
    })
    .join("\n");
  return (
    "Retrieval candidates only; this is not the final recommendation.\n" +
    `${list}\n\nMANDATORY REVIEW: inspect candidate 1 with figure_library_preview and ` +
    "use visual/data reasoning before selecting it. Report an Agent visual-review verdict and " +
    "score out of 10. If it is wrong, inspect the next candidates."
  );
}

function hardStop(templateId: string, error: unknown): CallToolResult {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text:
          `STOP: ${templateId} was not materialized. Stop the plotting task now, report this ` +
          "exact failure to the user, and wait for new instructions. Do not retry with another " +
          "mode or downloader, fetch a complete repository, recreate the template, or generate " +
          `a substitute/demo plot.\nError: ${
            error instanceof Error ? error.message : String(error)
          }`,
      },
    ],
  };
}

export async function createServer() {
  const index = await CatalogIndex.load();
  const userLibrary = new UserTemplateLibrary();
  const server = new McpServer({
    name: "Scientific Figure Library",
    version: VERSION,
  });

  registerAppTool(
    server,
    "figure_library_open",
    {
      title: "Open Scientific Figure Library",
      description:
        "Open the template workbench without inventing a search when no plotting intent exists.",
      inputSchema: OpenInput.shape,
      outputSchema: SearchOutput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { ui: { resourceUri: RESOURCE_URI } },
    },
    async (): Promise<CallToolResult> => ({
      content: [
        {
          type: "text",
          text:
            "Scientific Figure Library is ready. Ask the user for a reference figure, data file, " +
            "or plotting goal before searching.",
        },
      ],
      structuredContent: {
        query: "等待绘图目标",
        libraryVersion: VERSION,
        intentFamilies: [],
        reviewRequired: false,
        sources: [
          { sourceId: "figureya", sourceLabel: "FigureYa", matched: 0 },
          { sourceId: "user", sourceLabel: "User Library", matched: 0 },
        ],
        candidates: [],
      },
    }),
  );

  registerAppTool(
    server,
    "figure_library_search",
    {
      title: "Search scientific figure templates",
      description:
        "Search FigureYa and user-imported references after analyzing the user's image, text, or " +
        "data. Pass compact derived profiles, never an entire dataset.",
      inputSchema: SearchInput.shape,
      outputSchema: SearchOutput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { ui: { resourceUri: RESOURCE_URI } },
    },
    async (input): Promise<CallToolResult> => {
      const perSourceRequest = { ...input, limit: 12 };
      const figureYaCandidates = input.sourceIds.includes("figureya")
        ? await index.withPreviews(index.search(perSourceRequest))
        : [];
      const userCandidates = input.sourceIds.includes("user")
        ? await userLibrary.search(perSourceRequest)
        : [];
      const ranked = [...figureYaCandidates, ...userCandidates]
        .sort((left, right) => {
          const retrieval = right.retrievalScore - left.retrievalScore;
          if (retrieval) return retrieval;
          if (left.sourceId !== right.sourceId) return left.sourceId === "user" ? -1 : 1;
          return left.templateId.localeCompare(right.templateId);
        })
        .slice(0, input.limit);
      const topScore = Math.max(ranked[0]?.retrievalScore ?? 1, 0.0001);
      const candidates = ranked.map((candidate) => ({
        ...candidate,
        retrievalScore: Math.round((candidate.retrievalScore / topScore) * 100),
      }));
      const intentFamilies = buildSearchIntent(input).families;
      const output = {
        query: input.query,
        libraryVersion: VERSION,
        intentFamilies,
        reviewRequired: true,
        sources: [
          {
            sourceId: "figureya" as const,
            sourceLabel: "FigureYa",
            matched: figureYaCandidates.length,
          },
          {
            sourceId: "user" as const,
            sourceLabel: "User Library",
            matched: userCandidates.length,
          },
        ],
        candidates,
      };
      return {
        content: [{ type: "text", text: candidateText(candidates) }],
        structuredContent: output,
      };
    },
  );

  registerAppResource(
    server,
    RESOURCE_URI,
    RESOURCE_URI,
    {
      mimeType: RESOURCE_MIME_TYPE,
      title: "Scientific Figure Library candidate gallery",
      description: "Compare templates from FigureYa and the user's own reference library.",
    },
    async (): Promise<ReadResourceResult> => ({
      contents: [
        {
          uri: RESOURCE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: await fs.readFile(APP_HTML, "utf8"),
        },
      ],
    }),
  );

  server.registerTool(
    "figure_library_import",
    {
      title: "Import a user figure template",
      description:
        "Copy a user-supplied figure/code or validate and import a Figure Transfer Package ZIP. " +
        "Transfer Packages enter as draft visual references. The tool never executes code or " +
        "stores original absolute paths. Direct-write mode is retained for v0.2 compatibility; " +
        "new Agents should use figure_library_plan_import and figure_library_apply_import.",
      inputSchema: ImportInput.shape,
      outputSchema: ImportOutput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input): Promise<CallToolResult> => {
      try {
        const hasDirectFiles = Boolean(input.imagePath || input.codePaths?.length);
        if (Boolean(input.packagePath) === hasDirectFiles) {
          throw new Error("provide packagePath, or title plus imagePath/codePaths, but not both");
        }
        if (hasDirectFiles && !input.title) throw new Error("title is required for a direct import");
        const { packagePath, ...direct } = input;
        const result = packagePath
          ? await userLibrary.importTransferPackage(packagePath)
          : await userLibrary.importTemplate({ ...direct, title: input.title ?? "" });
        const files = [
          ...(result.template.preview ? [result.template.preview.file] : []),
          ...result.template.code.map((file) => file.file),
          ...(result.template.references ?? []).map((file) => file.file),
          "template.json",
        ].sort();
        const warning =
          result.template.reviewStatus === "draft"
            ? "Draft reference only; it is excluded from default search until curated and approved. No code was executed."
            : "Reference only. Imported code was copied but not executed.";
        const output = {
          templateId: result.template.templateId,
          sourceId: "user" as const,
          title: result.template.title,
          directory: result.directory,
          files,
          existed: result.existed,
          action: result.action,
          contentHash: result.template.registry?.contentHash,
          reviewStatus: result.template.reviewStatus ?? ("approved" as const),
          warning,
        };
        return {
          content: [
            {
              type: "text",
              text:
                `${result.action === "unchanged" ? "Found unchanged" : "Imported"} user template ` +
                `${result.template.templateId} at ${result.directory}. ${output.warning}`,
            },
          ],
          structuredContent: { ...output },
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `User template import failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    "figure_library_plan_import",
    {
      title: "Plan a direct user-template import",
      description:
        "Read and validate direct-import files, calculate stable identity and duplicate evidence, " +
        "and return a concurrency-bound plan. No files are written.",
      inputSchema: DirectImportInput.shape,
      outputSchema: DirectImportPlanOutput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input): Promise<CallToolResult> => {
      try {
        const output = await userLibrary.planDirectImport(input);
        return {
          content: [
            {
              type: "text",
              text:
                `No files were written. ${output.action}: ${output.normalizedTitle} ` +
                `would use ${output.proposedTemplateId}. Awaiting exact confirmation.`,
            },
          ],
          structuredContent: { ...output },
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Direct import planning failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    "figure_library_apply_import",
    {
      title: "Apply a confirmed direct import plan",
      description:
        "Revalidate a direct import plan and apply only the exact confirmed create/update/duplicate " +
        "decision. Imported code is copied but never executed.",
      inputSchema: DirectImportApplyInput.shape,
      outputSchema: DirectImportApplyOutput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input): Promise<CallToolResult> => {
      try {
        const result = await userLibrary.applyDirectImport(input);
        const output = {
          templateId: result.template.templateId,
          title: result.template.title,
          directory: result.directory,
          action: result.action,
          replayed: result.replayed,
          plan: result.plan,
          warning: "Reference only. Imported code was copied but never executed.",
        };
        return {
          content: [
            {
              type: "text",
              text: `${result.replayed ? "Replayed safely" : "Applied"}: ${result.template.templateId}. ${output.warning}`,
            },
          ],
          structuredContent: output,
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Confirmed direct import failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    "figure_library_diff",
    {
      title: "Diff an import source against the User Library",
      description:
        "Validate one Figure Transfer Package or Gallery entry and report a reviewable, read-only " +
        "create/update/unchanged diff. No files are imported.",
      inputSchema: ImportSourceInput.shape,
      outputSchema: ImportDiffSchema.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input): Promise<CallToolResult> => {
      try {
        const diff = await userLibrary.diffImportSource(input);
        return {
          content: [
            {
              type: "text",
              text:
                `${diff.action}: ${diff.sourceId} maps to ${diff.templateId}; ` +
                `${diff.changes.length} changed fields. No files were written.`,
            },
          ],
          structuredContent: { ...diff },
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Import diff failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    "figure_library_upsert",
    {
      title: "Explicitly upsert a Gallery or Transfer Package source",
      description:
        "Validate and create or atomically replace one stable Gallery/Transfer Package snapshot. " +
        "Use figure_library_diff first when content changed. Code is copied but never executed.",
      inputSchema: ImportSourceInput.shape,
      outputSchema: UpsertOutput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input): Promise<CallToolResult> => {
      try {
        const result = await userLibrary.upsertImportSource(input);
        const output = {
          templateId: result.template.templateId,
          sourceId: "user" as const,
          title: result.template.title,
          directory: result.directory,
          action: result.action,
          contentHash: result.template.registry?.contentHash ?? "",
          reviewStatus: result.template.reviewStatus ?? ("approved" as const),
          diff: result.diff,
          warning: "Reference snapshot only. No imported code or dependency installer was executed.",
        };
        return {
          content: [
            {
              type: "text",
              text:
                `${result.action}: ${result.template.templateId} at ${result.directory}. ` +
                output.warning,
            },
          ],
          structuredContent: output,
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Import upsert failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    "figure_library_sync",
    {
      title: "Synchronize an approved Personal Gallery",
      description:
        "Validate a Gallery and plan its stable imports. dryRun defaults to true. Applying sync " +
        "imports approved entries, skips drafts, and logically archives entries marked archived.",
      inputSchema: GallerySyncInput.shape,
      outputSchema: GallerySyncOutput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input): Promise<CallToolResult> => {
      try {
        const galleryDirectory =
          input.galleryDirectory ?? process.env.FIGURE_GALLERY_DIR?.trim();
        if (!galleryDirectory) {
          throw new Error("provide galleryDirectory or configure FIGURE_GALLERY_DIR");
        }
        const result = await userLibrary.syncGallery({ ...input, galleryDirectory });
        return {
          content: [
            {
              type: "text",
              text:
                `${result.dryRun ? "Dry run" : "Applied sync"}: ${result.create} create, ` +
                `${result.update} update, ${result.unchanged} unchanged, ${result.skipped} skipped.`,
            },
          ],
          structuredContent: result,
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Gallery sync failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    "figure_library_archive",
    {
      title: "Logically archive a user-library template",
      description:
        "Resolve a templateId, galleryId, or adapter-scoped registrySourceId and exclude the template " +
        "from default search. Files are retained; this tool never hard-deletes a template.",
      inputSchema: ArchiveInput.shape,
      outputSchema: ArchiveOutput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (reference): Promise<CallToolResult> => {
      try {
        const result = await userLibrary.archiveTemplate(reference);
        const management = result.template.registry;
        const output = {
          templateId: result.template.templateId,
          galleryId: management?.galleryId,
          registrySourceId: management?.sourceId,
          adapter: management?.adapter,
          previousReviewStatus: result.previousReviewStatus,
          reviewStatus: "archived" as const,
          directory: result.directory,
          changed: result.changed,
          alreadyArchived: result.alreadyArchived,
          filesRetained: true as const,
          existed: result.alreadyArchived,
          warning: "Logical archive only; reference files were retained.",
        };
        return {
          content: [
            {
              type: "text",
              text: `${result.alreadyArchived ? "Already archived" : "Archived"} ${result.template.templateId}. ${output.warning}`,
            },
          ],
          structuredContent: output,
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Template archive failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    "figure_library_preview",
    {
      title: "Preview a scientific figure template",
      description:
        "Return the selected candidate preview as standard MCP image content. Optionally copy it " +
        "to a project-local directory so a Wisp Agent can call view_image. Use this to visually " +
        "audit the top retrieval candidate before making a final recommendation.",
      inputSchema: PreviewInput.shape,
      outputSchema: PreviewOutput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ templateId, destination }): Promise<CallToolResult> => {
      try {
        const figureYaPreview = await index.preview(templateId);
        const userPreview = figureYaPreview ? undefined : await userLibrary.preview(templateId);
        const preview = figureYaPreview ?? userPreview;
        if (!preview) throw new Error(`no raster preview is available for ${templateId}`);

        const sourceId = figureYaPreview ? ("figureya" as const) : ("user" as const);
        const digest = createHash("sha256").update(preview.bytes).digest("hex");
        let outputPath;
        if (destination) {
          const directory = path.resolve(destination);
          await fs.mkdir(directory, { recursive: true });
          const safeId =
            templateId.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^[._-]+/gu, "") ||
            "template";
          outputPath = path.join(
            directory,
            `${safeId}-${digest.slice(0, 12)}${preview.extension}`,
          );
          try {
            await fs.writeFile(outputPath, preview.bytes, { flag: "wx" });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            const existing = new Uint8Array(await fs.readFile(outputPath));
            if (createHash("sha256").update(existing).digest("hex") !== digest) {
              throw new Error(`refusing to overwrite a different preview: ${outputPath}`);
            }
          }
        }

        const instruction = outputPath
          ? `Call view_image on ${outputPath}, compare it with the user's request/reference, and return an Agent visual-review verdict plus a score out of 10.`
          : "Compare this image with the user's request/reference and return an Agent visual-review verdict plus a score out of 10.";
        const output = {
          templateId,
          sourceId,
          mimeType: preview.mimeType,
          bytes: preview.bytes.byteLength,
          sha256: digest,
          path: outputPath,
          instruction,
        };
        return {
          content: [
            {
              type: "text",
              text:
                `Preview ready for ${templateId}${outputPath ? ` at ${outputPath}` : ""}. ` +
                instruction,
            },
            {
              type: "image",
              data: Buffer.from(preview.bytes).toString("base64"),
              mimeType: preview.mimeType,
            },
          ],
          structuredContent: output,
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Template preview failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    "figure_library_source_status",
    {
      title: "Inspect figure template sources",
      description:
        "Report effective User Library and Gallery paths, lifecycle/integrity counts, and inspect a " +
        "local FigureYa Source Pack by file name and size.",
      inputSchema: SourceStatusInput.shape,
      outputSchema: SourceStatusOutput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ sourcePackDir, galleryDirectory: galleryArgument }): Promise<CallToolResult> => {
      const galleryEnvironment = process.env.FIGURE_GALLERY_DIR?.trim();
      const galleryDirectory = galleryArgument ?? galleryEnvironment;
      let galleryDirectoryAccessible = false;
      if (galleryDirectory) {
        try {
          const stat = await fs.lstat(path.resolve(galleryDirectory));
          galleryDirectoryAccessible = stat.isDirectory() && !stat.isSymbolicLink();
        } catch {
          galleryDirectoryAccessible = false;
        }
      }
      const [audit, figureYa] = await Promise.all([
        userLibrary.auditTemplates({ scope: "all", includeArchived: true }),
        inspectFigureYaSourcePack(index.catalog, sourcePackDir),
      ]);
      const output = {
        libraryDirectory: userLibrary.root,
        libraryDirectorySource:
          userLibrary.directorySource === "FIGURE_LIBRARY_DIR"
            ? ("FIGURE_LIBRARY_DIR" as const)
            : ("default" as const),
        galleryDirectory: galleryDirectory ? path.resolve(galleryDirectory) : undefined,
        galleryDirectorySource: galleryArgument
          ? ("argument" as const)
          : galleryEnvironment
            ? ("FIGURE_GALLERY_DIR" as const)
            : ("unset" as const),
        galleryDirectoryAccessible,
        userTemplateCount: audit.userTemplateCount,
        activeUserTemplateCount: audit.templates.filter(
          (item) => item.reviewStatus !== "archived",
        ).length,
        archivedUserTemplateCount: audit.templates.filter(
          (item) => item.reviewStatus === "archived",
        ).length,
        legacyTemplateCount: audit.legacyTemplateCount,
        invalidTemplateCount: audit.invalidTemplateCount,
        duplicateGroupCount: audit.duplicateGroupCount,
        figureYa: {
          catalogTemplates: index.catalog.modules.length,
          sourcePackConfigured: figureYa.configured,
          sourcePackDirectory: figureYa.directory,
          availableTemplates: figureYa.availableTemplates,
          invalidTemplates: figureYa.invalidTemplates,
          missingCount: figureYa.missingCount,
          availableBytes: figureYa.availableBytes,
          archiveRevision: figureYa.archiveCommit,
        },
      };
      return {
        content: [
          {
            type: "text",
            text:
              `${audit.userTemplateCount} user templates; ${audit.invalidTemplateCount} invalid; ` +
              `${audit.duplicateGroupCount} duplicate groups; ${index.catalog.modules.length} FigureYa ` +
              `catalog templates; ${figureYa.availableTemplates.length} FigureYa archives available ` +
              "in the configured Source Pack.",
          },
        ],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "figure_library_audit",
    {
      title: "Audit the User Library",
      description:
        "Read every user-template manifest, verify stored files, and report invalid, legacy, and " +
        "component-level duplicate evidence. Recommendations never modify the library.",
      inputSchema: AuditInput.shape,
      outputSchema: AuditOutput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input): Promise<CallToolResult> => {
      try {
        const output = await userLibrary.auditTemplates(input);
        return {
          content: [
            {
              type: "text",
              text:
                `No files were written. ${output.userTemplateCount} valid templates, ` +
                `${output.invalidTemplateCount} invalid, ${output.legacyTemplateCount} legacy, ` +
                `${output.duplicateGroupCount} duplicate groups. Canonical IDs are recommendations only.`,
            },
          ],
          structuredContent: output,
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `User Library audit failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    "figure_library_reconcile",
    {
      title: "Reconcile duplicate user templates",
      description:
        "Dry-run, apply, or roll back an exact duplicate-archive transaction. Apply uses verified " +
        "manifest/file preconditions, a shared write lock, and a recovery journal; files are retained.",
      inputSchema: ReconcileInput.shape,
      outputSchema: ReconcileOutput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async (input): Promise<CallToolResult> => {
      try {
        const output = await userLibrary.reconcileTemplates(input);
        return {
          content: [
            {
              type: "text",
              text:
                `${output.mode === "dry-run" ? "No files were written" : "Transaction recorded"}. ` +
                `${output.reconcileId}: ${output.mode}. Template files were retained.`,
            },
          ],
          structuredContent: output,
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Duplicate reconcile failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    "figure_library_describe",
    {
      title: "Describe a scientific figure template",
      description: "Return structured, read-only details for one exact template ID.",
      inputSchema: DescribeInput.shape,
      outputSchema: DescribeOutput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ templateId }): Promise<CallToolResult> => {
      const module = index.get(templateId);
      if (module) {
        const output = {
          templateId,
          sourceId: "figureya" as const,
          sourceLabel: "FigureYa",
          title: module.title,
          description: module.requirement,
          application: module.application,
          dataProfile: module.inputSummary,
          inputFiles: module.inputFiles,
          codeFiles: module.codeFiles,
          packages: module.packages,
          materializable: module.archiveAvailable,
          previewAvailable: Boolean(module.thumbnail),
          assetKind: "plot_template" as const,
          language: module.codeFiles.some((file) => /\.(?:r|rmd|qmd)$/iu.test(file))
            ? "R"
            : module.codeFiles.some((file) => /\.(?:py|ipynb)$/iu.test(file))
              ? "Python"
              : "none",
          plotFamily:
            buildSearchIntent({
              query: `${module.moduleId} ${module.title} ${module.requirement}`,
            }).families[0] ?? "",
          reviewStatus: "approved" as const,
          codeStatus: module.codeFiles.length ? ("reviewed" as const) : ("none" as const),
          license: "CC BY-NC-SA 4.0",
          sourceUrl: module.sourceUrl,
          reportUrl: module.reportUrl,
          sourceRevision: index.catalog.figureya.commit,
          archiveRevision: index.catalog.compressed.commit,
          citation: index.catalog.citation,
          management: {
            templateId,
            canArchive: false,
            canUpdate: false,
          },
        };
        return {
          content: [
            {
              type: "text",
              text:
                `# ${templateId} [FigureYa]\n\n${module.requirement}\n\n` +
                `Inputs: ${module.inputFiles.join(", ") || "not identified"}\n` +
                `Packages: ${module.packages.join(", ") || "not identified"}\n` +
                `Source: ${module.sourceUrl}`,
            },
          ],
          structuredContent: output,
        };
      }

      const user = await userLibrary.get(templateId);
      if (!user) {
        return {
          isError: true,
          content: [{ type: "text", text: `Unknown figure template: ${templateId}` }],
        };
      }
      const output = {
        templateId,
        sourceId: "user" as const,
        sourceLabel: "User Library",
        title: user.template.title,
        description: user.template.description,
        application: user.template.visualProfile,
        dataProfile: user.template.dataProfile,
        inputFiles: (user.template.references ?? [])
          .filter((file) => file.role === "data")
          .map((file) => path.posix.basename(file.file)),
        codeFiles: user.template.code.map((file) => path.posix.basename(file.file)),
        packages: user.template.packages,
        materializable: true,
        previewAvailable: Boolean(
          user.template.preview &&
            /^(?:image\/png|image\/jpeg|image\/webp)$/u.test(user.template.preview.mediaType),
        ),
        assetKind:
          user.template.assetKind ??
          (user.template.code.length ? ("plot_template" as const) : ("visual_reference" as const)),
        language:
          user.template.language ??
          (user.template.code.some((file) => /\.(?:r|rmd|qmd)$/iu.test(file.file))
            ? "R"
            : "none"),
        plotFamily: user.template.plotFamily ?? "",
        reviewStatus: user.template.reviewStatus ?? ("approved" as const),
        codeStatus:
          user.template.codeStatus ??
          (user.template.code.length ? ("reviewed" as const) : ("none" as const)),
        license: user.template.license,
        importedAt: user.template.importedAt,
        previewFile: user.template.preview?.file,
        provenance: user.template.provenance,
        registry: user.template.registry,
        management: managementReference(user.template),
      };
      return {
        content: [
          {
            type: "text",
            text:
              `# ${templateId} [User Library]\n\n` +
              `${user.template.description || "User-supplied reference."}\n\n` +
              `Code: ${output.codeFiles.join(", ") || "visual reference only"}\n` +
              `License: ${user.template.license}`,
          },
        ],
        structuredContent: output,
      };
    },
  );

  server.registerTool(
    "figure_library_materialize",
    {
      title: "Materialize a scientific figure template",
      description:
        "Copy a selected user template or acquire a commit-pinned FigureYa archive. Never " +
        "overwrites or executes code. If this tool returns any error, stop immediately, report " +
        "it, and do not retry, fetch another archive, recreate the template, or draw a substitute.",
      inputSchema: MaterializeInput.shape,
      outputSchema: MaterializeOutput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({
      templateId,
      destination,
      mode,
      sourcePackDir,
      allowNetwork,
    }): Promise<CallToolResult> => {
      try {
        const module = index.get(templateId);
        if (module) {
          const result = await materializeFigureYaTemplate({
            catalog: index.catalog,
            module,
            destination,
            mode,
            sourcePackDir,
            allowNetwork,
          });
          const output = {
            templateId,
            sourceId: "figureya" as const,
            target: result.target,
            mode,
            materializationSource: result.archiveSource,
            sourceLocation: result.archiveLocation,
            archiveSha256: result.sha256,
            files: result.files,
            warning:
              "Reference only. No code was executed; inspect files and never auto-run dependency installers.",
          };
          return {
            content: [
              {
                type: "text",
                text:
                  `Materialized ${templateId} from ${result.archiveSource} at ${result.target} ` +
                  `(${result.files.length} upstream files).\n${output.warning}`,
              },
            ],
            structuredContent: output,
          };
        }

        const result = await userLibrary.materialize(templateId, destination);
        const output = {
          templateId,
          sourceId: "user" as const,
          target: result.target,
          mode,
          materializationSource: result.materializationSource,
          files: result.files,
          warning: "Reference only. No imported code was executed.",
        };
        return {
          content: [
            {
              type: "text",
              text:
                `Materialized ${templateId} from the user library at ${result.target} ` +
                `(${result.files.length} files).\n${output.warning}`,
            },
          ],
          structuredContent: output,
        };
      } catch (error) {
        return hardStop(templateId, error);
      }
    },
  );

  return server;
}
