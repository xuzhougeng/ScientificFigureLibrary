import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { scopedCandidateId } from "./candidate-images.ts";
import { markdownPlainText } from "./figure-description.ts";
import { PLOT_FAMILY_GROUP_IDS, plotFamilyGroup, type PlotFamilyGroup } from "./plot-family-groups.ts";
import type { OperationRegistry } from "./service/operations.ts";
import { outcome, terminal } from "./tool-outcome.ts";
import type { TemplateCandidate } from "./types.ts";

export const CATALOG_LISTING_DEFAULT_LIMIT = 50;
export const CATALOG_LISTING_MAX_LIMIT = 100;
const SUMMARY_CHARS = { full: 100, compact: 60 } as const;
const MAX_FACET_VALUES = 60;

export const CatalogListingInput = z.object({
  resultSetId: z.string().min(1).max(256).optional().describe("Continue a listing returned by this tool; omit filters when continuing."),
  offset: z.number().int().min(0).optional().describe("Entry offset inside resultSetId; use the returned nextOffset."),
  providerIds: z.array(z.string().min(1).max(200)).min(1).max(16).optional(),
  plotFamily: z.string().min(1).max(200).optional().describe("Provider-specific family text; prefer familyGroup, which also covers entries without a family."),
  familyGroup: z.enum(PLOT_FAMILY_GROUP_IDS).optional().describe("Canonical figure-type group from the familyGroup facet."),
  templates: z.array(z.object({ providerId: z.string().min(1).max(200), templateId: z.string().min(1).max(300) }).strict()).min(1).max(12).optional()
    .describe("Re-list only these entries (from an earlier listing) to get fresh candidateIds without reading the whole catalog again."),
  language: z.string().min(1).max(100).optional(),
  assetKind: z.enum(["plot_template", "visual_reference"]).optional(),
  limit: z.number().int().min(0).max(CATALOG_LISTING_MAX_LIMIT).optional().default(CATALOG_LISTING_DEFAULT_LIMIT)
    .describe("Entries per page; 0 returns only Provider counts and facets."),
  detail: z.enum(["compact", "full"]).optional().default("compact")
    .describe("compact: candidateId, titles, plotFamily and a 60-character summary per line; full adds language, Provider and thumbnail columns with 100 characters."),
});
export type CatalogListingDetail = "compact" | "full";
export type CatalogListingRequest = z.infer<typeof CatalogListingInput>;

export interface CatalogListingSource {
  providerId: string;
  sourceLabel: string;
  matched: number;
  health: string;
  errorCode?: string;
  safeMessage?: string;
}

export interface CatalogListingSet {
  resultSetId: string;
  /** Changes whenever any listed Provider catalog or the Library binding changes. */
  catalogRevision: string;
  candidates: TemplateCandidate[];
  sources: CatalogListingSource[];
}

type Facet = Array<{ value: string; count: number }>;

interface ListedEntry {
  candidateId: string;
  providerId: string;
  templateId: string;
  title: string;
  titleEn?: string;
  familyGroup: PlotFamilyGroup;
  plotFamily: string;
  language: string;
  assetKind: TemplateCandidate["assetKind"];
  thumbnailAvailable: boolean;
  summary: string;
}

function facet(candidates: TemplateCandidate[], pick: (candidate: TemplateCandidate) => string): Facet {
  const counts = new Map<string, number>();
  for (const candidate of candidates) {
    const value = pick(candidate);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((left, right) => right.count - left.count || left.value.localeCompare(right.value))
    .slice(0, MAX_FACET_VALUES);
}

function oneLine(value: string) {
  return value.replace(/[\r\n\t|]+/gu, " ").replace(/\s+/gu, " ").trim();
}

export function catalogEntrySummary(candidate: TemplateCandidate, detail: CatalogListingDetail = "full") {
  const text = oneLine(markdownPlainText(candidate.description || candidate.excerpt || ""));
  const max = SUMMARY_CHARS[detail];
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function buildCatalogListing(set: CatalogListingSet, offset: number, limit: number, detail: CatalogListingDetail = "full") {
  const total = set.candidates.length;
  const page = set.candidates.slice(offset, offset + limit);
  const nextOffset = offset + page.length < total ? offset + page.length : null;
  const entries: ListedEntry[] = page.map((candidate) => ({
    candidateId: scopedCandidateId(set.resultSetId, candidate),
    providerId: candidate.providerId,
    templateId: candidate.templateId,
    title: oneLine(candidate.title),
    ...(candidate.titleEn ? { titleEn: oneLine(candidate.titleEn) } : {}),
    familyGroup: plotFamilyGroup(candidate),
    plotFamily: candidate.plotFamily || "unclassified",
    language: candidate.language || "unknown",
    assetKind: candidate.assetKind,
    thumbnailAvailable: candidate.searchPreviewAvailable ?? candidate.previewAvailable,
    summary: catalogEntrySummary(candidate, detail),
  }));
  const facets = {
    providerId: facet(set.candidates, (candidate) => candidate.providerId),
    familyGroup: facet(set.candidates, (candidate) => plotFamilyGroup(candidate)),
    plotFamily: facet(set.candidates, (candidate) => candidate.plotFamily || "unclassified"),
    language: facet(set.candidates, (candidate) => candidate.language || "unknown"),
    assetKind: facet(set.candidates, (candidate) => candidate.assetKind),
  };
  const facetLine = (name: string, values: Facet) =>
    `FACET ${name}: ${values.map(({ value, count }) => `${value}=${count}`).join(", ") || "(none)"}`;
  const lines = [
    `RESULT_SET_ID: ${set.resultSetId}`,
    `CATALOG_REVISION: ${set.catalogRevision}`,
    `PAGINATION: ${JSON.stringify({ total, offset, returned: entries.length, nextOffset })}`,
    ...set.sources.map((source) =>
      `SOURCE ${source.providerId} (${source.sourceLabel}): ${source.matched} entries; health=${source.health}${source.errorCode ? `; ${source.errorCode}` : ""}`),
    facetLine("familyGroup", facets.familyGroup),
    facetLine("plotFamily", facets.plotFamily),
    facetLine("language", facets.language),
    facetLine("assetKind", facets.assetKind),
    ...entryLines(entries, detail),
    !total
      ? "No catalog entries matched these Provider filters. Report the empty filters; do not claim the whole library lacks the figure type unless the default Providers were listed without filters."
      : !entries.length
        ? "Facets only. Narrow with familyGroup, providerIds, language or assetKind when they clearly match the user's need (other/unclassified hold analysis-only and unlabelled templates), then continue with this resultSetId and offset to read entries."
        : "Choose relevant entries by meaning, not by exact wording. Show them with figure_library_get_candidate_images (same resultSetId, at most 12 candidateIds), then wait for user selection. An absent keyword hit is not evidence that the library lacks a figure type. Keep these entries for later requests in this session; re-read the catalog only when a limit:0 call reports a different catalogRevision.",
  ];
  return {
    structured: {
      resultSetId: set.resultSetId,
      catalogRevision: set.catalogRevision,
      total,
      offset,
      limit,
      nextOffset,
      sources: set.sources,
      facets,
      entries,
    },
    lines,
  };
}

function entryLines(entries: ListedEntry[], detail: CatalogListingDetail) {
  if (!entries.length) return [];
  if (detail === "full") {
    return [
      "ENTRIES: candidateId | title | titleEn | familyGroup | plotFamily | language | providerId | thumbnail | summary",
      ...entries.map((entry) =>
        [entry.candidateId, entry.title, entry.titleEn ?? "-", entry.familyGroup, entry.plotFamily, entry.language, entry.providerId, entry.thumbnailAvailable ? "thumbnail" : "no-thumbnail", entry.summary].join(" | ")),
    ];
  }
  // Compact lines group by Provider and only flag the rare entry without a thumbnail.
  const lines = ["ENTRIES: candidateId | title | titleEn | familyGroup/plotFamily | summary"];
  let provider = "";
  for (const entry of entries) {
    if (entry.providerId !== provider) lines.push(`PROVIDER ${(provider = entry.providerId)}`);
    const family = entry.plotFamily === entry.familyGroup || entry.plotFamily === "unclassified" ? entry.familyGroup : `${entry.familyGroup}/${entry.plotFamily}`;
    lines.push([entry.candidateId, entry.title, entry.titleEn ?? "-", family, entry.summary].join(" | ") + (entry.thumbnailAvailable ? "" : " [no-thumbnail]"));
  }
  return lines;
}

export function defineCatalogListing(operations: OperationRegistry, options: {
  /** Create a fresh browse result set for the requested Provider filters. */
  list: (input: CatalogListingRequest) => Promise<CatalogListingSet>;
  /** Re-validate an existing listing result set before another page is read. */
  continueListing: (resultSetId: string) => Promise<CatalogListingSet>;
  failure: (prefix: string, error: unknown) => CallToolResult;
}) {
  operations.define(
    "figure_library_list_catalog",
    {
      title: "List the scientific figure catalog for semantic selection",
      description:
        "Return a compact, paginated catalog of the default (or selected) Providers: per-Provider counts, plotFamily/language facets and one line per template. Use it before concluding that a figure type is missing, or when keyword search returns nothing; match entries by meaning, then display chosen candidateIds with figure_library_get_candidate_images. Read-only; no images, previews or receipts.",
      inputSchema: CatalogListingInput.shape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (input): Promise<CallToolResult> => {
      const invalid = (message: string) =>
        terminal(outcome("failed", "catalog_listing_invalid_input", `Catalog listing failed: ${message}`));
      const offset = input.offset ?? 0;
      if (input.resultSetId && (input.providerIds || input.plotFamily || input.familyGroup || input.templates || input.language || input.assetKind)) {
        return invalid("filters cannot change while continuing a listing; start a new listing without resultSetId.");
      }
      if (!input.resultSetId && offset !== 0) {
        return invalid("offset requires the resultSetId returned by an earlier catalog listing.");
      }
      try {
        const set = input.resultSetId
          ? await options.continueListing(input.resultSetId)
          : await options.list(input);
        if (offset > set.candidates.length) {
          return invalid(`offset ${offset} is beyond the ${set.candidates.length} entries of this listing.`);
        }
        const listing = buildCatalogListing(set, offset, input.limit, input.detail);
        return terminal(
          outcome(
            "ok",
            listing.structured.total ? "catalog_listing_ready" : "catalog_listing_empty",
            listing.structured.total
              ? listing.structured.entries.length
                ? `Catalog listing returned entries ${offset + 1}-${offset + listing.structured.entries.length} of ${listing.structured.total}.`
                : `Catalog facets for ${listing.structured.total} entries; no entries were requested.`
              : "The selected Providers returned no catalog entries.",
            listing.structured.total ? "ask_user" : "none",
          ),
          listing.structured,
          listing.lines,
        );
      } catch (error) {
        return options.failure("Catalog listing failed", error);
      }
    },
  );
}
