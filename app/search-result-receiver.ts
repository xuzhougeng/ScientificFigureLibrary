import { parseSearchResult, type Candidate, type SearchResult } from "./view.ts";

function record(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function envelope(value: unknown) {
  const result = record(value);
  if (!result || result.isError === true) return;
  return parseSearchResult(result.structuredContent, result._meta);
}

function samePage(left: SearchResult, right: SearchResult) {
  return left.resultSetId === right.resultSetId && left.query === right.query &&
    left.pagination.pageIndex === right.pagination.pageIndex &&
    left.candidates.length === right.candidates.length &&
    left.candidates.every((candidate, index) => {
      const other = right.candidates[index];
      return other?.candidateId === candidate.candidateId &&
        other.providerId === candidate.providerId && other.templateId === candidate.templateId;
    });
}

function hasPreview(candidate: Candidate) {
  return (candidate.searchPreviewStatus ?? candidate.previewStatus) === "ready" &&
    (typeof candidate.previewDataUrl === "string" && candidate.previewDataUrl.length > 0 ||
      typeof candidate.previewUrl === "string" && candidate.previewUrl.length > 0);
}

// Only thumbnail fields may be filled from a matching page. Never replace its
// metadata, exact selectors, candidate identities, or selection decisions.
function fillPreviews(primary: SearchResult, fallback?: SearchResult): SearchResult {
  if (!fallback || !samePage(primary, fallback)) return primary;
  let changed = false;
  const candidates = primary.candidates.map((candidate, index) => {
    const other = fallback.candidates[index];
    if (hasPreview(candidate) || !other || !hasPreview(other)) return candidate;
    changed = true;
    return {
      ...candidate,
      previewDataUrl: other.previewDataUrl,
      previewUrl: other.previewUrl,
      previewStatus: other.previewStatus,
      searchPreviewStatus: other.searchPreviewStatus,
      previewMimeType: other.previewMimeType,
      previewByteLength: other.previewByteLength,
      previewSha256: other.previewSha256,
    };
  });
  return changed ? { ...primary, candidates } : primary;
}

/** Standard MCP envelopes and documented Host compatibility objects only.
 * Strings (including JSON text), tool arguments and arbitrary wrappers are not
 * interpreted. Canonical metadata may enrich only the same scoped page.
 */
export function parseSearchToolResult(value: unknown, metadata?: unknown): SearchResult | undefined {
  if (record(value)?.isError === true) return;
  const meta = record(metadata);
  const canonical = envelope(meta?.mcp_tool_result) ?? envelope(meta?.call_tool_result) ?? envelope(meta);
  const source = record(value)?.structuredContent ?? value;
  const primary = envelope(value) ?? parseSearchResult(value);
  if (primary) {
    const privateMeta = meta?._meta ?? metadata;
    return fillPreviews(fillPreviews(primary, canonical), parseSearchResult(source, privateMeta));
  }
  // An explicit non-search/error output must not resurrect stale metadata.
  return value == null ? canonical : undefined;
}

function signature(result: SearchResult) {
  const text = (value: unknown) => typeof value === "string" ? value : undefined;
  return JSON.stringify([
    result.resultSetId, result.pagination,
    result.candidates.map(candidate => [
      candidate.candidateId, candidate.providerId, candidate.templateId,
      text(candidate.searchPreviewStatus), text(candidate.previewStatus),
      text(candidate.previewDataUrl), text(candidate.previewUrl),
    ]),
  ]);
}

export function createSearchResultReceiver(options: {
  current: () => SearchResult | undefined;
  render: (result: SearchResult) => void;
}) {
  let lastToolResult: SearchResult | undefined;
  let lastSignature: string | undefined;
  const deliver = (result: SearchResult) => {
    const nextSignature = signature(result);
    if (nextSignature !== lastSignature) {
      lastSignature = nextSignature;
      lastToolResult = result;
      options.render(result);
    }
    return result;
  };
  return {
    notification(value: unknown) {
      const parsed = parseSearchToolResult(value);
      if (!parsed) return;
      // A later notification without private metadata must not erase an image
      // already hydrated from the same immutable result page.
      return deliver(fillPreviews(fillPreviews(parsed, options.current()), lastToolResult));
    },
    legacy(globals: unknown) {
      const host = record(globals);
      if (!host) return;
      const parsed = parseSearchToolResult(host.toolOutput, host.toolResponseMetadata);
      if (!parsed) return;
      const current = options.current();
      if (!current) return deliver(parsed);
      // Compatibility globals are initial state, not navigation commands. Late
      // globals may fill missing images, but cannot rewind a page/new search or
      // rerender an unchanged view and close its detail/selection UI.
      const enriched = fillPreviews(current, parsed);
      return enriched !== current ? deliver(enriched) : undefined;
    },
  };
}
