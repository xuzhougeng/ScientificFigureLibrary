import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
import { createCustomTagUI, splitCustomTags } from "../app/local/custom-tags.ts";
import type { CustomTagSnapshot } from "../src/local/custom-tags.ts";

async function setup(t: { after: (fn: () => void) => void }) {
  const dom = new JSDOM('<select id="search-custom-tag"></select><select id="library-custom-tag"></select><article id="card"></article>');
  const { document } = dom.window;
  dom.window.scrollTo = () => {};
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new dom.window.Event("close")); };
  t.after(() => dom.window.close());
  let state: CustomTagSnapshot = { libraryContext: "bound-library", tags: ["旧标签"], entries: [{ providerId: "provider", templateId: "image", tags: ["旧标签"] }] };
  let submitted: Record<string, unknown> | undefined;
  let conflict = false, saved = 0;
  const api = async <T>(_route: string, body?: unknown): Promise<T> => {
    if (body) {
      submitted = body as Record<string, unknown>;
      if (conflict) throw new Error("标签已在另一窗口中修改");
      state = { ...state, tags: submitted.tags as string[], entries: [{ ...state.entries[0]!, tags: submitted.tags as string[] }] };
    }
    return structuredClone(state) as T;
  };
  const ui = createCustomTagUI(document, api, async () => { saved++; });
  await ui.refresh();
  const widget = ui.widget({ providerId: "provider", templateId: "image" }, { resultSetId: "result", candidateId: "candidate" }, "参考图");
  document.getElementById("card")!.append(widget);
  return { dom, document, ui, widget, submission: () => submitted, saved: () => saved, conflict: () => { conflict = true; } };
}

test("tag editor uses text rendering, does not select a reference, and saves the original context", async t => {
  const { document, widget, submission, saved } = await setup(t);
  let selected = false;
  document.getElementById("card")!.onclick = () => { selected = true; };
  widget.querySelector("button")!.click(); await setTimeout(0);
  assert.equal(selected, false);
  const dialog = document.querySelector("dialog")!;
  const input = dialog.querySelector("input")!;
  assert.equal(input.value, "旧标签");
  input.value = "单细胞，<img src=x onerror=alert(1)>";
  const save = [...dialog.querySelectorAll("button")].find(button => button.textContent === "保存标签")!;
  save.click(); await setTimeout(0);
  assert.deepEqual(submission(), { target: { resultSetId: "result", candidateId: "candidate" }, tags: ["单细胞", "<img src=x onerror=alert(1)>"], expectedTags: ["旧标签"], libraryContext: "bound-library" });
  assert.equal(saved(), 1);
  assert.equal(document.querySelector("dialog"), null);
  assert.equal(widget.querySelector("img"), null);
  assert.match(widget.textContent!, /单细胞/u);
  assert.equal(document.getElementById("search-custom-tag")!.querySelectorAll("option").length, 3);
});

test("a conflicting save retains the user's edit and enables retry without claiming success", async t => {
  const { document, widget, conflict, saved } = await setup(t);
  conflict(); widget.querySelector("button")!.click(); await setTimeout(0);
  const dialog = document.querySelector("dialog")!;
  dialog.querySelector("input")!.value = "我的修改";
  const save = [...dialog.querySelectorAll("button")].find(button => button.textContent === "保存标签")!;
  save.click(); await setTimeout(0);
  assert.match(dialog.querySelector('[role="status"]')!.textContent!, /另一窗口/u);
  assert.equal(dialog.querySelector("input")!.value, "我的修改");
  assert.equal(save.disabled, false);
  assert.equal(saved(), 0);
});

test("clearing all tags sends an empty replacement and preserves the active filter", async t => {
  const { document, widget, submission } = await setup(t);
  (document.getElementById("search-custom-tag") as HTMLSelectElement).value = "旧标签";
  widget.querySelector("button")!.click(); await setTimeout(0);
  const dialog = document.querySelector("dialog")!;
  dialog.querySelector("input")!.value = " ， , ";
  [...dialog.querySelectorAll("button")].find(button => button.textContent === "保存标签")!.click(); await setTimeout(0);
  assert.deepEqual(submission()!.tags, []);
  assert.equal(widget.querySelectorAll(".custom-tag-chip").length, 0);
  assert.equal((document.getElementById("search-custom-tag") as HTMLSelectElement).value, "旧标签");
  assert.deepEqual(splitCustomTags("中文, English，待使用\n另一个"), ["中文", "English", "待使用", "另一个"]);
});
