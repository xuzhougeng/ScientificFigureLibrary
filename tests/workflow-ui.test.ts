import assert from "node:assert/strict";
import test from "node:test";
import { createTestWindow } from "./helpers/dom.ts";
import { mountPlottingTips, PLOTTING_EXAMPLE } from "../app/plotting-tips.ts";
import { openSubmissionDialog } from "../app/project-figures.ts";

test("tips restore collapse preference, reopen and copy without submitting a request", async () => {
  const window = createTestWindow(); const doc = window.document as unknown as Document;
  const values = new Map([["sfl.plotting-tips.collapsed", "true"]]);
  let copied = "";
  const tips = mountPlottingTips(doc, doc.body, {
    storage: { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => { values.set(k, v); } },
    copy: async (text) => { copied = text; },
  });
  assert.equal(tips.open, false);
  tips.open = true; tips.dispatchEvent(new window.Event("toggle"));
  assert.equal(values.get("sfl.plotting-tips.collapsed"), "false");
  tips.querySelector("button")!.click(); await new Promise((r) => setTimeout(r, 0));
  assert.equal(copied, PLOTTING_EXAMPLE);
  assert.match(tips.querySelector('[role="status"]')!.textContent!, /已复制/);
});

test("tips work when storage and clipboard are unavailable", async () => {
  const doc = createTestWindow().document as unknown as Document;
  const tips = mountPlottingTips(doc, doc.body, {
    storage: { getItem() { throw Error(); }, setItem() { throw Error(); } },
    copy: async () => { throw Error(); },
  });
  tips.querySelector("button")!.click(); await new Promise((r) => setTimeout(r, 0));
  assert.match(tips.querySelector('[role="status"]')!.textContent!, /手动复制/);
  assert.equal(tips.querySelector("button")!.disabled, false);
});

const figure = { id: "figure-fixture", title: "Example", revision: 1, directory: "figures/example", label: null, artworkLabelPending: false };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("submission dialog requires inventory review, prevents double export and shows failures and success", async () => {
  const doc = createTestWindow().document as unknown as Document;
  const opener = doc.createElement("button"); doc.body.append(opener);
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  let fail = true; let finish: (v: Record<string, unknown>) => void = () => {};
  const dialog = openSubmissionDialog(doc, figure, async (name, input) => {
    calls.push({ name, input });
    if (name.includes("plan_")) {
      if (fail) throw Error("Missing language preparation");
      return { digest: "abc", destination: "exports/example-r1-en.zip", files: [{ path: "README.md", bytes: 100 }], exceptions: [] };
    }
    return new Promise((resolve) => { finish = resolve; });
  }, async () => {}, opener);
  const buttons = Array.from(dialog.querySelectorAll("button"));
  const preview = buttons.find((b) => b.textContent === "检查并预览文件清单")!;
  const submit = buttons.find((b) => b.textContent === "导出")!;
  const cancel = buttons.find((b) => b.textContent === "取消")!;
  assert.equal(submit.disabled, true);
  preview.click(); await tick(); assert.match(dialog.textContent!, /Missing language preparation/);
  assert.equal(submit.disabled, true); fail = false;
  const language = dialog.querySelector("select")!; language.value = "en";
  language.dispatchEvent(new doc.defaultView!.Event("change"));
  preview.click(); await tick(); assert.match(dialog.textContent!, /README.md/);
  assert.equal(submit.disabled, false); submit.click(); submit.click();
  assert.equal(calls.filter((v) => v.name.includes("apply_")).length, 1);
  assert.equal(cancel.disabled, true);
  finish({ path: "exports/example-r1-en.zip" }); await tick();
  assert.match(dialog.textContent!, /已导出：exports/); assert.equal(submit.disabled, true);
  cancel.click(); assert.equal(doc.querySelector("dialog"), null);
});

test("cancel and Escape do not export; late preview replies cannot reopen a closed dialog", async () => {
  const window = createTestWindow(); const doc = window.document as unknown as Document;
  const opener = doc.createElement("button"); doc.body.append(opener);
  let calls = 0; let finish: (v: Record<string, unknown>) => void = () => {};
  const dialog = openSubmissionDialog(doc, figure, async () => { calls++; return new Promise((resolve) => { finish = resolve; }); }, async () => {}, opener);
  const buttons = Array.from(dialog.querySelectorAll("button"));
  buttons.find((b) => b.textContent === "检查并预览文件清单")!.click();
  buttons.find((b) => b.textContent === "取消")!.click();
  finish({ digest: "late", destination: "unused", files: [], exceptions: [] }); await tick();
  assert.equal(calls, 1); assert.equal(doc.querySelector("dialog"), null);
  const second = openSubmissionDialog(doc, figure, async () => { calls++; return {}; }, async () => {}, opener);
  const cancelEvent = new window.Event("cancel", { cancelable: true });
  second.dispatchEvent(cancelEvent); assert.equal(cancelEvent.defaultPrevented, false);
  // Native dialog performs this default action for Escape; jsdom does not.
  second.close(); assert.equal(calls, 1);
});
