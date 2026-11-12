import { candidateDomains, DOMAINS, isDomainId, type DomainId } from "../../src/domains.ts";
import { isPlotFamilyGroup, PLOT_FAMILY_GROUPS, plotFamilyGroups, type PlotFamilyGroup } from "../../src/plot-family-groups.ts";
import type { Candidate, SearchResult } from "../view.ts";

/** The figure-type and research-domain filters currently applied to the gallery. */
export interface FacetFilter {
  familyGroup?: PlotFamilyGroup;
  domain?: DomainId;
}

type FacetAxis = keyof FacetFilter;

const GROUP_LABEL = new Map<string, string>(PLOT_FAMILY_GROUPS.map((group) => [group.id, group.label]));
const DOMAIN_LABEL = new Map<string, string>(DOMAINS.map((domain) => [domain.id, domain.label]));
/** Catch-all groups are listed last: they say what an entry is not. */
const TRAILING = new Set(["other", "unclassified", "general"]);

export function facetLabel(axis: FacetAxis, value: string) {
  return (axis === "domain" ? DOMAIN_LABEL : GROUP_LABEL).get(value) ?? value;
}

/** Filters the server reports as applied; unknown values are ignored. */
export function appliedFilter(result: SearchResult): FacetFilter {
  const familyGroup = result.filters?.familyGroup;
  const domain = result.filters?.domain;
  return {
    ...(isPlotFamilyGroup(familyGroup) ? { familyGroup } : {}),
    ...(isDomainId(domain) ? { domain } : {}),
  };
}

function ordered(counts: Array<{ value: string; count: number }>) {
  return [...counts].sort((left, right) =>
    Number(TRAILING.has(left.value)) - Number(TRAILING.has(right.value)) || right.count - left.count || left.value.localeCompare(right.value));
}

function chip(document: Document, label: string, count: number | undefined, pressed: boolean, onClick: () => void) {
  const control = document.createElement("button");
  control.type = "button";
  control.className = "facet-chip";
  control.setAttribute("aria-pressed", String(pressed));
  control.append(label);
  if (count !== undefined) {
    const total = document.createElement("span");
    total.className = "facet-count";
    total.textContent = String(count);
    control.append(total);
  }
  control.addEventListener("click", onClick);
  return control;
}

/**
 * Render the facet rows above the gallery. Counts describe the matches before
 * the figure-type and domain filters, so a row keeps its choices while one of
 * them is selected. A row with nothing to offer is omitted.
 */
export function renderFacets(options: {
  document: Document;
  container: HTMLElement;
  result: SearchResult;
  onChange: (filter: FacetFilter) => void;
}) {
  const { document, container, result } = options;
  const active = appliedFilter(result);
  const groups = ordered((result.facets?.familyGroup ?? []).filter((item) => isPlotFamilyGroup(item.value)));
  const themeIds = new Set<string>(PLOT_FAMILY_GROUPS.filter((group) => group.kind === "theme").map((group) => group.id));
  const rows: Array<{ title: string; axis: FacetAxis; values: Array<{ value: string; count: number }> }> = [
    { title: "研究领域", axis: "domain", values: ordered((result.facets?.domain ?? []).filter((item) => isDomainId(item.value))) },
    { title: "图型", axis: "familyGroup", values: groups.filter((item) => !themeIds.has(item.value)) },
    { title: "分析主题", axis: "familyGroup", values: groups.filter((item) => themeIds.has(item.value)) },
  ];
  container.replaceChildren();
  for (const row of rows) {
    if (!row.values.length) continue;
    const line = document.createElement("div");
    line.className = "facet-row";
    line.setAttribute("role", "group");
    line.setAttribute("aria-label", row.title);
    const title = document.createElement("span");
    title.className = "facet-title";
    title.textContent = row.title;
    line.append(title);
    const selected = active[row.axis];
    const inRow = selected !== undefined && row.values.some((item) => item.value === selected);
    // "全部" clears the axis; figure types and themes share one axis, so only the row holding the selection shows it as off.
    line.append(chip(document, "全部", undefined, !inRow && (row.axis === "domain" || selected === undefined), () => {
      const next = { ...active };
      delete next[row.axis];
      options.onChange(next);
    }));
    for (const item of row.values) {
      line.append(chip(document, facetLabel(row.axis, item.value), item.count, item.value === selected, () => {
        const next: FacetFilter = { ...active };
        if (item.value === selected) delete next[row.axis];
        else if (row.axis === "domain") next.domain = item.value as DomainId;
        else next.familyGroup = item.value as PlotFamilyGroup;
        options.onChange(next);
      }));
    }
    container.append(line);
  }
  container.hidden = container.childElementCount === 0;
}

/** Clickable figure-type and domain tags for one card; clicking one filters the gallery by it. */
export function cardFacetChips(options: {
  document: Document;
  candidate: Candidate;
  onPick: (filter: FacetFilter) => void;
}) {
  const { document, candidate } = options;
  const container = document.createElement("div");
  container.className = "card-facets";
  const add = (axis: FacetAxis, value: string) => {
    const control = document.createElement("button");
    control.type = "button";
    control.className = `card-facet card-facet-${axis === "domain" ? "domain" : "group"}`;
    control.textContent = facetLabel(axis, value);
    control.title = `只看「${facetLabel(axis, value)}」`;
    control.addEventListener("click", (event) => {
      event.stopPropagation();
      options.onPick(axis === "domain" ? { domain: value as DomainId } : { familyGroup: value as PlotFamilyGroup });
    });
    container.append(control);
  };
  for (const domain of candidateDomains(candidate).filter((value) => value !== "general").slice(0, 2)) add("domain", domain);
  for (const group of plotFamilyGroups(candidate).filter((value) => value !== "unclassified" && value !== "other").slice(0, 3)) add("familyGroup", group);
  if (candidate.templateKind === "analysis") {
    const note = document.createElement("span");
    note.className = "card-facet card-facet-note";
    note.textContent = "分析流程";
    note.title = "这个模块只做数据处理或计算，不出图";
    container.append(note);
  }
  return container;
}
