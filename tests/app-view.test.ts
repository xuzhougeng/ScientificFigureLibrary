import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { Window } from "happy-dom";
import {
  buildHeadlessReviewHandoff,
  buildPlotSetHandoff,
  updateModelContextForHeadlessReview,
} from "../app/handoff.ts";
import {
  mountExactPreviewImage,
  openCandidateDetail,
  parseSearchResult,
  renderCandidateCards,
  type Candidate,
  type SearchResult,
} from "../app/view.ts";
import { VERSION } from "../src/version.ts";
import { createIcon, setButtonContent } from "../app/icons.ts";

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
    validationState: {
      schema: "figure-library.validation-state.v1",
      plotExecution: { status: "not_run", scope: "unknown" },
      upstreamWorkflow: { status: "not_run" },
      scientificValidation: { status: "not_assessed" },
    },
    canonicalPreviewDecision: {
      assetPath: "visuals/source/preview.png",
      reason: "default_uploaded_source",
      selectedBy: "policy",
    },
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
    libraryVersion: VERSION,
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

test("UI icons use accessible inline SVG and preserve visible button labels", () => {
  const window = new Window();
  const document = window.document as unknown as Document;
  const icon = createIcon(document, "details");
  assert.equal(icon.getAttribute("viewBox"), "0 0 24 24");
  assert.equal(icon.getAttribute("aria-hidden"), "true");
  assert.equal(icon.getAttribute("focusable"), "false");
  assert.equal(icon.querySelector("script"), null);
  assert.equal(icon.querySelector("image"), null);

  const primary = document.createElement("button");
  setButtonContent(primary, "send", "确认并交给 Agent");
  assert.equal(primary.textContent, "确认并交给 Agent");
  assert.ok(primary.querySelector("svg.sfl-icon"));
  assert.equal(primary.querySelector(".button-label")?.textContent, "确认并交给 Agent");

  const compact = document.createElement("button");
  setButtonContent(compact, "close", "关闭详情", { iconOnly: true });
  assert.equal(compact.getAttribute("aria-label"), "关闭详情");
  assert.equal(compact.title, "关闭详情");
  assert.equal(compact.querySelector(".visually-hidden")?.textContent, "关闭详情");
});

test("App shell includes the shared brand, responsive UI, dark mode, and reduced motion", () => {
  const root = path.resolve(import.meta.dirname, "..");
  const html = fs.readFileSync(path.join(root, "app", "mcp-app.html"), "utf8");
  const source = fs.readFileSync(path.join(root, "app", "main.ts"), "utf8");
  const styles = fs.readFileSync(path.join(root, "app", "styles.css"), "utf8");
  assert.match(html, /id="brand-logo"/u);
  assert.match(source, /SFL_BRAND_ICON_DATA_URI/u);
  assert.match(styles, /prefers-reduced-motion/u);
  assert.match(styles, /html\[data-theme="dark"\]/u);
  assert.match(styles, /@media \(max-width: 420px\)/u);
  assert.doesNotMatch(`${html}\n${source}\n${styles}`, /unpkg|jsdelivr|cdnjs/u);
});

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

test("personal module cards keep publisher state, Local state, and thumbnail status separate", () => {
  const window = new Window();
  const document = window.document as unknown as Document;
  const cards = document.createElement("section");
  const empty = document.createElement("section");
  const personal = candidate(
    "io.github.jarxunlai.personal-figures",
    "personal-module-fixture",
    "ready",
    "data:image/png;base64,fixture",
  );
  personal.searchPreviewAvailable = true;
  personal.searchPreviewStatus = "ready";
  personal.previewStatus = undefined;
  personal.sourceLabel = "Open Figure Modules";
  personal.upstreamStatus = "published";
  personal.publisherReviewStatus = "approved";
  personal.publisherExecutionStatus = "passed";
  personal.publisherExecutionScope = "synthetic_data";
  personal.codeExecutedBySflClient = false;
  personal.exactSelector = {
    ...personal.exactSelector,
    kind: "module-archive.v1",
    identity: {
      moduleId: personal.templateId,
      sourceCommit: "a".repeat(40),
      archiveCommit: "b".repeat(40),
      archive: { digest: "c".repeat(64) },
      mode: "template",
    },
  };
  renderCandidateCards({
    document,
    cards,
    empty,
    result: searchResult([personal]),
    onDetail() {},
  });
  assert.match(cards.textContent ?? "", /Open Figure Modules/u);
  assert.match(cards.textContent ?? "", /发布者审核状态：approved/u);
  assert.match(cards.textContent ?? "", /发布者执行状态：passed（synthetic_data）/u);
  assert.match(cards.textContent ?? "", /SFL Local review：not_reviewed/u);
  assert.match(cards.textContent ?? "", /SFL code execution：false/u);

  const opener = document.createElement("button");
  document.body.append(opener);
  const detail = openCandidateDetail({
    document,
    candidate: personal,
    opener,
    serverToolsAvailable: true,
    updateModelContextAvailable: true,
    onRequestExactPreview() {},
    onRequestAgentReview() {},
  });
  assert.match(detail.dialog.textContent ?? "", /源码 commit：aaaaaaaa/u);
  assert.match(detail.dialog.textContent ?? "", /归档 commit：bbbbbbbb/u);
  assert.match(detail.dialog.textContent ?? "", /ZIP SHA-256：cccccccc/u);
  assert.equal(detail.exactPreviewButton.disabled, false);
  assert.ok(detail.exactPreviewButton.querySelector("svg.sfl-icon"));
  assert.ok(detail.confirmButton.querySelector("svg.sfl-icon"));
  assert.equal(detail.closeButton.getAttribute("aria-label"), `关闭 ${personal.title} 详情`);
  assert.equal(detail.closeButton.title, `关闭 ${personal.title} 详情`);
  detail.closeButton.click();
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
  assert.equal(cards.querySelectorAll(".candidate-action .sfl-icon").length, 2);
  assert.equal(cards.querySelectorAll(".preview-open-indicator .sfl-icon").length, 2);
  assert.deepEqual(
    Array.from(cards.querySelectorAll(".source")).map((node) => node.textContent),
    ["Local Published", "FigureYa"],
  );
  const validationSummaries = Array.from(cards.querySelectorAll(".validation-summary")).map(
    (node) => node.textContent ?? "",
  );
  assert.equal(validationSummaries.length, 2);
  assert.ok(
    validationSummaries.every(
      (text) =>
        text.includes("绘图执行：not_run（范围：unknown）") &&
        text.includes("上游流程：not_run") &&
        text.includes("科学验证：not_assessed"),
    ),
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
    updateModelContextAvailable: false,
    onClosed() {
      closed += 1;
    },
    onRequestExactPreview() {
      exactCalls += 1;
    },
    onRequestAgentReview() {
      assert.fail("updateModelContext fallback is unavailable");
    },
  });
  await Promise.resolve();

  assert.equal(detail.dialog.open, true);
  assert.equal(detail.dialog.querySelector(".detail-description")?.textContent, selected.description);
  assert.match(detail.dialog.textContent ?? "", /Grouped bar-chart comparisons/u);
  assert.match(detail.dialog.textContent ?? "", /One category and one numeric value/u);
  assert.match(detail.dialog.textContent ?? "", /bar chart match/u);
  assert.match(detail.dialog.textContent ?? "", /not executed/u);
  assert.match(detail.dialog.textContent ?? "", /绘图执行：not_run（范围：unknown）/u);
  assert.match(detail.dialog.textContent ?? "", /上游流程：not_run/u);
  assert.match(detail.dialog.textContent ?? "", /科学验证：not_assessed/u);
  assert.match(detail.dialog.textContent ?? "", /default_uploaded_source/u);
  assert.match(detail.dialog.textContent ?? "", /visuals\/source\/preview.png/u);
  assert.equal(detail.exactPreviewButton.disabled, true);
  assert.equal(detail.confirmButton.disabled, true);
  assert.equal(detail.confirmButton.textContent, "Host 不支持选择交接");
  assert.match(detail.status.textContent ?? "", /也未提供 updateModelContext/u);
  detail.exactPreviewButton.click();
  assert.equal(exactCalls, 0);

  detail.dialog.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: "Escape" }) as unknown as Event,
  );
  assert.equal(closed, 1);
  assert.equal(document.activeElement, opener);
});

test("legacy candidates without validationState render a conservative three-part projection", () => {
  const window = new Window();
  const document = window.document as unknown as Document;
  const opener = document.createElement("button");
  document.body.append(opener);
  const legacy = candidate(
    "org.scientificfigurelibrary.local",
    "legacy-state",
    "ready",
    "data:image/png;base64,iVBORw0KGgo=",
  );
  legacy.executionStatus = "passed";
  delete legacy.validationState;
  delete legacy.canonicalPreviewDecision;

  const detail = openCandidateDetail({
    document,
    candidate: legacy,
    opener,
    serverToolsAvailable: true,
    updateModelContextAvailable: true,
    onRequestExactPreview() {},
    onRequestAgentReview() {
      assert.fail("serverTools path must not use the headless handoff button");
    },
  });

  const text = detail.dialog.textContent ?? "";
  assert.match(text, /绘图执行：passed（范围：unknown）/u);
  assert.match(text, /上游流程：unknown/u);
  assert.match(text, /科学验证：not_assessed/u);
  assert.doesNotMatch(text, /Canonical 预览/u);
  detail.closeButton.click();
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
    updateModelContextAvailable: true,
    onRequestExactPreview() {
      assert.fail("unavailable preview must not call exact preview");
    },
    onRequestAgentReview() {
      assert.fail("serverTools path must not use the headless handoff button");
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
    updateModelContextAvailable: true,
    onRequestExactPreview() {
      exactCalls += 1;
    },
    onRequestAgentReview() {
      assert.fail("serverTools path must not use the headless handoff button");
    },
  });
  assert.equal(exactCalls, 0);
  assert.equal(detail.confirmButton.disabled, true);
  detail.exactPreviewButton.click();
  assert.equal(exactCalls, 1);
  assert.equal(detail.confirmButton.disabled, true);
  detail.closeButton.click();
});

test("updateModelContext fallback starts only after the user clicks one candidate", async () => {
  const window = new Window();
  const document = window.document as unknown as Document;
  const opener = document.createElement("button");
  document.body.append(opener);
  let exactCalls = 0;
  let handoffCalls = 0;
  let handoffPromise: Promise<string> | undefined;
  const contextUpdates: Array<{ content: Array<{ type: "text"; text: string }> }> = [];
  const selected = candidate(
    "org.scientificfigurelibrary.local",
    "context-handoff",
    "ready",
    "data:image/png;base64,iVBORw0KGgo=",
  );
  const detail = openCandidateDetail({
    document,
    candidate: selected,
    opener,
    serverToolsAvailable: false,
    updateModelContextAvailable: true,
    onRequestExactPreview() {
      exactCalls += 1;
    },
    onRequestAgentReview() {
      handoffCalls += 1;
      handoffPromise = updateModelContextForHeadlessReview({
        resultSetId: "context-result-set",
        candidate: selected,
        async updateModelContext(input) {
          contextUpdates.push(input);
        },
      });
    },
  });
  await Promise.resolve();

  assert.equal(exactCalls, 0);
  assert.equal(handoffCalls, 0);
  assert.equal(contextUpdates.length, 0);
  assert.equal(detail.exactPreviewButton.disabled, true);
  assert.equal(detail.confirmButton.disabled, false);
  assert.equal(detail.confirmButton.textContent, "选择并交给 Agent 审核");
  assert.match(detail.status.textContent ?? "", /不能证明精确图片已在 App 内加载/u);

  detail.confirmButton.click();
  assert.equal(exactCalls, 0);
  assert.equal(handoffCalls, 1);
  assert.ok(handoffPromise);
  await handoffPromise;
  assert.equal(contextUpdates.length, 1);
  assert.match(contextUpdates[0]?.content[0]?.text ?? "", /context-result-set/u);
  assert.doesNotMatch(contextUpdates[0]?.content[0]?.text ?? "", /data:image/u);
  detail.closeButton.click();
  assert.equal(handoffCalls, 1);
});

test("headless review handoff contains one compact candidate and no image or credential values", () => {
  const selected = candidate(
    "org.scientificfigurelibrary.local",
    "selected-only",
    "ready",
    "data:image/png;base64,private-thumbnail-bytes",
  );
  const text = buildHeadlessReviewHandoff({
    resultSetId: "selected-result-set",
    candidate: selected,
  });
  const selection = JSON.parse(text.split("\n")[3]!) as Record<string, unknown>;
  const selectedCandidate = selection.selectedCandidate as Record<string, unknown>;
  const authorization = selection.authorization as Record<string, unknown>;

  assert.equal(selection.schema, "figure-library.app-selection-handoff.v1");
  assert.equal(selection.handoffMode, "headless_exact_review");
  assert.equal(selection.resultSetId, "selected-result-set");
  assert.equal(selectedCandidate.templateId, "selected-only");
  assert.equal(selectedCandidate.providerId, "org.scientificfigurelibrary.local");
  assert.deepEqual(selectedCandidate.exactSelector, selected.exactSelector);
  assert.equal(selectedCandidate.candidateThumbnailSha256, "a".repeat(64));
  assert.equal(authorization.exactReviewCandidateLimit, 1);
  assert.equal(authorization.mayCreateReadOnlyMaterializePlan, true);
  assert.equal(authorization.mayApplyMaterialization, false);
  assert.doesNotMatch(
    JSON.stringify(selection),
    /data:image|previewDataUrl|previewChallenge|previewReceipt/u,
  );
  assert.match(text, /figure_library_preview_exact_headless exactly once/u);
  assert.match(text, /figure_library_confirm_selection_headless/u);
  assert.match(text, /do not Apply or download anything/u);
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
      updateModelContextAvailable: true,
      onRequestExactPreview() {},
      onRequestAgentReview() {
        assert.fail("serverTools path must not use the headless handoff button");
      },
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


test("plot-set handoff includes every selected template and requires plotting all of them", () => {
  const first = candidate("org.scientificfigurelibrary.local", "gsea-scatter", "ready");
  const second = candidate("org.figureya.module", "enrichment-bar", "ready");
  first.scientificQuestion = "哪些通路被激活或抑制？";
  const text = buildPlotSetHandoff({
    resultSetId: "plot-set-result",
    candidates: [first, second],
  });
  const selection = JSON.parse(text.split("\n")[3]!) as Record<string, unknown>;
  const selected = selection.selectedCandidates as Array<Record<string, unknown>>;
  const authorization = selection.authorization as Record<string, unknown>;
  assert.equal(selection.handoffMode, "agent_plot_set");
  assert.equal(selected.length, 2);
  assert.equal(selected[0]?.templateId, "gsea-scatter");
  assert.equal(selected[0]?.scientificQuestion, "哪些通路被激活或抑制？");
  assert.equal(selected[1]?.templateId, "enrichment-bar");
  assert.equal(authorization.mustPlotAllSelected, true);
  assert.equal(authorization.exactReviewCandidateLimit, 2);
  assert.match(text, /Plot every selected template/u);
  assert.doesNotMatch(text, /Review only this one selected candidate/u);
  assert.doesNotMatch(JSON.stringify(selection), /data:image|previewDataUrl/u);
});
