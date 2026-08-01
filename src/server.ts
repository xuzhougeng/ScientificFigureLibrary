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
import { UserTemplateLibrary } from "./user-library.ts";

const VERSION = "0.2.0";
const RESOURCE_URI = "ui://figure-library/candidates.html";
const APP_HTML = path.resolve(import.meta.dirname, "mcp-app.html");

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

const ImportDiffSchema = z.object({
  action: z.enum(["create", "unchanged", "update", "skipped"]),
  adapter: z.enum(["gallery", "figure-transfer-package"]),
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

const ArchiveInput = z.object({ galleryId: z.string().min(1).max(300) });
const ArchiveOutput = z.object({
  galleryId: z.string(),
  templateId: z.string(),
  reviewStatus: z.literal("archived"),
  directory: z.string(),
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
  adapter: z.enum(["gallery", "figure-transfer-package"]),
  sourceId: z.string(),
  templateId: z.string().optional(),
  galleryId: z.string().optional(),
  contentHash: z.string(),
  sourceCommit: z.string().optional(),
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
});

const SourceStatusOutput = z.object({
  libraryDirectory: z.string(),
  userTemplateCount: z.number().int(),
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
        "stores original absolute paths.",
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
          structuredContent: output,
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
      title: "Logically archive an imported Gallery entry",
      description:
        "Mark an imported gallery_id archived so default search excludes it. Files are retained; " +
        "this tool never hard-deletes a template.",
      inputSchema: ArchiveInput.shape,
      outputSchema: ArchiveOutput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ galleryId }): Promise<CallToolResult> => {
      try {
        const result = await userLibrary.archiveGallery(galleryId);
        const output = {
          galleryId,
          templateId: result.template.templateId,
          reviewStatus: "archived" as const,
          directory: result.directory,
          existed: result.existed,
          warning: "Logical archive only; reference files were retained.",
        };
        return {
          content: [
            {
              type: "text",
              text: `${result.existed ? "Already archived" : "Archived"} ${galleryId}. ${output.warning}`,
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
              text: `Gallery archive failed: ${error instanceof Error ? error.message : String(error)}`,
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
        "Report the user-library count and inspect a local FigureYa Source Pack by file name and size.",
      inputSchema: SourceStatusInput.shape,
      outputSchema: SourceStatusOutput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ sourcePackDir }): Promise<CallToolResult> => {
      const [userTemplates, figureYa] = await Promise.all([
        userLibrary.list(),
        inspectFigureYaSourcePack(index.catalog, sourcePackDir),
      ]);
      const output = {
        libraryDirectory: userLibrary.root,
        userTemplateCount: userTemplates.length,
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
              `${userTemplates.length} user templates; ${index.catalog.modules.length} FigureYa ` +
              `catalog templates; ${figureYa.availableTemplates.length} FigureYa archives available ` +
              "in the configured Source Pack.",
          },
        ],
        structuredContent: output,
      };
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
