import assert from "node:assert/strict";
import test from "node:test";
import { Window } from "happy-dom";
import {
  applyWorkbenchDisplayMode,
  compactWorkbenchSummary,
  hostSupportsMode,
  supportedDisplayModes,
  type WorkbenchDisplayElements,
} from "../app/display-mode.ts";

function mount(): WorkbenchDisplayElements {
  const window = new Window();
  const document = window.document as unknown as Document;
  const root = document.createElement("main");
  const controls = document.createElement("div");
  const expandButton = document.createElement("button");
  const keepVisibleButton = document.createElement("button");
  const reexpandButton = document.createElement("button");
  const pipSummary = document.createElement("p");
  expandButton.textContent = "展开浏览";
  keepVisibleButton.textContent = "保持可见";
  reexpandButton.textContent = "重新展开";
  controls.append(expandButton, keepVisibleButton, reexpandButton);
  root.append(controls, pipSummary);
  document.body.append(root);
  return {
    root,
    controls,
    expandButton,
    keepVisibleButton,
    reexpandButton,
    pipSummary,
  };
}

test("unsupported hosts hide display-mode controls", () => {
  const elements = mount();
  const mode = applyWorkbenchDisplayMode({
    elements,
    mode: "pip",
    available: [],
    summary: "摘要",
  });
  assert.equal(mode, "inline");
  assert.equal(elements.root.dataset.displayMode, "inline");
  assert.equal(elements.controls.hidden, true);
  assert.equal(elements.expandButton.hidden, true);
  assert.equal(elements.keepVisibleButton.hidden, true);
  assert.equal(supportedDisplayModes(undefined).length, 0);
  assert.equal(hostSupportsMode(["inline"], "pip"), false);
});

test("fullscreen and pip buttons appear only when the host advertises them", () => {
  const elements = mount();
  applyWorkbenchDisplayMode({
    elements,
    mode: "inline",
    available: ["inline", "fullscreen", "pip"],
    summary: "摘要",
  });
  assert.equal(elements.controls.hidden, false);
  assert.equal(elements.expandButton.hidden, false);
  assert.equal(elements.keepVisibleButton.hidden, false);
  assert.equal(elements.reexpandButton.hidden, true);
  assert.equal(elements.pipSummary.hidden, true);
});

test("pip compact mode records data-display-mode and shows the summary", () => {
  const elements = mount();
  const mode = applyWorkbenchDisplayMode({
    elements,
    mode: "pip",
    available: ["inline", "fullscreen", "pip"],
    summary: compactWorkbenchSummary({
      query: "火山图",
      pageIndex: 1,
      pageCount: 4,
      selectedTitles: ["GSEA", "Volcano", "Bar", "Heatmap"],
    }),
  });
  assert.equal(mode, "pip");
  assert.equal(elements.root.dataset.displayMode, "pip");
  assert.equal(elements.keepVisibleButton.disabled, true);
  assert.equal(elements.reexpandButton.hidden, false);
  assert.equal(elements.pipSummary.hidden, false);
  assert.match(elements.pipSummary.textContent ?? "", /火山图/);
  assert.match(elements.pipSummary.textContent ?? "", /第 1 \/ 4 页/);
  assert.match(elements.pipSummary.textContent ?? "", /等 4 个/);
});
