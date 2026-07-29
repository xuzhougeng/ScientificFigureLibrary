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
import { CatalogIndex } from "./catalog.ts";
import {
  inspectFigureYaSourcePack,
  materializeFigureYaTemplate,
} from "./materialize.ts";
import type { TemplateCandidate } from "./types.ts";
import { UserTemplateLibrary } from "./user-library.ts";

const VERSION = "0.1.0";
const RESOURCE_URI = "ui://figure-library/candidates.html";
const APP_HTML = path.resolve(import.meta.dirname, "mcp-app.html");

const CandidateSchema = z.object({
  templateId: z.string(),
  sourceId: z.enum(["figureya", "user"]),
  sourceLabel: z.string(),
  title: z.string(),
  relevance: z.number(),
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
    title: z.string().min(1).max(200),
    description: z.string().max(4_000).optional(),
    tags: z.array(z.string().min(1).max(100)).max(40).optional(),
    visualProfile: z.string().max(2_000).optional(),
    dataProfile: z.string().max(2_000).optional(),
    packages: z.array(z.string().min(1).max(100)).max(40).optional(),
    license: z.string().max(500).optional(),
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
  .refine((value) => Boolean(value.imagePath || value.codePaths?.length), {
    message: "provide imagePath or at least one codePaths entry",
  });

const ImportOutput = z.object({
  templateId: z.string(),
  sourceId: z.literal("user"),
  title: z.string(),
  directory: z.string(),
  files: z.array(z.string()),
  existed: z.boolean(),
  warning: z.string(),
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
  license: z.string(),
  sourceUrl: z.string().optional(),
  reportUrl: z.string().optional(),
  sourceRevision: z.string().optional(),
  archiveRevision: z.string().optional(),
  citation: z.string().optional(),
  importedAt: z.string().optional(),
  previewFile: z.string().optional(),
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
  return candidates
    .map((candidate, index) => {
      const reasons = candidate.reasons.join("; ") || "metadata/full-text match";
      const warnings = candidate.warnings.length
        ? ` Warnings: ${candidate.warnings.join("; ")}.`
        : "";
      return (
        `${index + 1}. ${candidate.templateId} [${candidate.sourceLabel}] — ` +
        `relevance ${candidate.relevance}/100. ${reasons}.${warnings}`
      );
    })
    .join("\n");
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
      const candidates = [...figureYaCandidates, ...userCandidates]
        .sort((left, right) => {
          const relevance = right.relevance - left.relevance;
          if (relevance) return relevance;
          if (left.sourceId !== right.sourceId) return left.sourceId === "user" ? -1 : 1;
          return left.templateId.localeCompare(right.templateId);
        })
        .slice(0, input.limit);
      const output = {
        query: input.query,
        libraryVersion: VERSION,
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
        "Copy a user-supplied figure and/or code files into the local template library. " +
        "The tool never executes code and does not store original absolute paths.",
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
        const result = await userLibrary.importTemplate(input);
        const files = [
          ...(result.template.preview ? [result.template.preview.file] : []),
          ...result.template.code.map((file) => file.file),
          "template.json",
        ].sort();
        const output = {
          templateId: result.template.templateId,
          sourceId: "user" as const,
          title: result.template.title,
          directory: result.directory,
          files,
          existed: result.existed,
          warning: "Reference only. Imported code was copied but not executed.",
        };
        return {
          content: [
            {
              type: "text",
              text:
                `${result.existed ? "Found existing" : "Imported"} user template ` +
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
        inputFiles: [],
        codeFiles: user.template.code.map((file) => path.posix.basename(file.file)),
        packages: user.template.packages,
        materializable: true,
        license: user.template.license,
        importedAt: user.template.importedAt,
        previewFile: user.template.preview?.file,
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
