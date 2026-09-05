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
} from "./catalog.ts";
import { registerBundleTools } from "./bundle-tools.ts";
import { inspectLibraryWriteLock } from "./cross-runtime-lock.ts";
import {
  type CurrentLibraryContext,
  registerLibraryBindingTools,
  type ToolOutcomeEnvelope,
} from "./library-binding-tools.ts";
import { LibraryRuntime, readLibraryRootMarker } from "./library-runtime.ts";
import { WorkspaceRuntime } from "./workspace-runtime.ts";
import { registerLifecycleTools } from "./lifecycle-tools.ts";
import { registerMaterializationTools } from "./materialization-tools.ts";
import { registerGitHubPublicationTools } from "./github-publication-tools.ts";
import { registerOpenFigurePrTools } from "./open-figure-pr-tools.ts";
import { registerPublicationExportTools } from "./publication-export-tools.ts";
import { registerProviderSourceTools } from "./provider-source-tools.ts";
import { ProviderSourceManager } from "./provider-sources.ts";
import { createRuntimeProviderController } from "./provider-runtime.ts";
import {
  PublicCatalogProviderAdapter,
} from "./public-catalog-provider.ts";
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
  sha256,
} from "./preview-service.ts";
import {
  SEARCH_CONCURRENCY,
  SEARCH_MAX_PAGE_DATA_URL_BYTES,
  mapPool,
  prepareTransportImage,
  searchPerImageBudget,
  singlePreviewBudget,
} from "./transport-image.ts";
import { assertExactTemplateSelector, exactSelectorDigest } from "./providers.ts";
import {
  PERSONAL_MODULE_PROVIDER_ID,
  LOCAL_LIBRARY_PROVIDER_ID,
} from "./providers.ts";
import { COMMUNITY_PROVIDER_ID } from "./public-catalog-provider.ts";
import {
  createDefaultProviderRegistry,
  createProviderContext,
  UnavailableProviderAdapter,
  type ProviderRegistry,
} from "./provider-registry.ts";
import type {
  ExactTemplateSelector,
  SearchRequest,
  TemplateCandidate,
  ValidationStateSummaryV1,
} from "./types.ts";
import { legacyValidationStateFromExecutionStatus, VersionedTemplateLibrary } from "./versioned-library.ts";
import { VERSION } from "./version.ts";
import { SFL_SERVER_IDENTITY } from "./brand.ts";

export { VERSION };
export const MATERIALIZATION_PROTOCOL_VERSION = 2;
const RESOURCE_URI = `ui://figure-library/candidates-v${VERSION}.html`;
const APP_HTML = path.resolve(import.meta.dirname, "mcp-app.html");
const HASH = /^[a-f0-9]{64}$/u;

const ExactSelectorSchema = z.record(z.string(), z.unknown());
const ProviderSelectionInput = z.object({
  providerId: z.string().min(1).max(200),
  exactSelector: ExactSelectorSchema,
});
const SearchInput = z.object({
  resultSetId: z.string().min(1).max(256).optional().describe("Present the exact cached result set returned by an Open Figure PR Plan; keep its query, filters, providers and limit unchanged."),
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
    .optional(),
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
  moduleSourcePackDir: z.string().min(1).max(4_000).optional(),
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

function compatibilityValidationState(
  executionStatus: TemplateCandidate["executionStatus"],
): ValidationStateSummaryV1 {
  return legacyValidationStateFromExecutionStatus(
    executionStatus === "passed" || executionStatus === "failed"
      ? executionStatus
      : "not_run",
  );
}

function candidateValidationState(candidate: TemplateCandidate) {
  return candidate.validationState ?? compatibilityValidationState(candidate.executionStatus);
}

function validationStateText(state: ValidationStateSummaryV1) {
  return [
    `plotExecution=${state.plotExecution.status} (scope=${state.plotExecution.scope})`,
    `upstreamWorkflow=${state.upstreamWorkflow.status} (scope=${
      state.upstreamWorkflow.scope ?? "unspecified"
    })`,
    `scientificValidation=${state.scientificValidation.status} (source=${
      state.scientificValidation.decisionSource ?? "unspecified"
    })`,
  ];
}

function candidateText(candidates: TemplateCandidate[]) {
  if (!candidates.length) {
    return "No matching templates were found in the selected Providers. No tool retry is needed unless the user changes the search intent.";
  }
  const publicationReview = candidates.some((candidate) => candidate.matchKind);
  return [
    ...(publicationReview ? ["PUBLICATION_REVIEW: compare these exact candidates and wait for explicit user confirmation; do not materialize or plot them. Retrieval scores are not duplication proof."] : []),
    "Retrieval candidates are now visible in the Scientific Figure Library App. Stop this turn and wait for the user to browse and select a candidate.",
    ...candidates.flatMap((candidate, index) => [
      `${index + 1}. ${candidate.title}`,
      `   PROVIDER_ID: ${candidate.providerId}`,
      `   TEMPLATE_ID: ${candidate.templateId}`,
      `   EXACT_SELECTOR: ${JSON.stringify(candidate.exactSelector)}`,
      `   RETRIEVAL_SCORE: ${candidate.retrievalScore}/100`,
      ...(candidate.matchKind
        ? [`   MATCH_KIND: ${candidate.matchKind}; retrieval score is ranking evidence, not proof of duplication.`]
        : []),
      `   STATE: review=${candidate.reviewStatus}; code=${candidate.codeStatus}; ${validationStateText(
        candidateValidationState(candidate),
      ).join("; ")}`,
      ...(candidate.canonicalPreviewDecision
        ? [
            `   CANONICAL_PREVIEW: ${candidate.canonicalPreviewDecision.reason}; asset=${candidate.canonicalPreviewDecision.assetPath}`,
          ]
        : []),
      `   PREVIEW_AVAILABLE: ${candidate.previewAvailable}`,
      ...(candidate.materializationModes?.length
        ? [`   MATERIALIZATION_MODES: ${candidate.materializationModes.join(", ")}`]
        : []),
      `   REASONS: ${candidate.reasons.join("; ") || "catalog metadata match"}`,
      ...(candidate.warnings.length
        ? [`   WARNINGS: ${candidate.warnings.join("; ")}`]
        : []),
    ]),
    publicationReview ? "NEXT_STEP: wait for the user to confirm whether these publication candidates are duplicates. No Apply before confirmation." : "NEXT_STEP: wait for App updateModelContext. If it reports handoffMode=agent_plot_set, plot every selected candidate in the current project. If it reports handoffMode=headless_exact_review, review only that one candidate. Otherwise do not call an exact-preview tool unless the user explicitly delegates headless visual review.",
  ].join("\n");
}

type ParsedSearchInput = Omit<z.infer<typeof SearchInput>, "providerIds" | "resultSetId"> & {
  providerIds: string[];
};

function searchQueryDigest(input: ParsedSearchInput) {
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

function transportPreviewStatus(reason: string): TemplateCandidate["previewStatus"] {
  if (reason === "unsupported") return "unsupported";
  if (reason === "too_large" || reason === "unsafe_pixels") return "too_large";
  return "unreadable";
}

function searchPageInlineBytes(candidates: TemplateCandidate[]) {
  return candidates.reduce(
    (sum, candidate) => sum + (candidate.previewDataUrl ? candidate.previewDataUrl.length : 0),
    0,
  );
}

async function hydrateCandidatePreviews(options: {
  candidates: TemplateCandidate[];
  context: CurrentLibraryContext;
  index: CatalogIndex;
  registry: ProviderRegistry;
  moduleCatalogs?: ReadonlyMap<string, import("./module-catalog.ts").ModuleCatalogIndex>;
}) {
  const needed = options.candidates.filter(
    (candidate) => candidate.searchPreviewAvailable ?? candidate.previewAvailable,
  ).length;
  let perImageBudget = searchPerImageBudget(needed);
  const hydrateOnce = (budget: number): Promise<TemplateCandidate[]> =>
    mapPool(options.candidates, SEARCH_CONCURRENCY, async (candidate): Promise<TemplateCandidate> => {
      if (!candidate.previewAvailable) {
        if (!(candidate.searchPreviewAvailable ?? false)) {
          return {
            ...candidate,
            previewStatus: "missing" as const,
            searchPreviewStatus: "missing" as const,
            previewRef: undefined,
          };
        }
      }
      if (candidate.searchPreviewAvailable === false) {
        return { ...candidate, searchPreviewStatus: "missing" as const };
      }
      try {
        const preview = await loadProviderPreview({
          context: options.context,
          index: options.index,
          providerId: candidate.providerId,
          exactSelector: candidate.exactSelector,
          registry: options.registry,
          moduleCatalogs: options.moduleCatalogs,
          purpose: "search",
        });
        const transport = await prepareTransportImage({
          sourceBytes: preview.bytes,
          sourceMime: preview.mimeType,
          sourceSha256: preview.sha256,
          purpose: "SearchCard",
          maxDataUrlBytes: budget,
          libraryRoot: options.context.snapshot.root,
        });
        if (!transport.ok) {
          return {
            ...candidate,
            searchPreviewAvailable: false,
            searchPreviewStatus: transportPreviewStatus(transport.reason),
            ...(candidate.searchPreviewAvailable === undefined
              ? { previewStatus: transportPreviewStatus(transport.reason) }
              : {}),
          };
        }
        return {
          ...candidate,
          ...(candidate.searchPreviewAvailable === undefined
            ? { previewStatus: "ready" as const }
            : {}),
          searchPreviewStatus: "ready" as const,
          previewDataUrl: transport.dataUrl,
          previewMimeType: preview.mimeType,
          previewByteLength: preview.byteLength,
          previewSha256: preview.sha256,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const previewStatus: NonNullable<TemplateCandidate["previewStatus"]> = message.includes(
          "unsupported",
        )
          ? "unsupported"
          : message.includes("no preview")
            ? "missing"
            : "unreadable";
        return {
          ...candidate,
          searchPreviewAvailable: false,
          searchPreviewStatus: previewStatus,
          ...(candidate.searchPreviewAvailable === undefined ? { previewStatus } : {}),
        };
      }
    });

  let output = await hydrateOnce(perImageBudget);
  while (
    searchPageInlineBytes(output) > SEARCH_MAX_PAGE_DATA_URL_BYTES &&
    perImageBudget > 32 * 1024
  ) {
    perImageBudget = Math.max(32 * 1024, Math.floor(perImageBudget / 2));
    output = await hydrateOnce(perImageBudget);
  }
  if (searchPageInlineBytes(output) > SEARCH_MAX_PAGE_DATA_URL_BYTES) {
    let remaining = searchPageInlineBytes(output);
    for (let index = output.length - 1; index >= 0 && remaining > SEARCH_MAX_PAGE_DATA_URL_BYTES; index -= 1) {
      const candidate = output[index];
      if (!candidate?.previewDataUrl) continue;
      remaining -= candidate.previewDataUrl.length;
      output[index] = {
        ...candidate,
        searchPreviewAvailable: false,
        searchPreviewStatus: "too_large" as const,
        ...(candidate.searchPreviewAvailable === undefined
          ? { previewStatus: "too_large" as const }
          : {}),
        previewDataUrl: undefined,
      };
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
  presented?: boolean;
  input: ParsedSearchInput;
  request: SearchRequest;
  candidates: TemplateCandidate[];
  queryDigest: string;
  catalogRevision: string;
  libraryBindingDigest: string;
  providerMatches: Record<string, number>;
  providerFailures: Record<
    string,
    { health: "degraded" | "corrupt"; errorCode: string; safeMessage: string }
  >;
  candidateIds: Set<string>;
}

export async function createServer(options: {
  registry?: ProviderRegistry;
  providerSourceManager?: ProviderSourceManager;
  personalModuleRoot?: string;
  /** Internal transport injection for deterministic publication integration tests. */
  openFigurePr?: { ghRunner: import("./github-publication-tools.ts").GhRunner; receiptDirectory: string };
} = {}) {
  const index = await CatalogIndex.load();
  const providerController = options.registry
    ? undefined
    : await createRuntimeProviderController({
        manager: options.providerSourceManager,
        personalModuleRoot: options.personalModuleRoot,
      });
  const registry = options.registry ?? providerController?.registry ?? createDefaultProviderRegistry();
  const providerSourceManager =
    options.providerSourceManager ?? providerController?.manager ?? new ProviderSourceManager();
  const moduleCatalogs = providerController?.moduleCatalogs;
  const runtime = new LibraryRuntime();
  const workspaceRuntime = new WorkspaceRuntime();
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
  const currentProviderContext = async (
    sourcePackDir?: string,
    moduleSourcePackDir?: string,
  ) =>
    createProviderContext(await currentLibraries(), index, {
      ...(moduleCatalogs ? { moduleCatalogs } : {}),
      ...(sourcePackDir ? { sourcePackDir } : {}),
      ...(moduleSourcePackDir ? { moduleSourcePackDir } : {}),
    });

  const server = new McpServer({ ...SFL_SERVER_IDENTITY, version: VERSION });

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
        `Scientific Figure Library ${VERSION} is ready. Standard core uses direct user-confirmed image/code intake; Web Capture and project pins are not registered. Ask for a plotting goal before searching.`,
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
        sources: registry.list().map(({ providerId, sourceLabel }) => ({
          providerId,
          sourceLabel,
          matched: 0,
        })),
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
    const currentCatalogRevision = await registry.catalogRevision(
      options.state.input.providerIds,
      createProviderContext(context, index, {
        ...(moduleCatalogs ? { moduleCatalogs } : {}),
      }),
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
    const hydrated = await hydrateCandidatePreviews({
      candidates: rawPage,
      context,
      index,
      registry,
      moduleCatalogs,
    });
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
        : "Unified search completed without a matching candidate from the selected Providers.",
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
      sources: registry.list().map(({ providerId, sourceLabel }) => {
        const failure = options.state.providerFailures[providerId];
        return {
          providerId,
          sourceLabel,
          matched: options.state.providerMatches[providerId] ?? 0,
          health: failure?.health ?? "ready",
          ...(failure
            ? { errorCode: failure.errorCode, safeMessage: failure.safeMessage }
            : {}),
        };
      }),
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
    options.state.presented = true;
    return result;
  };

  registerAppTool(
    server,
    "figure_library_search",
    {
      title: "Search all matching scientific figure Providers",
      description:
        "Search the complete ranked Local Published, FigureYa, bundled Open Figure Modules, and opted-in dynamic personal Provider match set, open the candidate App, then stop and wait for the user to choose. Community is frozen and excluded from default search; Working, Capture, and flat-v1 entries remain excluded.",
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
        const explicitlySelected = input.providerIds !== undefined;
        const parsedInput: ParsedSearchInput = {
          ...input,
          providerIds: input.providerIds ?? registry.defaultProviderIds(),
        };
        if (input.resultSetId) {
          const state = searchSessions.get(input.resultSetId);
          if (!state || state.queryDigest !== searchQueryDigest(parsedInput)) throw new Error("The cached publication search is missing or its query/filters changed; create a new Plan.");
          return await buildSearchPage({ resultSetId: input.resultSetId, state, offset: 0, limit: parsedInput.limit, correlationId, invocationSource: "agent", toolName: "figure_library_search", operationStartedAt });
        }
        const request: SearchRequest = {
          query: parsedInput.query,
          dataProfile: parsedInput.dataProfile,
          visualProfile: parsedInput.visualProfile,
          assetKind: parsedInput.assetKind,
          language: parsedInput.language,
          plotFamily: parsedInput.plotFamily,
          reviewStatus: parsedInput.reviewStatus,
          codeStatus: parsedInput.codeStatus,
        };
        const context = await currentLibraries();
        const providerContext = createProviderContext(context, index, {
          ...(moduleCatalogs ? { moduleCatalogs } : {}),
        });
        const queryDigest = searchQueryDigest(parsedInput);
        const catalogRevision = await registry.catalogRevision(
          parsedInput.providerIds,
          providerContext,
        );
        const bindingDigest = libraryBindingDigest(context);
        await diagnostics.record({
          event: "search.catalog_loaded",
          correlationId,
          toolName: "figure_library_search",
          invocationSource: "agent",
          catalogRevision,
          libraryRevision: bindingDigest,
        });
        const searched: Array<{ providerId: string; candidates: TemplateCandidate[] }> = [];
        const providerFailures: SearchSessionState["providerFailures"] = {};
        await Promise.all(
          parsedInput.providerIds.map(async (providerId) => {
            try {
              searched.push({
                providerId,
                candidates: await registry.get(providerId).search(providerContext, request),
              });
            } catch (error) {
              const raw = error instanceof Error ? error.message : String(error);
              const [possibleCode] = raw.split(":", 1);
              providerFailures[providerId] = {
                health: raw.includes("corrupt") ? "corrupt" : "degraded",
                errorCode: /^[a-z0-9_]+$/u.test(possibleCode ?? "")
                  ? possibleCode!
                  : "provider_search_failed",
                safeMessage: raw.replace(/[\r\n\t]+/gu, " ").slice(0, 500),
              };
            }
          }),
        );
        if (
          explicitlySelected &&
          parsedInput.providerIds.length === 1 &&
          providerFailures[parsedInput.providerIds[0]!]
        ) {
          const failure = providerFailures[parsedInput.providerIds[0]!]!;
          throw new Error(`${failure.errorCode}: ${failure.safeMessage}`);
        }
        const providerMatches = Object.fromEntries(
          searched.map(({ providerId, candidates }) => [providerId, candidates.length]),
        );
        const order = new Map(
          registry.list().map(({ providerId }, index) => [providerId, index]),
        );
        const ranked = searched.flatMap(({ candidates }) => candidates).sort((left, right) => {
          const score = right.retrievalScore - left.retrievalScore;
          if (score) return score;
          if (left.providerId !== right.providerId) {
            return (order.get(left.providerId) ?? Number.MAX_SAFE_INTEGER) -
              (order.get(right.providerId) ?? Number.MAX_SAFE_INTEGER);
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
          providerIds: parsedInput.providerIds,
          candidates: normalized.map((candidate) => ({
            providerId: candidate.providerId,
            exactSelector: candidate.exactSelector,
            alternateSelectors: Object.values(candidate.materializationSelectors ?? {}).filter(
              (selector): selector is ExactTemplateSelector =>
                selector !== undefined &&
                exactSelectorDigest(selector) !== exactSelectorDigest(candidate.exactSelector),
            ),
          })),
        });
        const state: SearchSessionState = {
          input: parsedInput,
          request,
          candidates: normalized,
          queryDigest,
          catalogRevision,
          libraryBindingDigest: bindingDigest,
          providerMatches,
          providerFailures,
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
          limit: parsedInput.limit,
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
      description: "Paginate matches from the selected Providers, display verified search thumbnails, and confirm one exact preview.",
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
        "Describe an exact Local Published release, bundled/personal public template, or commit-pinned FigureYa module. A bare templateId is deliberately insufficient.",
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
        const providerContext = await currentProviderContext();
        const adapter = registry.get(providerId);
        const resolved = await adapter.resolve(providerContext, exactSelector, "describe");
        const description = await adapter.describe(providerContext, resolved);
        return terminal(
          outcome("ok", description.code, description.summary),
          {
            providerId,
            exactSelector,
            ...description.detail,
            materializationProtocolVersion: MATERIALIZATION_PROTOCOL_VERSION,
            previewConfirmationCapabilities,
            diagnosticsExportCapabilities,
          },
          [
            `PROVIDER_ID: ${providerId}`,
            `EXACT_SELECTOR: ${JSON.stringify(exactSelector)}`,
            ...description.lines,
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
        const context = await currentLibraries();
        const preview = await loadProviderPreview({
          context,
          index,
          providerId,
          exactSelector,
          registry,
          moduleCatalogs,
        });
        const sha256 = preview.sha256;
        const transport = await prepareTransportImage({
          sourceBytes: preview.bytes,
          sourceMime: preview.mimeType,
          sourceSha256: sha256,
          purpose: "CompatibilityPreview",
          maxDataUrlBytes: singlePreviewBudget(),
          libraryRoot: context.snapshot.root,
        });
        if (!transport.ok) {
          throw new Error(`preview_unavailable: transport adaptation failed (${transport.reason})`);
        }
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
              data: Buffer.from(transport.transportBytes).toString("base64"),
              mimeType: transport.transportMime,
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
      const catalogRevision = await registry.catalogRevision(
        resultSet.providerIds,
        createProviderContext(context, index, {
          ...(moduleCatalogs ? { moduleCatalogs } : {}),
        }),
      );
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
        registry,
        moduleCatalogs,
      });
      const transport = await prepareTransportImage({
        sourceBytes: preview.bytes,
        sourceMime: preview.mimeType,
        sourceSha256: preview.sha256,
        purpose: "ExactPreview",
        maxDataUrlBytes: singlePreviewBudget(),
        libraryRoot: context.snapshot.root,
      });
      if (!transport.ok) {
        throw new Error(`preview_unavailable: transport adaptation failed (${transport.reason})`);
      }
      const previewChallenge = previewConfirmations.issueChallenge({
        resultSetId: options.resultSetId,
        providerId: options.providerId,
        exactSelector: options.exactSelector,
        exactSelectorDigest: preview.exactSelectorDigest,
        previewSha256: preview.sha256,
        catalogRevision,
        libraryBindingDigest: bindingDigest,
        transportRenditionSha256: transport.transportSha256,
        encoderPolicyVersion: "transport-image-v1",
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
                  previewDataUrl: transport.dataUrl,
                  previewChallenge,
                },
              },
            }
          : {
              content: [
                text,
                {
                  type: "image",
                  data: Buffer.from(transport.transportBytes).toString("base64"),
                  mimeType: transport.transportMime,
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
        "Return complete text and structured status for the global portable Library, immutable lifecycle, write lock, and every registered Local, Community, FigureYa, or personal Provider. Community is reported as frozen and excluded from default search. Capture/project-pin status is intentionally absent.",
      inputSchema: SourceStatusInput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ sourcePackDir, moduleSourcePackDir }): Promise<CallToolResult> => {
      try {
        const context = await currentLibraries();
        const workspace = await workspaceRuntime.current();
        const [library, marker, legacyFlat, providerStatuses, writeLock] = await Promise.all([
          context.versionedLibrary.status(),
          readLibraryRootMarker(context.snapshot.root),
          countLegacyFlat(context.snapshot.root),
          registry.status(
            createProviderContext(context, index, {
              ...(moduleCatalogs ? { moduleCatalogs } : {}),
              ...(sourcePackDir ? { sourcePackDir } : {}),
              ...(moduleSourcePackDir ? { moduleSourcePackDir } : {}),
            }),
          ),
          inspectLibraryWriteLock(path.join(context.snapshot.root, "locks", "write")),
        ]);
        const providerStatusById = Object.fromEntries(
          providerStatuses.map((status) => [status.providerId, status]),
        );
        const localStatus = registry.list().find((item) => item.kind === "local-published");
        const figureYaStatus = registry.list().find((item) => item.kind === "figureya");
        if (!localStatus || !figureYaStatus) {
          throw new Error("default provider registry is missing Local Published or FigureYa");
        }
        const localProvider = providerStatusById[localStatus.providerId];
        const figureYaProvider = providerStatusById[figureYaStatus.providerId];
        const figureYa = figureYaProvider?.details.sourcePack as {
          configured: boolean;
          directory: string;
          manifestValid: boolean;
          ready: boolean;
          availableTemplates: string[];
          invalidTemplates: string[];
        };
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
            local: localProvider?.details,
            figureYa: figureYaProvider?.details,
            personalModules: providerStatusById[PERSONAL_MODULE_PROVIDER_ID]
              ? {
                  health: providerStatusById[PERSONAL_MODULE_PROVIDER_ID]!.health,
                  ...providerStatusById[PERSONAL_MODULE_PROVIDER_ID]!.details,
                }
              : undefined,
            community: providerStatusById[COMMUNITY_PROVIDER_ID]
              ? {
                  health: providerStatusById[COMMUNITY_PROVIDER_ID]!.health,
                  ...providerStatusById[COMMUNITY_PROVIDER_ID]!.details,
                }
              : undefined,
            byId: providerStatusById,
          },
          writeLock,
          workspace: {
            root: workspace.directory ?? null,
            directorySource: workspace.directorySource,
            locatorPath: workspace.locatorPath,
            confirmed: workspace.confirmed,
            kind: workspace.inspection?.kind ?? (workspace.confirmed ? "unknown" : "unbound"),
            exists: workspace.inspection?.exists ?? false,
          },
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
            ...(providerStatusById[PERSONAL_MODULE_PROVIDER_ID]?.details
              ? [
                  `PERSONAL_MODULES_COUNT: ${providerStatusById[PERSONAL_MODULE_PROVIDER_ID]?.details.moduleCount ?? 0}`,
                  `PERSONAL_MODULES_PREVIEWS_AVAILABLE: ${providerStatusById[PERSONAL_MODULE_PROVIDER_ID]?.details.previewAvailableCount ?? 0}`,
                  `PERSONAL_MODULES_THUMBNAILS_AVAILABLE: ${providerStatusById[PERSONAL_MODULE_PROVIDER_ID]?.details.thumbnailAvailableCount ?? 0}`,
                  `PERSONAL_MODULES_ARCHIVES_AVAILABLE: ${providerStatusById[PERSONAL_MODULE_PROVIDER_ID]?.details.archiveAvailableCount ?? 0}`,
                  `PERSONAL_MODULES_SOURCE_COMMITS: ${JSON.stringify(providerStatusById[PERSONAL_MODULE_PROVIDER_ID]?.details.sourceCommits ?? [])}`,
                  `PERSONAL_MODULES_ARCHIVE_COMMITS: ${JSON.stringify(providerStatusById[PERSONAL_MODULE_PROVIDER_ID]?.details.archiveCommits ?? [])}`,
                  `PERSONAL_MODULES_DEFAULT_SEARCH: ${providerStatusById[PERSONAL_MODULE_PROVIDER_ID]?.details.includeInDefaultSearch ?? true}`,
                  `PERSONAL_MODULES_SOURCE_PACK_HEALTH: ${providerStatusById[PERSONAL_MODULE_PROVIDER_ID]?.details.sourcePackHealth ?? "not_configured"}`,
                ]
              : []),
            ...(providerStatusById[COMMUNITY_PROVIDER_ID]?.details
              ? [
                  `COMMUNITY_DEFAULT_SEARCH: ${providerStatusById[COMMUNITY_PROVIDER_ID]?.details.includeInDefaultSearch ?? false}`,
                  `COMMUNITY_FROZEN: ${providerStatusById[COMMUNITY_PROVIDER_ID]?.details.frozen ?? false}`,
                ]
              : []),
            ...providerStatuses.flatMap((status, providerIndex) => [
              `PROVIDER_${providerIndex + 1}_ID: ${status.providerId}`,
              `PROVIDER_${providerIndex + 1}_HEALTH: ${status.health}`,
            ]),
            `MATERIALIZATION_PROTOCOL_VERSION: ${MATERIALIZATION_PROTOCOL_VERSION}`,
            `CAPTURE_TOOLS_REGISTERED: false`,
            `PROJECT_PIN_TOOLS_REGISTERED: false`,
            `DIAGNOSTICS_DEGRADED: ${diagnostics.degraded}`,
            `DIAGNOSTICS_MAX_FILE_BYTES: ${diagnostics.maxFileBytes}`,
            `DIAGNOSTICS_MAX_TOTAL_BYTES: ${diagnostics.maxTotalBytes}`,
            `WORKSPACE_ROOT: ${workspace.directory ?? "unbound"}`,
            `WORKSPACE_SOURCE: ${workspace.directorySource}`,
            `WORKSPACE_CONFIRMED: ${workspace.confirmed}`,
            `WORKSPACE_KIND: ${workspace.inspection?.kind ?? "unbound"}`,
            `WORKSPACE_LOCATOR_PATH: ${workspace.locatorPath}`,
          ],
        );
      } catch (error) {
        return failed("Source status failed", error);
      }
    },
  );

  registerLibraryBindingTools({ server, runtime, workspaceRuntime, currentLibraries });
  registerLifecycleTools({
    server,
    currentLibrary: async () => (await currentLibraries()).versionedLibrary,
  });
  registerMaterializationTools({
    server,
    index,
    registry,
    moduleCatalogs,
    currentLibraries,
    previewConfirmations,
    diagnostics,
  });
  registerBundleTools({ server, currentLibraries });
  registerGitHubPublicationTools({ server });
  registerOpenFigurePrTools({
    ...options.openFigurePr,
    server,
    currentLibraries,
    figureYa: async () => index,
    openFigure: async () => moduleCatalogs?.get(PERSONAL_MODULE_PROVIDER_ID),
    lookupSearchSession: (resultSetId) => {
      try { previewConfirmations.getResultSet(resultSetId); } catch { return undefined; }
      const state = searchSessions.get(resultSetId);
      if (!state) return undefined;
      return { queryDigest: state.queryDigest, providerIds: state.input.providerIds, presented: state.presented === true };
    },
    searchSimilar: async (request, matchKind) => {
      if (request.providerIds.includes(LOCAL_LIBRARY_PROVIDER_ID)) {
        throw new Error("Open Figure similar search cannot include Local Published");
      }
      const parsedInput: ParsedSearchInput = {
        query: request.query,
        plotFamily: request.plotFamily,
        language: request.language,
        providerIds: [...request.providerIds],
        limit: request.limit,
      };
      const searchRequest: SearchRequest = {
        query: request.query,
        plotFamily: request.plotFamily,
        language: request.language,
      };
      const context = await currentLibraries();
      const providerContext = createProviderContext(context, index, {
        ...(moduleCatalogs ? { moduleCatalogs } : {}),
      });
      const searched: TemplateCandidate[] = [];
      for (const providerId of parsedInput.providerIds) {
        searched.push(...await registry.get(providerId).search(providerContext, searchRequest));
      }
      const order = new Map(registry.list().map(({ providerId }, providerIndex) => [providerId, providerIndex]));
      const ranked = searched.sort((left, right) => {
        const score = right.retrievalScore - left.retrievalScore;
        if (score) return score;
        if (left.providerId !== right.providerId) {
          return (order.get(left.providerId) ?? Number.MAX_SAFE_INTEGER) -
            (order.get(right.providerId) ?? Number.MAX_SAFE_INTEGER);
        }
        return left.templateId.localeCompare(right.templateId);
      });
      const top = Math.max(ranked[0]?.retrievalScore ?? 1, 0.0001);
      const normalized = ranked.map((candidate) => ({
        ...candidate,
        retrievalScore: Math.round((candidate.retrievalScore / top) * 100),
      }));
      const candidates = normalized.slice(0, parsedInput.limit).map((candidate) => ({ ...candidate, matchKind: matchKind(candidate) }));
      const queryDigest = searchQueryDigest(parsedInput);
      const catalogRevision = await registry.catalogRevision(parsedInput.providerIds, providerContext);
      const bindingDigest = libraryBindingDigest(context);
      const resultSetId = previewConfirmations.registerResultSet({
        queryDigest, catalogRevision, libraryBindingDigest: bindingDigest, providerIds: parsedInput.providerIds,
        candidates: candidates.map((candidate) => ({ providerId: candidate.providerId, exactSelector: candidate.exactSelector })),
      });
      searchSessions.set(resultSetId, {
        input: parsedInput, request: searchRequest, candidates, queryDigest, catalogRevision, libraryBindingDigest: bindingDigest,
        providerMatches: Object.fromEntries(parsedInput.providerIds.map((id) => [id, candidates.filter((c) => c.providerId === id).length])),
        providerFailures: {}, candidateIds: new Set(candidates.map((candidate) => scopedCandidateId(resultSetId, candidate))),
        presented: false,
      });
      while (searchSessions.size > 128) searchSessions.delete(searchSessions.keys().next().value!);
      return { candidates, queryDigest, resultSetId };
    },
  });
  registerPublicationExportTools({ server, currentLibraries });
  registerProviderSourceTools({
    server,
    manager: providerSourceManager,
    builtInSources: async () => {
      const descriptors = registry
        .list()
        .filter((descriptor) =>
          ["local-published", "figureya", "module-catalog"].includes(descriptor.kind) || descriptor.bundled,
        );
      let statuses: Awaited<ReturnType<ProviderRegistry["status"]>> = [];
      try {
        statuses = await registry.status(await currentProviderContext());
      } catch {
        // A broken global locator must not turn this provider-registry listing
        // into a fallback Library binding. Built-in identities remain visible.
      }
      const byId = new Map(statuses.map((status) => [status.providerId, status]));
      return descriptors.map((descriptor) => {
        const status = byId.get(descriptor.providerId);
        const details = status?.details ?? {};
        const templateCount =
          typeof details.templateCount === "number"
            ? details.templateCount
            : typeof details.catalogTemplates === "number"
              ? details.catalogTemplates
              : undefined;
        return {
          sourceKind: descriptor.kind,
          providerId: descriptor.providerId,
          sourceLabel: descriptor.sourceLabel,
          enabled: descriptor.enabled !== false,
          includeInDefaultSearch: descriptor.includeInDefaultSearch !== false,
          bundled: descriptor.bundled,
          frozen: descriptor.frozen === true,
          health: status?.health ?? "degraded",
          ...(templateCount !== undefined ? { templateCount } : {}),
          ...(status ? { details: status.details } : { errorCode: "library_context_unavailable" }),
        };
      });
    },
    personalSourceStatuses: async () => {
      const descriptors = registry
        .list()
        .filter((descriptor) => descriptor.kind === "public-catalog" && !descriptor.bundled);
      return Promise.all(descriptors.map(async (descriptor) => {
        const adapter = registry.get(descriptor.providerId);
        if (
          !(adapter instanceof PublicCatalogProviderAdapter) &&
          !(adapter instanceof UnavailableProviderAdapter)
        ) {
          return {
            providerId: descriptor.providerId,
            health: "degraded" as const,
            errorCode: "provider_runtime_status_unavailable",
            safeMessage: "The configured Provider runtime does not expose an offline snapshot status.",
          };
        }
        // Both personal runtime adapter variants derive their status entirely
        // from the immutable snapshot loaded at startup/Apply. Neither reads
        // the global Library or performs a network request.
        return adapter.status(undefined as never);
      }));
    },
    onApplied: providerController?.refreshPersonalProviders,
  });

  return server;
}
