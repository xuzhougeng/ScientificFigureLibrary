import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import {
  mountExactPreviewImage,
  openCandidateDetail,
  parseSearchResult,
  renderCandidateCards,
  type Candidate,
  type SearchResult,
} from "../app/view.ts";

function candidate(
  providerId: string,
  templateId: string,
  previewStatus: Candidate["previewStatus"],
  previewDataUrl?: string,
): Candidate {
  return {
    candidateId: `candidate-${templateId}`,
    templateId,
    providerId,
    exactSelector: {
      schema: "figure-library.provider-selector.v1",
      providerId,
      kind:
        providerId === "org.scientificfigurelibrary.local"
          ? "local-published.v1"
          : "figureya-module.v1",
      identity: { templateId },
    },
    sourceLabel:
      providerId === "org.scientificfigurelibrary.local" ? "Local Published" : "FigureYa",
    title: `${templateId} title`,
    retrievalScore: 100,
    reasons: ["bar chart match", "group comparison"],
    warnings: ["not executed"],
    excerpt: "short excerpt",
    description:
      "A complete candidate description that must remain visible in the detail dialog without line clamping.",
    application: "Grouped bar-chart comparisons",
    dataProfile: "One category and one numeric value",
    inputFiles: ["data.csv"],
    codeFiles: ["plot.R"],
    packages: ["ggplot2"],
    materializable: true,
    previewAvailable: previewStatus === "ready",
    previewStatus,
    ...(previewDataUrl
      ? {
          previewDataUrl,
          previewMimeType: "image/png" as const,
          previewByteLength: 68,
          previewSha256: "a".repeat(64),
        }
      : {}),
    assetKind: "plot_template",
    language: "R",
    plotFamily: "bar",
    reviewStatus: providerId.includes("local") ? "approved" : "not_reviewed",
    codeStatus: "provided",
    executionStatus: "not_run",
    management: {
      templateId,
      canArchive: false,
      canUpdate: false,
    },
  };
}

function searchResult(candidates: Candidate[]): SearchResult {
  return {
    query: "柱状图 bar chart",
    libraryVersion: "0.5.1",
    materializationProtocolVersion: 2,
    intentFamilies: ["bar"],
    reviewRequired: true,
    resultSetId: "result-set",
    correlationId: "search-correlation",
    pagination: {
      total: candidates.length,
      pageIndex: 1,
      pageSize: 6,
      hasMore: false,
      nextCursor: null,
    },
    candidates,
  };
}

test("search result hydrates App thumbnails from component-only metadata", () => {
  const rawCandidate = candidate(
    "org.figureya.module",
    "figureya-bar",
    "ready",
    undefined,
  );
  const structured = searchResult([rawCandidate]);
  const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
  assert.doesNotMatch(JSON.stringify(structured), /data:image\//u);
  const parsed = parseSearchResult(structured, {
    candidatePreviews: {
      [rawCandidate.candidateId]: {
        previewDataUrl: dataUrl,
        previewMimeType: "image/png",
        previewByteLength: 68,
        previewSha256: "a".repeat(64),
      },
    },
  });
  assert.equal(parsed?.candidates[0]?.previewDataUrl, dataUrl);
});

test("thumbnail, title, and explicit action open candidate details without exact preview", () => {
  const window = new Window();
  const document = window.document as unknown as Document;
  const cards = document.createElement("section");
  const empty = document.createElement("section");
  const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
  const result = searchResult([
    candidate("org.scientificfigurelibrary.local", "local-bar", "ready", dataUrl),
    candidate("org.figureya.module", "figureya-bar", "ready", dataUrl),
  ]);
  const opened: Array<{ templateId: string; openerClass: string }> = [];
  renderCandidateCards({
    document,
    cards,
    empty,
    result,
    onDetail(value, _elements, opener) {
      opened.push({ templateId: value.templateId, openerClass: opener.className });
    },
  });

  const images = Array.from(cards.querySelectorAll("img"));
  assert.equal(images.length, 2);
  assert.ok(images.every((image) => image.src === dataUrl));
  assert.ok(images.every((image) => image.loading === "lazy"));
  assert.deepEqual(
    Array.from(cards.querySelectorAll(".source")).map((node) => node.textContent),
    ["Local Published", "FigureYa"],
  );
  (cards.querySelectorAll(".preview-button")[0] as HTMLButtonElement).click();
  (cards.querySelectorAll(".candidate-title")[1] as HTMLButtonElement).click();
  (cards.querySelectorAll(".candidate-action")[1] as HTMLButtonElement).click();
  assert.deepEqual(opened, [
    { templateId: "local-bar", openerClass: "preview preview-button" },
    { templateId: "figureya-bar", openerClass: "candidate-title" },
    { templateId: "figureya-bar", openerClass: "candidate-action" },
  ]);
  assert.equal(empty.hidden, true);
});

test("basic detail remains available without serverTools and exposes complete metadata", async () => {
  const window = new Window();
  const document = window.document as unknown as Document;
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  const selected = candidate(
    "org.scientificfigurelibrary.local",
    "local-detail",
    "ready",
    "data:image/png;base64,iVBORw0KGgo=",
  );
  let exactCalls = 0;
  let closed = 0;
  const detail = openCandidateDetail({
    document,
    candidate: selected,
    opener,
    serverToolsAvailable: false,
    onClosed() {
      closed += 1;
    },
    onRequestExactPreview() {
      exactCalls += 1;
    },
  });
  await Promise.resolve();

  assert.equal(detail.dialog.open, true);
  assert.equal(detail.dialog.querySelector(".detail-description")?.textContent, selected.description);
  assert.match(detail.dialog.textContent ?? "", /Grouped bar-chart comparisons/u);
  assert.match(detail.dialog.textContent ?? "", /One category and one numeric value/u);
  assert.match(detail.dialog.textContent ?? "", /bar chart match/u);
  assert.match(detail.dialog.textContent ?? "", /not executed/u);
  assert.equal(detail.exactPreviewButton.disabled, true);
  assert.equal(detail.confirmButton.disabled, true);
  detail.exactPreviewButton.click();
  assert.equal(exactCalls, 0);

  detail.dialog.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "Escape" }) as unknown as Event,
  );
  assert.equal(closed, 1);
  assert.equal(document.activeElement, opener);
});

test("unavailable previews still open details but keep exact preview and confirmation disabled", () => {
  const window = new Window();
  const document = window.document as unknown as Document;
  const cards = document.createElement("section");
  const empty = document.createElement("section");
  const statuses: Candidate["previewStatus"][] = [
    "missing",
    "unreadable",
    "unsupported",
    "too_large",
  ];
  const opened: Candidate[] = [];
  renderCandidateCards({
    document,
    cards,
    empty,
    result: searchResult(
      statuses.map((status, index) =>
        candidate("org.scientificfigurelibrary.local", `blocked-${index}`, status),
      ),
    ),
    onDetail(value) {
      opened.push(value);
    },
  });
  assert.equal(cards.querySelectorAll("img").length, 0);
  assert.ok(
    Array.from(cards.querySelectorAll(".candidate-action")).every(
      (button) => !(button as HTMLButtonElement).disabled,
    ),
  );
  (cards.querySelector(".candidate-action") as HTMLButtonElement).click();
  assert.equal(opened.length, 1);

  const opener = document.createElement("button");
  document.body.append(opener);
  const detail = openCandidateDetail({
    document,
    candidate: opened[0]!,
    opener,
    serverToolsAvailable: true,
    onRequestExactPreview() {
      assert.fail("unavailable preview must not call exact preview");
    },
  });
  assert.equal(detail.exactPreviewButton.disabled, true);
  assert.equal(detail.confirmButton.disabled, true);
  detail.closeButton.click();
});

test("opening a usable detail does not request exact preview until the user clicks", () => {
  const window = new Window();
  const document = window.document as unknown as Document;
  const opener = document.createElement("button");
  document.body.append(opener);
  let exactCalls = 0;
  const detail = openCandidateDetail({
    document,
    candidate: candidate(
      "org.scientificfigurelibrary.local",
      "manual-exact",
      "ready",
      "data:image/png;base64,iVBORw0KGgo=",
    ),
    opener,
    serverToolsAvailable: true,
    onRequestExactPreview() {
      exactCalls += 1;
    },
  });
  assert.equal(exactCalls, 0);
  assert.equal(detail.confirmButton.disabled, true);
  detail.exactPreviewButton.click();
  assert.equal(exactCalls, 1);
  assert.equal(detail.confirmButton.disabled, true);
  detail.closeButton.click();
});

test("exact preview load enables confirmation while image error keeps it disabled", () => {
  const window = new Window();
  const document = window.document as unknown as Document;
  const selected = candidate(
    "org.scientificfigurelibrary.local",
    "load-gated",
    "ready",
    "data:image/png;base64,iVBORw0KGgo=",
  );
  const createDetail = () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    return openCandidateDetail({
      document,
      candidate: selected,
      opener,
      serverToolsAvailable: true,
      onRequestExactPreview() {},
    });
  };

  const loadedDetail = createDetail();
  let loads = 0;
  const loadedImage = mountExactPreviewImage({
    document,
    elements: loadedDetail,
    dataUrl: "data:image/png;base64,exact-load",
    alt: "exact load",
    onLoaded() {
      loads += 1;
    },
    onError() {
      assert.fail("load scenario must not call error callback");
    },
  });
  assert.equal(loadedDetail.confirmButton.disabled, true);
  loadedImage.dispatchEvent(new window.Event("load") as unknown as Event);
  assert.equal(loads, 1);
  assert.equal(loadedDetail.confirmButton.disabled, false);
  loadedDetail.closeButton.click();

  const failedDetail = createDetail();
  let errors = 0;
  const failedImage = mountExactPreviewImage({
    document,
    elements: failedDetail,
    dataUrl: "data:image/png;base64,exact-error",
    alt: "exact error",
    onLoaded() {
      assert.fail("error scenario must not call load callback");
    },
    onError() {
      errors += 1;
    },
  });
  failedImage.dispatchEvent(new window.Event("error") as unknown as Event);
  assert.equal(errors, 1);
  assert.equal(failedDetail.confirmButton.disabled, true);
  failedDetail.closeButton.click();
});
