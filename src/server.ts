import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
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
import { canonicalJson } from "./canonical-json.ts";
import {
  DiagnosticsManager,
  UI_DIAGNOSTIC_EVENTS,
  type DiagnosticsExportInput,
} from "./diagnostics.ts";
import {
  PreviewConfirmationStore,
  PreviewProtocolError,
} from "./preview-confirmation.ts";
import {
  libraryBindingDigest,
  loadProviderPreview,
  searchCatalogRevision,
  sha256,
} from "./preview-service.ts";
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

export const VERSION = "0.5.1";
export const MATERIALIZATION_PROTOCOL_VERSION = 2;
const RESOURCE_URI = "ui://figure-library/candidates-v0.5.1.html";
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
const SearchPageInput = z.object({
  resultSetId: z.string().min(1).max(256),
  cursor: z.string().min(1).max(256),
});
const ExactPreviewInput = ProviderSelectionInput.extend({
  resultSetId: z.string().min(1).max(256),
});
const ConfirmPreviewInput = z.object({
  previewChallenge: z.string().min(1).max(256),
});
const PreviewInput = ProviderSelectionInput.extend({
  destination: z.string().min(1).max(4_000).optional(),
});
const SourceStatusInput = z.object({
  sourcePackDir: z.string().min(1).max(4_000).optional(),
});
const UiDiagnosticInput = z.object({
  event: z.enum(UI_DIAGNOSTIC_EVENTS),
  resultSetId: z.string().min(1).max(256),
  candidateId: z.string().min(1).max(256),
  correlationId: z.string().min(1).max(256).optional(),
  durationMs: z.number().finite().min(0).max(60 * 60 * 1_000).optional(),
  payloadBytes: z.number().int().min(0).max(16 * 1024 * 1024).optional(),
  previewBytes: z.number().int().min(0).max(16 * 1024 * 1024).optional(),
});
const DiagnosticsExportInputSchema = z.object({
  scope: z
    .enum(["last_operation", "current_session", "correlation_id", "time_range"])
    .optional()
    .default("current_session"),
  correlationId: z.string().min(1).max(256).optional(),
  since: z.string().min(1).max(64).optional(),
  until: z.string().min(1).max(64).optional(),
  detail: z
    .enum(["summary", "sanitized_bundle", "full_local"])
    .optional()
    .default("sanitized_bundle"),
  includeUserText: z.boolean().optional().default(false),
  includeAbsolutePaths: z.boolean().optional().default(false),
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
  meta?: Record<string, unknown>,
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
    ...(meta ? { _meta: meta } : {}),
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
    );

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
    "Retrieval candidates are now visible in the Scientific Figure Library App. Stop this turn and wait for the user to browse and select a candidate.",
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
    "NEXT_STEP: wait for App updateModelContext. If it reports handoffMode=headless_exact_review, review only that one user-selected candidate; otherwise do not call an exact-preview tool unless the user explicitly delegates headless visual review.",
  ].join("\n");
}

const MAX_THUMBNAIL_BYTES = 256 * 1024;
const MAX_PAGE_THUMBNAIL_BYTES = 3 * 1024 * 1024;

function searchQueryDigest(input: z.infer<typeof SearchInput>) {
  return sha256(
    canonicalJson({
      schema: "figure-library.search-query.v1",
      query: input.query,
      dataProfile: input.dataProfile ?? null,
      visualProfile: input.visualProfile ?? null,
      assetKind: input.assetKind ?? null,
      language: input.language ?? null,
      plotFamily: input.plotFamily ?? null,
      reviewStatus: input.reviewStatus ?? null,
      codeStatus: input.codeStatus ?? null,
      providerIds: [...input.providerIds].sort(),
      limit: input.limit,
    }),
  );
}

async function hydrateCandidatePreviews(options: {
  candidates: TemplateCandidate[];
  context: CurrentLibraryContext;
  index: CatalogIndex;
}) {
  let pageBytes = 0;
  const output: TemplateCandidate[] = [];
  for (const candidate of options.candidates) {
    if (!candidate.previewAvailable) {
      output.push({ ...candidate, previewStatus: "missing", previewRef: undefined });
      continue;
    }
    try {
      const preview = await loadProviderPreview({
        context: options.context,
        index: options.index,
        providerId: candidate.providerId,
        exactSelector: candidate.exactSelector,
      });
      if (preview.byteLength > MAX_THUMBNAIL_BYTES) {
        output.push({
          ...candidate,
          previewAvailable: false,
          previewRef: undefined,
          previewStatus: "too_large",
        });
        continue;
      }
      if (pageBytes + preview.byteLength > MAX_PAGE_THUMBNAIL_BYTES) {
        output.push({
          ...candidate,
          previewAvailable: false,
          previewRef: undefined,
          previewStatus: "too_large",
        });
        continue;
      }
      pageBytes += preview.byteLength;
      output.push({
        ...candidate,
        previewStatus: "ready",
        previewDataUrl: `data:${preview.mimeType};base64,${Buffer.from(preview.bytes).toString("base64")}`,
        previewMimeType: preview.mimeType,
        previewByteLength: preview.byteLength,
        previewSha256: preview.sha256,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      output.push({
        ...candidate,
        previewAvailable: false,
        previewRef: undefined,
        previewStatus: message.includes("unsupported") ? "unsupported" : message.includes("no preview") ? "missing" : "unreadable",
      });
    }
  }
  return output;
}

function scopedCandidateId(resultSetId: string, candidate: TemplateCandidate) {
  return `candidate-${sha256(
    canonicalJson({
      schema: "figure-library.result-candidate.v1",
      resultSetId,
      providerId: candidate.providerId,
      exactSelector: candidate.exactSelector,
    }),
  ).slice(0, 32)}`;
}

function splitCandidatePage(resultSetId: string, candidates: TemplateCandidate[]) {
  const candidatePreviews: Record<
    string,
    {
      previewDataUrl: string;
      previewMimeType?: string;
      previewByteLength?: number;
      previewSha256?: string;
    }
  > = {};
  const visibleCandidates = candidates.map((candidate) => {
    const candidateId = scopedCandidateId(resultSetId, candidate);
    const { previewDataUrl, ...visible } = candidate;
    if (previewDataUrl) {
      candidatePreviews[candidateId] = {
        previewDataUrl,
        previewMimeType: candidate.previewMimeType,
        previewByteLength: candidate.previewByteLength,
        previewSha256: candidate.previewSha256,
      };
    }
    return { ...visible, candidateId };
  });
  return { visibleCandidates, candidatePreviews };
}

function previewFailure(prefix: string, error: unknown): CallToolResult {
  if (error instanceof PreviewProtocolError) {
    return terminal(
      outcome(
        error.code === "preview_required" || error.code === "ui_confirmation_required"
          ? "blocked"
          : "conflict",
        error.code,
        `${prefix}: ${error.message}`,
        error.code === "search_results_stale" ? "preview_selected_candidate" : "ask_user",
      ),
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("preview_unavailable")) {
    return terminal(
      outcome("blocked", "preview_unavailable", `${prefix}: ${message}`, "ask_user"),
    );
  }
  if (message.includes("preview_stale")) {
    return terminal(
      outcome("conflict", "preview_stale", `${prefix}: ${message}`, "preview_selected_candidate"),
    );
  }
  return failed(prefix, error);
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

interface SearchSessionState {
  input: z.infer<typeof SearchInput>;
  request: SearchRequest;
  candidates: TemplateCandidate[];
  queryDigest: string;
  catalogRevision: string;
  libraryBindingDigest: string;
  localMatches: number;
  figureYaMatches: number;
  candidateIds: Set<string>;
}

export async function createServer() {
  const index = await CatalogIndex.load();
  const runtime = new LibraryRuntime();
  const previewConfirmations = new PreviewConfirmationStore();
  const diagnostics = new DiagnosticsManager();
  await diagnostics.start();
  const contexts = new Map<string, CurrentLibraryContext>();
  const searchSessions = new Map<string, SearchSessionState>();
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
      _meta: { ui: { resourceUri: RESOURCE_URI, visibility: ["model"] } },
    },
    async (): Promise<CallToolResult> => {
      const responseEnvelope = outcome(
        "ok",
        "library_ready",
        "Scientific Figure Library 0.5.1 is ready. Standard core uses direct user-confirmed image/code intake; Web Capture and project pins are not registered. Ask for a plotting goal before searching.",
        "ask_user",
      );
      return terminal(responseEnvelope, {
        query: "等待绘图目标",
        libraryVersion: VERSION,
        intentFamilies: [],
        reviewRequired: false,
        materializationProtocolVersion: MATERIALIZATION_PROTOCOL_VERSION,
        resultSetId: null,
        pagination: { total: 0, pageIndex: 0, pageSize: 6, hasMore: false, nextCursor: null },
        sources: [
          { providerId: LOCAL_LIBRARY_PROVIDER_ID, sourceLabel: "Local Published", matched: 0 },
          { providerId: FIGUREYA_PROVIDER_ID, sourceLabel: "FigureYa", matched: 0 },
        ],
        candidates: [],
        diagnosticsDegraded: diagnostics.degraded,
      });
    },
  );

  const buildSearchPage = async (options: {
    resultSetId: string;
    state: SearchSessionState;
    offset: number;
    limit: number;
    correlationId: string;
    invocationSource: "agent" | "app";
    toolName: "figure_library_search" | "figure_library_search_page";
    operationStartedAt: number;
  }): Promise<CallToolResult> => {
    const context = await currentLibraries();
    const currentCatalogRevision = await searchCatalogRevision(
      context,
      index,
      options.state.input.providerIds,
    );
    const currentBindingDigest = libraryBindingDigest(context);
    previewConfirmations.requireResultSet({
      resultSetId: options.resultSetId,
      queryDigest: options.state.queryDigest,
      catalogRevision: currentCatalogRevision,
      libraryBindingDigest: currentBindingDigest,
    });
    const rawPage = options.state.candidates.slice(
      options.offset,
      options.offset + options.limit,
    );
    const hydrated = await hydrateCandidatePreviews({ candidates: rawPage, context, index });
    const { visibleCandidates, candidatePreviews } = splitCandidatePage(
      options.resultSetId,
      hydrated,
    );
    const hasMore = options.offset + hydrated.length < options.state.candidates.length;
    const nextCursor = hasMore
      ? previewConfirmations.createCursor({
          resultSetId: options.resultSetId,
          queryDigest: options.state.queryDigest,
          catalogRevision: currentCatalogRevision,
          libraryBindingDigest: currentBindingDigest,
          offset: options.offset + options.limit,
          limit: options.limit,
        })
      : null;
    const pageIndex = options.state.candidates.length
      ? Math.floor(options.offset / options.limit) + 1
      : 0;
    const responseEnvelope = outcome(
      "ok",
      visibleCandidates.length ? "search_candidates_ready" : "search_no_matches",
      visibleCandidates.length
        ? `Unified search returned page ${pageIndex} of ${options.state.candidates.length} complete ranked matches. The App has verified thumbnails; the Agent must stop and wait for user selection.`
        : "Unified search completed without a matching Local Published or FigureYa candidate.",
      visibleCandidates.length ? "ask_user" : "none",
    );
    const structuredContent = {
      query: options.state.input.query,
      libraryVersion: VERSION,
      materializationProtocolVersion: MATERIALIZATION_PROTOCOL_VERSION,
      intentFamilies: buildSearchIntent(options.state.request).families,
      reviewRequired: true,
      resultSetId: options.resultSetId,
      correlationId: options.correlationId,
      total: options.state.candidates.length,
      pageIndex,
      hasMore,
      nextCursor,
      pagination: {
        total: options.state.candidates.length,
        pageIndex,
        pageSize: options.limit,
        hasMore,
        nextCursor,
      },
      sources: [
        {
          providerId: LOCAL_LIBRARY_PROVIDER_ID,
          sourceLabel: "Local Published",
          matched: options.state.localMatches,
        },
        {
          providerId: FIGUREYA_PROVIDER_ID,
          sourceLabel: "FigureYa",
          matched: options.state.figureYaMatches,
        },
      ],
      candidates: visibleCandidates,
      diagnosticsDegraded: diagnostics.degraded,
    };
    const result = terminal(
      responseEnvelope,
      structuredContent,
      [candidateText(visibleCandidates)],
      {
        candidatePreviews,
        diagnostics: {
          degraded: diagnostics.degraded,
          ...(diagnostics.degradationMessage
            ? { safeMessage: diagnostics.degradationMessage }
            : {}),
        },
      },
    );
    const previewBytes = hydrated.reduce(
      (sum, candidate) => sum + (candidate.previewByteLength ?? 0),
      0,
    );
    const payloadBytes = Buffer.byteLength(JSON.stringify(result));
    await diagnostics.record({
      event: "search.page_built",
      correlationId: options.correlationId,
      resultSetId: options.resultSetId,
      toolName: options.toolName,
      invocationSource: options.invocationSource,
      payloadBytes,
      previewBytes,
      catalogRevision: currentCatalogRevision,
      libraryRevision: currentBindingDigest,
    });
    await diagnostics.record({
      event: "search.completed",
      correlationId: options.correlationId,
      resultSetId: options.resultSetId,
      toolName: options.toolName,
      invocationSource: options.invocationSource,
      durationMs: performance.now() - options.operationStartedAt,
      payloadBytes,
      previewBytes,
      catalogRevision: currentCatalogRevision,
      libraryRevision: currentBindingDigest,
    });
    return result;
  };

  registerAppTool(
    server,
    "figure_library_search",
    {
      title: "Search all matching Local Published and FigureYa templates",
      description:
        "Search the complete ranked Local Published and FigureYa match set, open the candidate App, then stop and wait for the user to choose. Working, Capture, and flat-v1 entries remain excluded.",
      inputSchema: SearchInput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: {
        ui: { resourceUri: RESOURCE_URI, visibility: ["model"] },
        "openai/outputTemplate": RESOURCE_URI,
      },
    },
    async (input): Promise<CallToolResult> => {
      const operationStartedAt = performance.now();
      const correlationId = diagnostics.createCorrelationId("search");
      await diagnostics.record({
        event: "search.started",
        correlationId,
        toolName: "figure_library_search",
        invocationSource: "agent",
      });
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
        };
        const context = await currentLibraries();
        const queryDigest = searchQueryDigest(input);
        const catalogRevision = await searchCatalogRevision(context, index, input.providerIds);
        const bindingDigest = libraryBindingDigest(context);
        await diagnostics.record({
          event: "search.catalog_loaded",
          correlationId,
          toolName: "figure_library_search",
          invocationSource: "agent",
          catalogRevision,
          libraryRevision: bindingDigest,
        });
        const [local, figureYa] = await Promise.all([
          input.providerIds.includes(LOCAL_LIBRARY_PROVIDER_ID)
            ? localCandidates(context, request)
            : [],
          input.providerIds.includes(FIGUREYA_PROVIDER_ID) ? index.searchAll(request) : [],
        ]);
        const ranked = [...local, ...figureYa].sort((left, right) => {
          const score = right.retrievalScore - left.retrievalScore;
          if (score) return score;
          if (left.providerId !== right.providerId) {
            return left.providerId === LOCAL_LIBRARY_PROVIDER_ID ? -1 : 1;
          }
          return left.templateId.localeCompare(right.templateId);
        });
        const top = Math.max(ranked[0]?.retrievalScore ?? 1, 0.0001);
        const normalized = ranked.map((candidate) => ({
          ...candidate,
          retrievalScore: Math.round((candidate.retrievalScore / top) * 100),
        }));
        const resultSetId = previewConfirmations.registerResultSet({
          queryDigest,
          catalogRevision,
          libraryBindingDigest: bindingDigest,
          providerIds: input.providerIds,
          candidates: normalized,
        });
        const state: SearchSessionState = {
          input,
          request,
          candidates: normalized,
          queryDigest,
          catalogRevision,
          libraryBindingDigest: bindingDigest,
          localMatches: local.length,
          figureYaMatches: figureYa.length,
          candidateIds: new Set(normalized.map((candidate) => scopedCandidateId(resultSetId, candidate))),
        };
        searchSessions.set(resultSetId, state);
        while (searchSessions.size > 128) {
          const oldest = searchSessions.keys().next().value as string | undefined;
          if (!oldest) break;
          searchSessions.delete(oldest);
        }
        await diagnostics.record({
          event: "search.matched",
          correlationId,
          resultSetId,
          toolName: "figure_library_search",
          invocationSource: "agent",
          catalogRevision,
          libraryRevision: bindingDigest,
          safeMessage: `Matched ${normalized.length} candidates.`,
        });
        return await buildSearchPage({
          resultSetId,
          state,
          offset: 0,
          limit: input.limit,
          correlationId,
          invocationSource: "agent",
          toolName: "figure_library_search",
          operationStartedAt,
        });
      } catch (error) {
        await diagnostics.record({
          level: "error",
          event: "tool.failed",
          correlationId,
          toolName: "figure_library_search",
          invocationSource: "agent",
          durationMs: performance.now() - operationStartedAt,
          errorCode: error instanceof PreviewProtocolError ? error.code : "search_failed",
          safeMessage: error instanceof Error ? error.message : String(error),
        });
        return previewFailure("Unified search failed", error);
      }
    },
  );

  registerAppTool(
    server,
    "figure_library_search_page",
    {
      title: "Load another candidate page",
      description:
        "App-only pagination for an existing complete search result set.",
      inputSchema: SearchPageInput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      _meta: { ui: { resourceUri: RESOURCE_URI, visibility: ["app"] } },
    },
    async ({ resultSetId, cursor }): Promise<CallToolResult> => {
      const operationStartedAt = performance.now();
      const correlationId = diagnostics.createCorrelationId("search-page");
      await diagnostics.record({
        event: "search.started",
        correlationId,
        resultSetId,
        toolName: "figure_library_search_page",
        invocationSource: "app",
      });
      try {
        const state = searchSessions.get(resultSetId);
        if (!state) {
          throw new PreviewProtocolError(
            "search_results_stale",
            "The search result set is unavailable in this server session; run the search again.",
          );
        }
        const resolved = previewConfirmations.resolveCursor(cursor);
        if (resolved.resultSetId !== resultSetId) {
          throw new PreviewProtocolError(
            "search_results_stale",
            "The pagination cursor does not belong to this result set.",
          );
        }
        return await buildSearchPage({
          resultSetId,
          state,
          offset: resolved.offset,
          limit: resolved.limit,
          correlationId,
          invocationSource: "app",
          toolName: "figure_library_search_page",
          operationStartedAt,
        });
      } catch (error) {
        await diagnostics.record({
          level: "error",
          event: "tool.failed",
          correlationId,
          resultSetId,
          toolName: "figure_library_search_page",
          invocationSource: "app",
          durationMs: performance.now() - operationStartedAt,
          errorCode: error instanceof PreviewProtocolError ? error.code : "search_page_failed",
          safeMessage: error instanceof Error ? error.message : String(error),
        });
        return previewFailure("Candidate pagination failed", error);
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
      description: "Paginate all Local Published and FigureYa matches, display verified thumbnails, and confirm one exact preview.",
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

  const previewConfirmationCapabilities = {
    app: true,
    headless: true,
    receiptRequired: true,
    appPaginationTool: "figure_library_search_page",
    appExactPreviewTool: "figure_library_preview_exact",
    headlessExactPreviewTool: "figure_library_preview_exact_headless",
    updateModelContextFallback: true,
    fallbackHandoffMode: "headless_exact_review",
    fallbackCandidateLimit: 1,
    modelVisibleSearchIncludesImageData: false,
    componentThumbnailMetaKey: "candidatePreviews",
  } as const;
  const diagnosticsExportCapabilities = {
    exportTool: "figure_library_export_diagnostics",
    defaultScope: "current_session",
    defaultDetail: "sanitized_bundle",
    resourceUriTemplate: "figure-library://diagnostics/{bundleId}",
    sessionBound: true,
  } as const;

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
            {
              providerId,
              exactSelector,
              content,
              release,
              materializationProtocolVersion: MATERIALIZATION_PROTOCOL_VERSION,
              previewConfirmationCapabilities,
              diagnosticsExportCapabilities,
            },
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
            materializationProtocolVersion: MATERIALIZATION_PROTOCOL_VERSION,
            previewConfirmationCapabilities,
            diagnosticsExportCapabilities,
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
        "Return one selected preview as standard MCP image content and optionally copy it to a trusted absolute directory. This compatibility tool does not authorize materialization.",
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

  const exactPreviewForConfirmation = async (options: {
    resultSetId: string;
    providerId: string;
    exactSelector: ExactTemplateSelector;
    invocationSource: "app" | "headless";
    toolName: "figure_library_preview_exact" | "figure_library_preview_exact_headless";
  }): Promise<CallToolResult> => {
    const operationStartedAt = performance.now();
    const correlationId = diagnostics.createCorrelationId("exact-preview");
    await diagnostics.record({
      event: "exact_preview.requested",
      correlationId,
      resultSetId: options.resultSetId,
      toolName: options.toolName,
      invocationSource: options.invocationSource,
      providerId: options.providerId,
    });
    try {
      const context = await currentLibraries();
      const resultSet = previewConfirmations.getResultSet(options.resultSetId);
      const catalogRevision = await searchCatalogRevision(context, index, resultSet.providerIds);
      const bindingDigest = libraryBindingDigest(context);
      previewConfirmations.requireResultSet({
        resultSetId: options.resultSetId,
        catalogRevision,
        libraryBindingDigest: bindingDigest,
      });
      const preview = await loadProviderPreview({
        context,
        index,
        providerId: options.providerId,
        exactSelector: options.exactSelector,
      });
      const previewChallenge = previewConfirmations.issueChallenge({
        resultSetId: options.resultSetId,
        providerId: options.providerId,
        exactSelector: options.exactSelector,
        exactSelectorDigest: preview.exactSelectorDigest,
        previewSha256: preview.sha256,
        catalogRevision,
        libraryBindingDigest: bindingDigest,
      });
      const responseEnvelope = outcome(
        "needs_user_confirmation",
        "exact_preview_ready",
        options.invocationSource === "app"
          ? `Loaded the exact preview for ${preview.templateId}. The image must visibly load in the App before confirmation.`
          : `Loaded the exact preview for ${preview.templateId}. Review only this image before headless confirmation; this path cannot prove user-visible App loading.`,
        "ask_user",
      );
      const text = {
        type: "text" as const,
        text: [
          `OUTCOME: ${responseEnvelope.outcome}`,
          "TERMINAL: true",
          "RETRY_SAME_CALL: false",
          `CODE: ${responseEnvelope.code}`,
          `NEXT_ACTION: ${responseEnvelope.nextAction}`,
          responseEnvelope.summary,
          `RESULT_SET_ID: ${options.resultSetId}`,
          `PROVIDER_ID: ${options.providerId}`,
          `EXACT_SELECTOR: ${JSON.stringify(options.exactSelector)}`,
          `SHA256: ${preview.sha256}`,
        ].join("\n"),
      };
      const structuredContent = {
        envelope: responseEnvelope,
        resultSetId: options.resultSetId,
        correlationId,
        providerId: options.providerId,
        exactSelector: options.exactSelector,
        templateId: preview.templateId,
        mimeType: preview.mimeType,
        bytes: preview.byteLength,
        sha256: preview.sha256,
        previewSha256: preview.sha256,
        ...(options.invocationSource === "headless" ? { previewChallenge } : {}),
      };
      const result: CallToolResult =
        options.invocationSource === "app"
          ? {
              content: [text],
              structuredContent,
              _meta: {
                exactPreview: {
                  previewDataUrl: `data:${preview.mimeType};base64,${Buffer.from(preview.bytes).toString("base64")}`,
                  previewChallenge,
                },
              },
            }
          : {
              content: [
                text,
                {
                  type: "image",
                  data: Buffer.from(preview.bytes).toString("base64"),
                  mimeType: preview.mimeType,
                },
              ],
              structuredContent,
            };
      await diagnostics.record({
        event: "exact_preview.completed",
        correlationId,
        resultSetId: options.resultSetId,
        toolName: options.toolName,
        invocationSource: options.invocationSource,
        providerId: options.providerId,
        selectorDigest: preview.exactSelectorDigest,
        durationMs: performance.now() - operationStartedAt,
        payloadBytes: Buffer.byteLength(JSON.stringify(result)),
        previewBytes: preview.byteLength,
        catalogRevision,
        libraryRevision: bindingDigest,
      });
      return result;
    } catch (error) {
      await diagnostics.record({
        level: "error",
        event: "tool.failed",
        correlationId,
        resultSetId: options.resultSetId,
        toolName: options.toolName,
        invocationSource: options.invocationSource,
        providerId: options.providerId,
        durationMs: performance.now() - operationStartedAt,
        errorCode: error instanceof PreviewProtocolError ? error.code : "exact_preview_failed",
        safeMessage: error instanceof Error ? error.message : String(error),
      });
      return previewFailure("Exact confirmation preview failed", error);
    }
  };

  registerAppTool(
    server,
    "figure_library_preview_exact",
    {
      title: "Load one exact preview for confirmation",
      description:
        "App-only exact preview. It returns image bytes only to the component and issues a session-bound confirmation challenge.",
      inputSchema: ExactPreviewInput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: { ui: { resourceUri: RESOURCE_URI, visibility: ["app"] } },
    },
    async ({ resultSetId, providerId, exactSelector: raw }): Promise<CallToolResult> =>
      exactPreviewForConfirmation({
        resultSetId,
        providerId,
        exactSelector: raw as unknown as ExactTemplateSelector,
        invocationSource: "app",
        toolName: "figure_library_preview_exact",
      }),
  );

  server.registerTool(
    "figure_library_preview_exact_headless",
    {
      title: "Load one exact preview for explicit headless review",
      description:
        "Model-visible exact preview. Call only after the user selects a candidate, explicitly delegates visual review, or an App updateModelContext handoff selects one candidate; do not iterate all results.",
      inputSchema: ExactPreviewInput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: { ui: { visibility: ["model"] } },
    },
    async ({ resultSetId, providerId, exactSelector: raw }): Promise<CallToolResult> =>
      exactPreviewForConfirmation({
        resultSetId,
        providerId,
        exactSelector: raw as unknown as ExactTemplateSelector,
        invocationSource: "headless",
        toolName: "figure_library_preview_exact_headless",
      }),
  );

  registerAppTool(
    server,
    "figure_library_confirm_selection",
    {
      title: "Confirm a visibly loaded exact preview",
      description:
        "App-only confirmation. The candidate workbench calls this only after the exact image load event and an explicit user click.",
      inputSchema: ConfirmPreviewInput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: { ui: { resourceUri: RESOURCE_URI, visibility: ["app"] } },
    },
    async ({ previewChallenge }): Promise<CallToolResult> => {
      const correlationId = diagnostics.createCorrelationId("confirmation");
      const operationStartedAt = performance.now();
      await diagnostics.record({
        event: "candidate.confirmation_requested",
        correlationId,
        toolName: "figure_library_confirm_selection",
        invocationSource: "app",
      });
      try {
        const receipt = previewConfirmations.confirm(previewChallenge, "app");
        await diagnostics.record({
          event: "candidate.confirmed",
          correlationId,
          resultSetId: receipt.resultSetId,
          toolName: "figure_library_confirm_selection",
          invocationSource: "app",
          providerId: receipt.providerId,
          selectorDigest: receipt.exactSelectorDigest,
          durationMs: performance.now() - operationStartedAt,
          previewBytes: undefined,
          catalogRevision: receipt.catalogRevision,
          libraryRevision: receipt.libraryBindingDigest,
        });
        return terminal(
          outcome(
            "ok",
            "preview_confirmed",
            "The App-confirmed exact preview is authorized for one materialization plan in this server session.",
            "review_plan",
          ),
          {
            previewReceipt: receipt.previewReceipt,
            confirmationMode: receipt.confirmationMode,
            resultSetId: receipt.resultSetId,
            providerId: receipt.providerId,
            exactSelector: receipt.exactSelector,
            previewSha256: receipt.previewSha256,
          },
          [`PREVIEW_RECEIPT: ${receipt.previewReceipt}`],
        );
      } catch (error) {
        await diagnostics.record({
          level: "error",
          event: "tool.failed",
          correlationId,
          toolName: "figure_library_confirm_selection",
          invocationSource: "app",
          durationMs: performance.now() - operationStartedAt,
          errorCode: error instanceof PreviewProtocolError ? error.code : "confirmation_failed",
          safeMessage: error instanceof Error ? error.message : String(error),
        });
        return previewFailure("App preview confirmation failed", error);
      }
    },
  );

  server.registerTool(
    "figure_library_confirm_selection_headless",
    {
      title: "Confirm an exact preview after headless Agent review",
      description:
        "Model-visible confirmation after figure_library_preview_exact_headless. Use only after a user selection, explicit delegation, or an App updateModelContext handoff when serverTools is unavailable; this call cannot prove UI visibility.",
      inputSchema: ConfirmPreviewInput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ previewChallenge }): Promise<CallToolResult> => {
      const correlationId = diagnostics.createCorrelationId("confirmation-headless");
      const operationStartedAt = performance.now();
      await diagnostics.record({
        event: "candidate.confirmation_requested",
        correlationId,
        toolName: "figure_library_confirm_selection_headless",
        invocationSource: "headless",
      });
      try {
        const receipt = previewConfirmations.confirm(previewChallenge, "headless");
        await diagnostics.record({
          event: "candidate.confirmed",
          correlationId,
          resultSetId: receipt.resultSetId,
          toolName: "figure_library_confirm_selection_headless",
          invocationSource: "headless",
          providerId: receipt.providerId,
          selectorDigest: receipt.exactSelectorDigest,
          durationMs: performance.now() - operationStartedAt,
          catalogRevision: receipt.catalogRevision,
          libraryRevision: receipt.libraryBindingDigest,
        });
        return terminal(
          outcome(
            "ok",
            "preview_confirmed_headless",
            "The headless or updateModelContext-fallback confirmation sequence is authorized for one materialization plan. User visibility remains a Host/Skill boundary.",
            "review_plan",
          ),
          {
            previewReceipt: receipt.previewReceipt,
            confirmationMode: receipt.confirmationMode,
            resultSetId: receipt.resultSetId,
            providerId: receipt.providerId,
            exactSelector: receipt.exactSelector,
            previewSha256: receipt.previewSha256,
          },
          [`PREVIEW_RECEIPT: ${receipt.previewReceipt}`],
        );
      } catch (error) {
        await diagnostics.record({
          level: "error",
          event: "tool.failed",
          correlationId,
          toolName: "figure_library_confirm_selection_headless",
          invocationSource: "headless",
          durationMs: performance.now() - operationStartedAt,
          errorCode: error instanceof PreviewProtocolError ? error.code : "confirmation_failed",
          safeMessage: error instanceof Error ? error.message : String(error),
        });
        return previewFailure("Headless preview confirmation failed", error);
      }
    },
  );

  registerAppTool(
    server,
    "figure_library_record_ui_event",
    {
      title: "Record a bounded candidate-workbench event",
      description:
        "Internal App-only structured diagnostics. It accepts a fixed event enum and no arbitrary log text.",
      inputSchema: UiDiagnosticInput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: { ui: { resourceUri: RESOURCE_URI, visibility: ["app"] } },
    },
    async (input): Promise<CallToolResult> => {
      try {
        const state = searchSessions.get(input.resultSetId);
        if (!state || !state.candidateIds.has(input.candidateId)) {
          throw new PreviewProtocolError(
            "search_results_stale",
            "The UI event does not belong to a current result set and candidate.",
          );
        }
        await diagnostics.recordUiEvent(input);
        return terminal(
          outcome("ok", "ui_event_recorded", "The bounded UI diagnostic event was recorded."),
          { accepted: true, diagnosticsDegraded: diagnostics.degraded },
        );
      } catch (error) {
        return previewFailure("UI diagnostic event rejected", error);
      }
    },
  );

  server.registerTool(
    "figure_library_export_diagnostics",
    {
      title: "Export Scientific Figure Library diagnostics",
      description:
        "Export a bounded, secret-safe diagnostic ZIP for the current server session. Defaults to sanitized_bundle, excludes user text and absolute paths, and never uploads data.",
      inputSchema: DiagnosticsExportInputSchema.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      _meta: { ui: { visibility: ["model"] } },
    },
    async (input): Promise<CallToolResult> => {
      const correlationId = diagnostics.createCorrelationId("diagnostics-export");
      const operationStartedAt = performance.now();
      await diagnostics.record({
        event: "diagnostics.export_requested",
        correlationId,
        toolName: "figure_library_export_diagnostics",
        invocationSource: "agent",
      });
      try {
        const result = await diagnostics.exportBundle(input as DiagnosticsExportInput);
        await diagnostics.record({
          event: "diagnostics.export_completed",
          correlationId,
          toolName: "figure_library_export_diagnostics",
          invocationSource: "agent",
          durationMs: performance.now() - operationStartedAt,
          payloadBytes: result.byteLength,
        });
        const responseEnvelope = outcome(
          "ok",
          "diagnostics_exported",
          `Created the ${result.redacted ? "redacted" : "local"} diagnostic bundle ${result.fileName}.`,
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
                `NEXT_ACTION: ${responseEnvelope.nextAction}`,
                responseEnvelope.summary,
                `BUNDLE_ID: ${result.bundleId}`,
                `FILE_NAME: ${result.fileName}`,
                `BYTE_LENGTH: ${result.byteLength}`,
                `SHA256: ${result.sha256}`,
                `RESOURCE_URI: ${result.resourceUri}`,
                ...(result.localPath ? [`LOCAL_PATH: ${result.localPath}`] : []),
              ].join("\n"),
            },
            {
              type: "resource_link",
              uri: result.resourceUri,
              name: result.fileName,
              description: "Sanitized Scientific Figure Library diagnostic ZIP",
              mimeType: "application/zip",
              size: result.byteLength,
            },
          ],
          structuredContent: {
            envelope: responseEnvelope,
            ...result,
            diagnosticsDegraded: diagnostics.degraded,
          },
        };
      } catch (error) {
        await diagnostics.record({
          level: "error",
          event: "tool.failed",
          correlationId,
          toolName: "figure_library_export_diagnostics",
          invocationSource: "agent",
          durationMs: performance.now() - operationStartedAt,
          errorCode: "diagnostics_export_failed",
          safeMessage: error instanceof Error ? error.message : String(error),
        });
        return failed("Diagnostics export failed", error);
      }
    },
  );

  server.registerResource(
    "Scientific Figure Library diagnostic bundle",
    new ResourceTemplate("figure-library://diagnostics/{bundleId}", { list: undefined }),
    {
      title: "Session-bound Scientific Figure Library diagnostic ZIP",
      description:
        "A generated diagnostic bundle is readable only while its originating MCP server session remains alive.",
      mimeType: "application/zip",
    },
    async (uri, variables): Promise<ReadResourceResult> => {
      const raw = variables.bundleId;
      const bundleId = Array.isArray(raw) ? raw[0] : raw;
      if (typeof bundleId !== "string" || !bundleId) {
        throw new Error("diagnostics bundleId is required");
      }
      const bundle = diagnostics.readBundle(bundleId);
      if (uri.href !== bundle.resourceUri) {
        throw new Error("diagnostics resource URI does not match this session bundle");
      }
      return {
        contents: [
          {
            uri: bundle.resourceUri,
            mimeType: "application/zip",
            blob: Buffer.from(bundle.bytes).toString("base64"),
          },
        ],
      };
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
            materializationProtocolVersion: MATERIALIZATION_PROTOCOL_VERSION,
            appPreviewConfirmation: true,
            headlessConfirmation: true,
            captureToolsRegistered: false,
            projectPinToolsRegistered: false,
            flatEntriesInOrdinarySearch: false,
            diagnostics: {
              enabled: true,
              degraded: diagnostics.degraded,
              directorySource: process.env.SFL_DIAGNOSTICS_DIR ? "environment" : "system-temp",
              maxFileBytes: diagnostics.maxFileBytes,
              maxTotalBytes: diagnostics.maxTotalBytes,
              exportTool: "figure_library_export_diagnostics",
            },
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
            `MATERIALIZATION_PROTOCOL_VERSION: ${MATERIALIZATION_PROTOCOL_VERSION}`,
            `CAPTURE_TOOLS_REGISTERED: false`,
            `PROJECT_PIN_TOOLS_REGISTERED: false`,
            `DIAGNOSTICS_DEGRADED: ${diagnostics.degraded}`,
            `DIAGNOSTICS_MAX_FILE_BYTES: ${diagnostics.maxFileBytes}`,
            `DIAGNOSTICS_MAX_TOTAL_BYTES: ${diagnostics.maxTotalBytes}`,
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
  registerMaterializationTools({
    server,
    index,
    currentLibraries,
    previewConfirmations,
    diagnostics,
  });
  registerBundleTools({ server, currentLibraries });

  return server;
}
