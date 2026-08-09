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
import {
  buildSearchIntent,
  CatalogIndex,
  normalizeSearchText,
  scoreSearchableTemplate,
} from "./catalog.ts";
import { registerBundleTools } from "./bundle-tools.ts";
import { inspectLibraryWriteLock } from "./cross-runtime-lock.ts";
import {
  type CurrentLibraryContext,
  registerLibraryBindingTools,
  type ToolOutcomeEnvelope,
} from "./library-binding-tools.ts";
import { LibraryRuntime, readLibraryRootMarker } from "./library-runtime.ts";
import { registerLifecycleTools } from "./lifecycle-tools.ts";
import { inspectFigureYaSourcePack } from "./materialize.ts";
import { registerMaterializationTools } from "./materialization-tools.ts";
import {
  FIGUREYA_PROVIDER_ID,
  LOCAL_LIBRARY_PROVIDER_ID,
  assertExactTemplateSelector,
  assertFigureYaExactSelector,
  assertFigureYaSelectorMatches,
  assertFigureYaSourceSelectorMatches,
} from "./providers.ts";
import type {
  ExactTemplateSelector,
  FigureYaExactSelector,
  SearchRequest,
  TemplateCandidate,
} from "./types.ts";
import {
  VersionedTemplateLibrary,
  type PublishedVersionedTemplateCandidate,
  type TemplateContentV1,
  type TemplateReleaseV1,
} from "./versioned-library.ts";

export const VERSION = "0.5.0";
const RESOURCE_URI = "ui://figure-library/candidates.html";
const APP_HTML = path.resolve(import.meta.dirname, "mcp-app.html");
const HASH = /^[a-f0-9]{64}$/u;

const ExactSelectorSchema = z.record(z.string(), z.unknown());
const ProviderSelectionInput = z.object({
  providerId: z.string().min(1).max(200),
  exactSelector: ExactSelectorSchema,
});
const SearchInput = z.object({
  query: z.string().min(1).max(2_000),
  dataProfile: z.string().max(2_000).optional(),
  visualProfile: z.string().max(2_000).optional(),
  assetKind: z.enum(["plot_template", "visual_reference"]).optional(),
  language: z.string().min(1).max(100).optional(),
  plotFamily: z.string().min(1).max(200).optional(),
  reviewStatus: z.enum(["not_reviewed", "draft", "approved", "archived"]).optional(),
  codeStatus: z.enum(["none", "scaffold", "provided", "reviewed"]).optional(),
  providerIds: z
    .array(z.string().min(1).max(200))
    .min(1)
    .max(16)
    .optional()
    .default([LOCAL_LIBRARY_PROVIDER_ID, FIGUREYA_PROVIDER_ID]),
  limit: z.number().int().min(1).max(12).optional().default(6),
});
const PreviewInput = ProviderSelectionInput.extend({
  destination: z.string().min(1).max(4_000).optional(),
});
const SourceStatusInput = z.object({
  sourcePackDir: z.string().min(1).max(4_000).optional(),
});

function outcome(
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

function terminal(
  envelope: ToolOutcomeEnvelope,
  details: Record<string, unknown> = {},
  lines: string[] = [],
): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: [
          `OUTCOME: ${envelope.outcome}`,
          "TERMINAL: true",
          "RETRY_SAME_CALL: false",
          `CODE: ${envelope.code}`,
          `NEXT_ACTION: ${envelope.nextAction}`,
          envelope.summary,
          ...lines,
        ].join("\n"),
      },
    ],
    structuredContent: { envelope, ...details },
  };
}

function failed(prefix: string, error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLocaleLowerCase("en-US");
  if (lower.includes("stale") || lower.includes("does not match exact")) {
    return terminal(outcome("conflict", "stale_selector", `${prefix}: ${message}`, "create_new_plan"));
  }
  if (lower.includes("unknown") || lower.includes("not found")) {
    return terminal(outcome("not_found", "selection_not_found", `${prefix}: ${message}`));
  }
  return terminal(outcome("failed", "operation_failed", `${prefix}: ${message}`));
}

function localSelector(item: PublishedVersionedTemplateCandidate): ExactTemplateSelector {
  return {
    schema: "figure-library.provider-selector.v1",
    providerId: LOCAL_LIBRARY_PROVIDER_ID,
    kind: "local-published.v1",
    identity: {
      templateId: item.templateId,
      revisionId: item.revisionId,
      contentDigest: item.contentDigest,
      releaseId: item.releaseId,
    },
  };
}

function localSelectorIdentity(selector: ExactTemplateSelector) {
  assertExactTemplateSelector(selector);
  if (selector.providerId !== LOCAL_LIBRARY_PROVIDER_ID || selector.kind !== "local-published.v1") {
    throw new Error("exact selector is not a Local Published selector");
  }
  const { templateId, revisionId, contentDigest, releaseId } = selector.identity;
  if (
    typeof templateId !== "string" ||
    typeof revisionId !== "string" ||
    typeof releaseId !== "string" ||
    typeof contentDigest !== "string" ||
    !HASH.test(contentDigest)
  ) {
    throw new Error("invalid Local Published exact selector");
  }
  return { templateId, revisionId, contentDigest, releaseId };
}

async function resolveLocalPublished(
  context: CurrentLibraryContext,
  selector: ExactTemplateSelector,
) {
  const identity = localSelectorIdentity(selector);
  const [content, release, history] = await Promise.all([
    context.versionedLibrary.getContent(
      identity.templateId,
      identity.revisionId,
      identity.contentDigest,
    ),
    context.versionedLibrary.getRelease(identity.templateId, identity.releaseId),
    context.versionedLibrary.history(identity.templateId),
  ]);
  if (
    !content ||
    !release ||
    release.revisionId !== identity.revisionId ||
    release.contentDigest !== identity.contentDigest ||
    !history.releases.some(
      (item) =>
        item.releaseId === identity.releaseId &&
        item.revisionId === identity.revisionId &&
        item.contentDigest === identity.contentDigest,
    )
  ) {
    throw new Error("stale or unreachable Local Published exact selector");
  }
  return { identity, content, release };
}

function matchesLocalFilters(
  item: PublishedVersionedTemplateCandidate,
  request: SearchRequest,
) {
  if (request.assetKind && item.assetKind !== request.assetKind) return false;
  if (request.reviewStatus && request.reviewStatus !== "approved") return false;
  if (request.codeStatus && item.codeStatus !== request.codeStatus) return false;
  if (
    request.language &&
    normalizeSearchText(request.language) !== normalizeSearchText(item.language)
  ) {
    return false;
  }
  if (request.plotFamily) {
    const desired = buildSearchIntent({ query: request.plotFamily }).families;
    const actual = buildSearchIntent({ query: item.plotFamily }).families;
    if (desired.length ? !desired.some((value) => actual.includes(value)) : !normalizeSearchText(item.plotFamily).includes(normalizeSearchText(request.plotFamily))) {
      return false;
    }
  }
  return true;
}

async function localCandidates(
  context: CurrentLibraryContext,
  request: SearchRequest,
): Promise<TemplateCandidate[]> {
  const intent = buildSearchIntent(request);
  const scored = (await context.versionedLibrary.listPublishedCandidates())
    .filter((item) => matchesLocalFilters(item, request))
    .map((item) => ({
      item,
      evidence: scoreSearchableTemplate(
        {
          templateId: item.templateId,
          title: item.title,
          description: item.description,
          application: item.visualProfile,
          dataProfile: item.dataProfile,
          inputFiles: [],
          codeFiles: [],
          packages: item.packages,
          tags: item.tags,
        },
        intent,
      ),
    }))
    .filter(({ evidence }) => evidence.score > 0)
    .sort(
      (left, right) =>
        right.evidence.score - left.evidence.score ||
        left.item.templateId.localeCompare(right.item.templateId),
    )
    .slice(0, Math.min(request.limit ?? 12, 12));

  return Promise.all(
    scored.map(async ({ item, evidence }) => {
      const content = await context.versionedLibrary.getContent(
        item.templateId,
        item.revisionId,
        item.contentDigest,
      );
      if (!content) throw new Error(`Published content disappeared: ${item.templateId}`);
      const selector = localSelector(item);
      return {
        templateId: item.templateId,
        providerId: LOCAL_LIBRARY_PROVIDER_ID,
        exactSelector: selector,
        sourceLabel: "Local Published",
        title: item.title,
        retrievalScore: evidence.score,
        matchedTerms: evidence.matchedTerms.slice(0, 12),
        reasons: evidence.reasons,
        warnings:
          item.executionStatus === "not_run"
            ? ["Stored code has not been executed by ScientificFigureLibrary; not_run is not reproduction evidence."]
            : [],
        excerpt: item.description.slice(0, 420),
        description: item.description,
        application: item.visualProfile,
        dataProfile: item.dataProfile,
        inputFiles: content.assets
          .filter((asset) => asset.role === "reference")
          .map((asset) => asset.logicalPath),
        codeFiles: content.assets
          .filter((asset) => asset.role === "code")
          .map((asset) => asset.logicalPath),
        packages: item.packages,
        materializable: true,
        previewAvailable: item.previewAvailable,
        ...(item.previewAvailable
          ? {
              previewRef: {
                schema: "figure-library.provider-preview-ref.v1" as const,
                providerId: LOCAL_LIBRARY_PROVIDER_ID,
                exactSelector: selector,
              },
            }
          : {}),
        assetKind: item.assetKind,
        language: item.language,
        plotFamily: item.plotFamily,
        reviewStatus: "approved" as const,
        codeStatus: item.codeStatus,
        executionStatus: item.executionStatus,
        upstreamStatus: "published" as const,
        license: item.license,
        management: {
          templateId: item.templateId,
          canArchive: false,
          canUpdate: true,
          updateVia: "plan-apply" as const,
        },
      };
    }),
  );
}

function candidateText(candidates: TemplateCandidate[]) {
  if (!candidates.length) {
    return "No matching Local Published or FigureYa templates were found. No tool retry is needed unless the user changes the search intent.";
  }
  return [
    "Retrieval candidates only; the Agent must preview and review a candidate before recommending it.",
    ...candidates.flatMap((candidate, index) => [
      `${index + 1}. ${candidate.title}`,
      `   PROVIDER_ID: ${candidate.providerId}`,
      `   TEMPLATE_ID: ${candidate.templateId}`,
      `   EXACT_SELECTOR: ${JSON.stringify(candidate.exactSelector)}`,
      `   RETRIEVAL_SCORE: ${candidate.retrievalScore}/100`,
      `   STATE: review=${candidate.reviewStatus}; code=${candidate.codeStatus}; execution=${candidate.executionStatus}`,
      `   PREVIEW_AVAILABLE: ${candidate.previewAvailable}`,
      `   REASONS: ${candidate.reasons.join("; ") || "catalog metadata match"}`,
      ...(candidate.warnings.length
        ? [`   WARNINGS: ${candidate.warnings.join("; ")}`]
        : []),
    ]),
    "NEXT_STEP: call figure_library_preview once with the selected providerId and exactSelector; do not guess from templateId alone.",
  ].join("\n");
}

async function countLegacyFlat(root: string) {
  const directory = path.join(root, "templates");
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let count = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    try {
      const stat = await fs.lstat(path.join(directory, entry.name, "template.json"));
      if (stat.isFile() && !stat.isSymbolicLink()) count += 1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return count;
}

export async function createServer() {
  const index = await CatalogIndex.load();
  const runtime = new LibraryRuntime();
  const contexts = new Map<string, CurrentLibraryContext>();
  const currentLibraries = async () => {
    const snapshot = await runtime.current();
    const existing = contexts.get(snapshot.contextKey);
    if (existing) return existing;
    const context: CurrentLibraryContext = {
      snapshot,
      versionedLibrary: new VersionedTemplateLibrary(snapshot),
    };
    contexts.set(snapshot.contextKey, context);
    if (contexts.size > 8) contexts.delete(contexts.keys().next().value as string);
    return context;
  };

  const server = new McpServer({ name: "Scientific Figure Library", version: VERSION });

  registerAppTool(
    server,
    "figure_library_open",
    {
      title: "Open Scientific Figure Library",
      description:
        "Open the read-only candidate workbench. Ask for an uploaded reference, data profile, or plotting goal before searching.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { ui: { resourceUri: RESOURCE_URI } },
    },
    async (): Promise<CallToolResult> => {
      const responseEnvelope = outcome(
        "ok",
        "library_ready",
        "Scientific Figure Library 0.5.0 is ready. Standard core uses direct user-confirmed image/code intake; Web Capture and project pins are not registered. Ask for a plotting goal before searching.",
        "ask_user",
      );
      return terminal(responseEnvelope, {
        query: "等待绘图目标",
        libraryVersion: VERSION,
        intentFamilies: [],
        reviewRequired: false,
        sources: [
          { providerId: LOCAL_LIBRARY_PROVIDER_ID, sourceLabel: "Local Published", matched: 0 },
          { providerId: FIGUREYA_PROVIDER_ID, sourceLabel: "FigureYa", matched: 0 },
        ],
        candidates: [],
      });
    },
  );

  server.registerTool(
    "figure_library_search",
    {
      title: "Search Local Published and FigureYa together",
      description:
        "One bounded search across Local Published and FigureYa. Working, Capture, and flat-v1 entries never enter ordinary results; same-named providers are not shadowed.",
      inputSchema: SearchInput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input): Promise<CallToolResult> => {
      try {
        const request: SearchRequest = {
          query: input.query,
          dataProfile: input.dataProfile,
          visualProfile: input.visualProfile,
          assetKind: input.assetKind,
          language: input.language,
          plotFamily: input.plotFamily,
          reviewStatus: input.reviewStatus,
          codeStatus: input.codeStatus,
          limit: 12,
        };
        const context = await currentLibraries();
        const [local, figureYa] = await Promise.all([
          input.providerIds.includes(LOCAL_LIBRARY_PROVIDER_ID)
            ? localCandidates(context, request)
            : [],
          input.providerIds.includes(FIGUREYA_PROVIDER_ID) ? index.search(request) : [],
        ]);
        const ranked = [...local, ...figureYa]
          .sort((left, right) => {
            const score = right.retrievalScore - left.retrievalScore;
            if (score) return score;
            if (left.providerId !== right.providerId) {
              return left.providerId === LOCAL_LIBRARY_PROVIDER_ID ? -1 : 1;
            }
            return left.templateId.localeCompare(right.templateId);
          })
          .slice(0, input.limit);
        const top = Math.max(ranked[0]?.retrievalScore ?? 1, 0.0001);
        const candidates = ranked.map((candidate) => ({
          ...candidate,
          retrievalScore: Math.round((candidate.retrievalScore / top) * 100),
        }));
        const responseEnvelope = outcome(
          "ok",
          candidates.length ? "search_candidates_ready" : "search_no_matches",
          candidates.length
            ? `Unified search returned ${candidates.length} bounded candidates; preview only the selected exact candidate.`
            : "Unified search completed without a matching Local Published or FigureYa candidate.",
          candidates.length ? "preview_selected_candidate" : "none",
        );
        return terminal(
          responseEnvelope,
          {
            query: input.query,
            libraryVersion: VERSION,
            intentFamilies: buildSearchIntent(request).families,
            reviewRequired: true,
            sources: [
              {
                providerId: LOCAL_LIBRARY_PROVIDER_ID,
                sourceLabel: "Local Published",
                matched: local.length,
              },
              {
                providerId: FIGUREYA_PROVIDER_ID,
                sourceLabel: "FigureYa",
                matched: figureYa.length,
              },
            ],
            candidates,
          },
          [candidateText(candidates)],
        );
      } catch (error) {
        return failed("Unified search failed", error);
      }
    },
  );

  registerAppResource(
    server,
    RESOURCE_URI,
    RESOURCE_URI,
    {
      mimeType: RESOURCE_MIME_TYPE,
      title: "Scientific Figure Library candidate workbench",
      description: "Compare Local Published and FigureYa candidates without inlining every thumbnail.",
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
    "figure_library_describe",
    {
      title: "Describe one provider-qualified exact template",
      description:
        "Describe an exact Local Published release or commit-pinned FigureYa module. A bare templateId is deliberately insufficient.",
      inputSchema: ProviderSelectionInput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ providerId, exactSelector: raw }): Promise<CallToolResult> => {
      try {
        const exactSelector = raw as unknown as ExactTemplateSelector;
        assertExactTemplateSelector(exactSelector);
        if (exactSelector.providerId !== providerId) {
          throw new Error("providerId does not match exactSelector.providerId");
        }
        if (providerId === LOCAL_LIBRARY_PROVIDER_ID) {
          const resolved = await resolveLocalPublished(await currentLibraries(), exactSelector);
          const { content, release } = resolved;
          return terminal(
            outcome("ok", "local_published_described", `Loaded exact Local Published release ${release.releaseId}.`),
            { providerId, exactSelector, content, release },
            [
              `PROVIDER_ID: ${providerId}`,
              `EXACT_SELECTOR: ${JSON.stringify(exactSelector)}`,
              `TITLE: ${content.title}`,
              `ASSET_KIND: ${content.assetKind}`,
              `LANGUAGE: ${content.language}`,
              `CODE_STATUS: ${content.codeStatus}`,
              `EXECUTION_STATUS: ${content.executionStatus}`,
              `ASSETS: ${content.assets.map((asset) => `${asset.logicalPath}:${asset.sha256}`).join(", ")}`,
            ],
          );
        }
        if (providerId !== FIGUREYA_PROVIDER_ID) {
          throw new Error(`unsupported search provider: ${providerId}`);
        }
        const moduleId = exactSelector.identity.moduleId;
        const sourceCommit = exactSelector.identity.sourceCommit;
        if (typeof moduleId !== "string" || sourceCommit !== index.catalog.figureya.commit) {
          throw new Error("stale or invalid FigureYa source selector");
        }
        const module = index.get(moduleId);
        if (!module) throw new Error(`unknown FigureYa module: ${moduleId}`);
        if (exactSelector.kind === "figureya-module.v1") {
          assertFigureYaExactSelector(exactSelector);
          assertFigureYaSelectorMatches(
            exactSelector,
            index.catalog,
            module,
            (exactSelector as FigureYaExactSelector).identity.mode,
          );
        } else if (exactSelector.kind === "figureya-source-module.v1") {
          assertFigureYaSourceSelectorMatches(exactSelector, index.catalog, module);
        } else {
          throw new Error(`unsupported FigureYa selector kind: ${exactSelector.kind}`);
        }
        return terminal(
          outcome("ok", "figureya_module_described", `Loaded commit-pinned FigureYa metadata for ${moduleId}.`),
          {
            providerId,
            exactSelector,
            templateId: module.moduleId,
            title: module.title,
            description: module.requirement,
            application: module.application,
            dataProfile: module.inputSummary,
            inputFiles: module.inputFiles,
            codeFiles: module.codeFiles,
            packages: module.packages,
            materializable: module.archiveAvailable,
            previewAvailable: await index.previewAvailable(module),
            reviewStatus: "not_reviewed",
            codeStatus: module.codeFiles.length ? "provided" : "none",
            executionStatus: "not_run",
            upstreamStatus: "published",
            sourceUrl: module.sourceUrl,
            reportUrl: module.reportUrl,
            citation: index.catalog.citation,
          },
          [
            `PROVIDER_ID: ${providerId}`,
            `EXACT_SELECTOR: ${JSON.stringify(exactSelector)}`,
            `TITLE: ${module.title}`,
            "LOCAL_REVIEW_STATUS: not_reviewed",
            `CODE_STATUS: ${module.codeFiles.length ? "provided" : "none"}`,
            "EXECUTION_STATUS: not_run",
            `INPUT_FILES: ${module.inputFiles.join(", ") || "none identified"}`,
            `CODE_FILES: ${module.codeFiles.join(", ") || "none identified"}`,
          ],
        );
      } catch (error) {
        return failed("Exact template description failed", error);
      }
    },
  );

  server.registerTool(
    "figure_library_preview",
    {
      title: "Preview one provider-qualified exact template",
      description:
        "Return one selected preview as standard MCP image content and optionally copy it to a trusted absolute directory. Search never embeds all thumbnails.",
      inputSchema: PreviewInput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ providerId, exactSelector: raw, destination }): Promise<CallToolResult> => {
      try {
        const exactSelector = raw as unknown as ExactTemplateSelector;
        assertExactTemplateSelector(exactSelector);
        if (exactSelector.providerId !== providerId) throw new Error("providerId does not match exactSelector.providerId");
        let preview:
          | { bytes: Uint8Array; mimeType: string; extension: string; templateId: string }
          | undefined;
        if (providerId === LOCAL_LIBRARY_PROVIDER_ID) {
          const resolved = await resolveLocalPublished(await currentLibraries(), exactSelector);
          const loaded = await (await currentLibraries()).versionedLibrary.getPreview(
            resolved.identity.templateId,
            {
              revisionId: resolved.identity.revisionId,
              contentDigest: resolved.identity.contentDigest,
            },
          );
          if (loaded) preview = { ...loaded, templateId: resolved.identity.templateId };
        } else if (providerId === FIGUREYA_PROVIDER_ID) {
          const moduleId = exactSelector.identity.moduleId;
          if (
            typeof moduleId !== "string" ||
            exactSelector.identity.sourceCommit !== index.catalog.figureya.commit
          ) {
            throw new Error("stale or invalid FigureYa selector");
          }
          const loaded = await index.preview(exactSelector);
          if (loaded) preview = { ...loaded, templateId: moduleId };
        } else {
          throw new Error(`unsupported preview provider: ${providerId}`);
        }
        if (!preview) throw new Error("no preview is available for the exact selection");
        const sha256 = createHash("sha256").update(preview.bytes).digest("hex");
        let outputPath: string | undefined;
        if (destination) {
          if (!path.isAbsolute(destination)) throw new Error("preview destination must be absolute");
          const directory = path.resolve(destination);
          await fs.mkdir(directory, { recursive: true });
          const safeId =
            preview.templateId.replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/^[._-]+/gu, "") ||
            "template";
          outputPath = path.join(directory, `${safeId}-${sha256.slice(0, 12)}${preview.extension}`);
          try {
            await fs.writeFile(outputPath, preview.bytes, { flag: "wx" });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            const existing = new Uint8Array(await fs.readFile(outputPath));
            if (createHash("sha256").update(existing).digest("hex") !== sha256) {
              throw new Error(`refusing to overwrite a different preview: ${outputPath}`);
            }
          }
        }
        const responseEnvelope = outcome(
          "ok",
          "preview_ready",
          `Verified one exact preview for ${preview.templateId}; inspect it once and report the visual verdict.`,
        );
        return {
          content: [
            {
              type: "text",
              text: [
                `OUTCOME: ${responseEnvelope.outcome}`,
                "TERMINAL: true",
                "RETRY_SAME_CALL: false",
                `CODE: ${responseEnvelope.code}`,
                "NEXT_ACTION: none",
                responseEnvelope.summary,
                `PROVIDER_ID: ${providerId}`,
                `EXACT_SELECTOR: ${JSON.stringify(exactSelector)}`,
                `SHA256: ${sha256}`,
                `PATH: ${outputPath ?? "not copied"}`,
              ].join("\n"),
            },
            {
              type: "image",
              data: Buffer.from(preview.bytes).toString("base64"),
              mimeType: preview.mimeType,
            },
          ],
          structuredContent: {
            envelope: responseEnvelope,
            providerId,
            exactSelector,
            templateId: preview.templateId,
            mimeType: preview.mimeType,
            bytes: preview.bytes.byteLength,
            sha256,
            path: outputPath,
          },
        };
      } catch (error) {
        return failed("Exact template preview failed", error);
      }
    },
  );

  server.registerTool(
    "figure_library_source_status",
    {
      title: "Inspect global Library and Provider status",
      description:
        "Return complete text and structured status for the global portable Library, immutable lifecycle, write lock, and FigureYa. Capture/project-pin status is intentionally absent.",
      inputSchema: SourceStatusInput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ sourcePackDir }): Promise<CallToolResult> => {
      try {
        const context = await currentLibraries();
        const [library, marker, legacyFlat, figureYa, writeLock] = await Promise.all([
          context.versionedLibrary.status(),
          readLibraryRootMarker(context.snapshot.root),
          countLegacyFlat(context.snapshot.root),
          inspectFigureYaSourcePack(index.catalog, sourcePackDir),
          inspectLibraryWriteLock(path.join(context.snapshot.root, "locks", "write")),
        ]);
        const structured = {
          serverVersion: VERSION,
          library: {
            ...library,
            root: context.snapshot.root,
            directorySource: context.snapshot.directorySource,
            locatorPath: context.snapshot.locatorPath,
            locatorConfigured: context.snapshot.configRevision !== null,
            markerDigest: context.snapshot.markerDigest,
            storageFormat: marker?.value.storageFormat,
            requiredCapabilities: marker?.value.requiredCapabilities ?? [],
            extensions: marker?.value.extensions ?? {},
            legacyFlatCount: legacyFlat,
          },
          providers: {
            local: {
              providerId: LOCAL_LIBRARY_PROVIDER_ID,
              publishedCount: library.publishedCount,
              workingCount: library.workingCount,
              ordinarySearchScope: "Published only",
            },
            figureYa: {
              providerId: FIGUREYA_PROVIDER_ID,
              catalogTemplates: index.catalog.modules.length,
              sourceCommit: index.catalog.figureya.commit,
              archiveCommit: index.catalog.compressed.commit,
              sourcePack: figureYa,
            },
          },
          writeLock,
          standardCore: {
            directIntake: true,
            captureToolsRegistered: false,
            projectPinToolsRegistered: false,
            flatEntriesInOrdinarySearch: false,
          },
        };
        return terminal(
          outcome("ok", "source_status_ready", "Complete source status follows; no files were written."),
          structured,
          [
            `SERVER_VERSION: ${VERSION}`,
            `LIBRARY_ROOT: ${context.snapshot.root}`,
            `LIBRARY_SOURCE: ${context.snapshot.directorySource}`,
            `LIBRARY_ID: ${context.snapshot.libraryId ?? "unbound"}`,
            `LOCATOR_PATH: ${context.snapshot.locatorPath}`,
            `CONFIG_REVISION: ${context.snapshot.configRevision ?? "none"}`,
            `WRITES_ENABLED: ${context.snapshot.writesEnabled}`,
            `LIBRARY_EXISTS: ${library.exists}`,
            `LIBRARY_READABLE: ${library.readable}`,
            `LIBRARY_WRITABLE: ${library.writable}`,
            `STORAGE_FORMAT: ${marker ? `${marker.value.storageFormat.major}.${marker.value.storageFormat.minor}/${marker.value.storageFormat.layout}` : "uninitialized"}`,
            `SERIES: ${library.seriesCount}`,
            `PUBLISHED: ${library.publishedCount}`,
            `WORKING: ${library.workingCount}`,
            `LEGACY_FLAT: ${legacyFlat} (excluded from ordinary search until explicit adoption)`,
            `WRITE_LOCK_EXISTS: ${writeLock.exists}`,
            `FIGUREYA_CATALOG: ${index.catalog.modules.length}`,
            `FIGUREYA_SOURCE_COMMIT: ${index.catalog.figureya.commit}`,
            `FIGUREYA_ARCHIVE_COMMIT: ${index.catalog.compressed.commit}`,
            `FIGUREYA_SOURCE_PACK_CONFIGURED: ${figureYa.configured}`,
            `FIGUREYA_SOURCE_PACK_ROOT: ${figureYa.directory || "none"}`,
            `FIGUREYA_SOURCE_PACK_MANIFEST_VALID: ${figureYa.manifestValid}`,
            `FIGUREYA_SOURCE_PACK_READY: ${figureYa.ready}`,
            `FIGUREYA_ARCHIVES_AVAILABLE: ${figureYa.availableTemplates.length}`,
            `FIGUREYA_ARCHIVES_INVALID: ${figureYa.invalidTemplates.length}`,
            `CAPTURE_TOOLS_REGISTERED: false`,
            `PROJECT_PIN_TOOLS_REGISTERED: false`,
          ],
        );
      } catch (error) {
        return failed("Source status failed", error);
      }
    },
  );

  registerLibraryBindingTools({ server, runtime, currentLibraries });
  registerLifecycleTools({
    server,
    currentLibrary: async () => (await currentLibraries()).versionedLibrary,
  });
  registerMaterializationTools({ server, index, currentLibraries });
  registerBundleTools({ server, currentLibraries });

  return server;
}
