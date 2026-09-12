import assert from "node:assert/strict";
import test from "node:test";
import { createTestWindow } from "./helpers/dom.ts";
import { mountPlottingTips, PLOTTING_EXAMPLE } from "../app/plotting-tips.ts";

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


test("tips are optional expression guidance, not project registration or persistent styles", () => {
  const doc = createTestWindow().document as unknown as Document;
  let copies = 0;
  const tips = mountPlottingTips(doc, doc.body, { copy: async () => { copies++; } });
  assert.equal(copies, 0);
  assert.equal(tips.querySelectorAll("input, select, textarea, form").length, 0);
  assert.match(tips.textContent!, /没有特殊要求可沿用模板/);
  assert.doesNotMatch(tips.textContent!, /跨会话|记住我的|长期规范|归档|投稿包|Figure 1|项目图/);
  tips.open = false;
  assert.equal(tips.open, false);
  tips.open = true;
  assert.equal(tips.open, true);
});
