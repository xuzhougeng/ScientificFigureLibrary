import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { createSearchResultReceiver, parseSearchToolResult } from "../app/search-result-receiver.ts";
import type { Candidate, SearchResult } from "../app/view.ts";

// Public, synthetic fixtures only. No user Library, bindings, images or tokens.
const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
function payload(pageIndex = 1, privateMeta = true, resultSetId = "test-results") {
  const ids = pageIndex === 1 ? [1, 2] : [3];
  const candidates: Candidate[] = ids.map(id => ({
    candidateId: `${resultSetId}-candidate-${id}`, templateId: `test-template-${id}`,
    providerId: "org.scientificfigurelibrary.local", sourceLabel: "Local Published",
    exactSelector: { schema: "figure-library.provider-selector.v1", providerId: "org.scientificfigurelibrary.local", kind: "local-published.v1", identity: { templateId: `test-template-${id}` } },
    title: `Synthetic template ${id}`, titleEn: `Synthetic template ${id}`,
    retrievalScore: 100, reasons: [], warnings: [], excerpt: "Synthetic fixture",
    description: "Synthetic fixture", application: "Test result rendering",
    dataProfile: "Synthetic data", inputFiles: [], codeFiles: [], packages: [],
    materializable: false, previewAvailable: true, previewStatus: "ready", searchPreviewStatus: "ready",
    assetKind: "plot_template", language: "R", plotFamily: "scatter",
    reviewStatus: "approved", codeStatus: "reviewed", executionStatus: "not_run",
    management: { templateId: `test-template-${id}`, canArchive: false, canUpdate: false },
  }));
  return {
    content: [{ type: "text" as const, text: "Synthetic search response" }],
    structuredContent: {
      query: "synthetic hydration", libraryVersion: "test", materializationProtocolVersion: 2,
      intentFamilies: [], reviewRequired: true, resultSetId,
      pagination: { total: 3, pageIndex, pageSize: 2, hasMore: pageIndex === 1, nextCursor: pageIndex === 1 ? "test-next-cursor" : null },
      candidates,
    },
    _meta: privateMeta ? { candidatePreviews: Object.fromEntries(candidates.map(candidate => [candidate.candidateId, { previewDataUrl: PIXEL, previewMimeType: "image/png" }])) } : undefined,
  };
}

function receiver() {
  let current: SearchResult | undefined;
  const rendered: SearchResult[] = [];
  const events = createSearchResultReceiver({
    current: () => current,
    render: result => { current = result; rendered.push(result); },
  });
  return { events, rendered, current: () => current, navigate: (page: SearchResult) => { current = page; } };
}

test("parses standard MCP envelopes without changing scoped identities", () => {
  const raw = payload();
  const result = parseSearchToolResult(raw)!;
  assert.equal(result.resultSetId, raw.structuredContent.resultSetId);
  assert.deepEqual(result.candidates[0]?.exactSelector, raw.structuredContent.candidates[0]?.exactSelector);
  assert.equal(result.candidates[0]?.previewDataUrl, PIXEL);
});

test("initial toolOutput is enriched by matching canonical private metadata", () => {
  const raw = payload();
  for (const key of ["mcp_tool_result", "call_tool_result"]) {
    const result = parseSearchToolResult(raw.structuredContent, { [key]: raw })!;
    assert.equal(result.candidates[0]?.previewDataUrl, PIXEL);
  }
  assert.equal(parseSearchToolResult(raw.structuredContent, raw._meta)?.candidates[0]?.previewDataUrl, PIXEL);
  assert.equal(parseSearchToolResult(undefined, { mcp_tool_result: raw })?.pagination.total, 3);
});

test("stale canonical metadata cannot replace newer output or its candidate identity", () => {
  const old = payload();
  const fresh = payload(1, false, "test-new-results");
  const result = parseSearchToolResult(fresh.structuredContent, { mcp_tool_result: old })!;
  assert.equal(result.resultSetId, "test-new-results");
  assert.equal(result.candidates[0]?.previewDataUrl, undefined);
  const otherProvider = payload();
  otherProvider.structuredContent.candidates[0]!.providerId = "test-other-provider";
  assert.equal(parseSearchToolResult(old.structuredContent, { mcp_tool_result: otherProvider })?.candidates[0]?.previewDataUrl, undefined);
});

test("rejects text/JSON strings, malformed outputs and explicit errors", () => {
  const raw = payload();
  for (const value of ["text", JSON.stringify(raw), [], { candidates: [] }, { setup: { required: true } }, { ...raw, isError: true }]) {
    assert.equal(parseSearchToolResult(value, { mcp_tool_result: raw }), undefined);
  }
});

test("hydrates initial globals once and ignores unchanged compatibility/standard delivery", () => {
  const r = receiver(), raw = payload();
  const globals = { toolOutput: raw.structuredContent, toolResponseMetadata: { mcp_tool_result: raw } };
  r.events.legacy(globals);
  r.events.legacy(globals);
  r.events.notification(raw);
  assert.equal(r.rendered.length, 1);
  assert.equal(r.current()?.candidates[0]?.previewDataUrl, PIXEL);
});

test("late private metadata fills only missing previews and preserves current prose", () => {
  const r = receiver(), bare = payload(1, false), complete = payload();
  r.events.legacy({ toolOutput: bare.structuredContent });
  assert.equal(r.current()?.candidates[0]?.previewDataUrl, undefined);
  complete.structuredContent.candidates[0]!.description = "Must not replace active prose";
  r.events.legacy({ toolOutput: complete.structuredContent, toolResponseMetadata: { mcp_tool_result: complete } });
  assert.equal(r.rendered.length, 2);
  assert.equal(r.current()?.candidates[0]?.previewDataUrl, PIXEL);
  assert.equal(r.current()?.candidates[0]?.description, "Synthetic fixture");
  r.events.notification(bare);
  assert.equal(r.rendered.length, 2);
});

test("late globals or repeated initial notifications cannot rewind local paging", () => {
  const r = receiver(), first = payload();
  r.events.legacy({ toolOutput: first.structuredContent, toolResponseMetadata: { mcp_tool_result: first } });
  r.navigate(parseSearchToolResult(payload(2))!);
  r.events.legacy({ toolOutput: first.structuredContent, toolResponseMetadata: { mcp_tool_result: first } });
  r.events.notification(first);
  r.events.notification(payload(1, false));
  assert.equal(r.current()?.pagination.pageIndex, 2);
  assert.equal(r.rendered.length, 1);
});

test("standard new searches remain supported and old compatibility globals are ignored", () => {
  const r = receiver(), old = payload(), fresh = payload(1, true, "test-new-results");
  r.events.notification(old);
  r.events.notification(fresh);
  r.events.legacy({ toolOutput: old.structuredContent, toolResponseMetadata: { mcp_tool_result: old } });
  assert.equal(r.current()?.resultSetId, "test-new-results");
  assert.equal(r.rendered.length, 2);
});

test("empty matches hydrate normally; missing globals do not render or call tools", () => {
  const r = receiver();
  for (const globals of [undefined, null, {}, { toolOutput: "{}" }]) r.events.legacy(globals);
  assert.equal(r.rendered.length, 0);
  const empty = payload(); empty.structuredContent.candidates = []; empty.structuredContent.pagination.total = 0;
  r.events.notification(empty);
  assert.equal(r.current()?.candidates.length, 0);
});

test("actual App entrypoint hydrates before notifications and preserves paging/selection", async () => {
  const first = payload(), second = payload(2);
  const bundled = await build({
    entryPoints: [fileURLToPath(new URL("../app/main.ts", import.meta.url))],
    bundle: true, write: false, format: "iife", platform: "browser", target: "es2022",
    loader: { ".css": "empty", ".svg": "text" },
    plugins: [{ name: "mock-app-bridge", setup(builder) {
      builder.onResolve({ filter: /^@modelcontextprotocol\/ext-apps$/ }, () => ({ path: "app-bridge", namespace: "test" }));
      builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: `
        export class App {
          constructor(){window.__testBridge.app=this;}
          connect(){return Promise.resolve();}
          getHostContext(){return {displayMode:'inline',availableDisplayModes:['inline','fullscreen','pip']};}
          getHostCapabilities(){return {serverTools:{},updateModelContext:{text:{}}};}
          callServerTool(request){
            window.__testBridge.calls.push(request.name);
            if(request.name==='figure_library_source_status')return Promise.resolve({structuredContent:{setup:{required:false}}});
            if(request.name==='figure_library_search_page')return Promise.resolve(window.__testBridge.next);
            throw Error('Unexpected tool call');
          }
        }
        export const applyDocumentTheme=()=>{},applyHostFonts=()=>{},applyHostStyleVariables=()=>{};
      ` }));
    } }],
  });
  const html = await fs.readFile(new URL("../app/mcp-app.html", import.meta.url), "utf8");
  const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true, url: "https://sfl-test.invalid/" });
  const window = dom.window;
  const bridge = { app: undefined as { ontoolresult: (result: unknown) => void } | undefined, next: second, calls: [] as string[] };
  Object.assign(window, { TextEncoder, TextDecoder, __testBridge: bridge,
    openai: { toolOutput: first.structuredContent, toolResponseMetadata: { mcp_tool_result: first } } });
  window.scrollTo = () => {};
  window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  window.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); this.dispatchEvent(new window.Event("close")); };
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const click = (selector: string) => (window.document.querySelector(selector) as HTMLButtonElement).click();
  try {
    window.eval(bundled.outputFiles[0]!.text); await settle();
    assert.equal(window.document.querySelectorAll("#cards img").length, 2);
    assert.match(window.document.getElementById("page-status")!.textContent!, /第 1 \/ 2 页/);
    click(".candidate-title");
    assert.match(window.document.getElementById("plot-set-count")!.textContent!, /1/);
    click(".candidate-action");
    assert.ok(window.document.querySelector("dialog[open]"));
    window.dispatchEvent(new window.Event("openai:set_globals"));
    bridge.app!.ontoolresult(first);
    assert.ok(window.document.querySelector("dialog[open]"), "duplicate updates must not close detail");
    click("#next-page"); await settle();
    window.dispatchEvent(new window.Event("openai:set_globals"));
    bridge.app!.ontoolresult(first);
    assert.match(window.document.getElementById("page-status")!.textContent!, /第 2 \/ 2 页/);
    assert.equal(window.document.querySelectorAll("#cards img").length, 1);
    assert.match(window.document.getElementById("plot-set-count")!.textContent!, /1/);
    click("#previous-page");
    assert.match(window.document.getElementById("page-status")!.textContent!, /第 1 \/ 2 页/);
    assert.equal(window.document.querySelector(".card")?.getAttribute("data-selected"), "true");
    bridge.app!.ontoolresult(payload(1, true, "test-new-search"));
    assert.match(window.document.getElementById("plot-set-count")!.textContent!, /0/);
    assert.deepEqual(bridge.calls, ["figure_library_source_status", "figure_library_search_page"]);
  } finally { window.close(); }

  const late = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true, url: "https://sfl-test.invalid/" });
  const lateBridge = { app: undefined as typeof bridge.app, next: second, calls: [] as string[] };
  try {
    Object.assign(late.window, { TextEncoder, TextDecoder, __testBridge: lateBridge });
    Object.defineProperty(late.window, "openai", { configurable: true, get() { throw new Error("Compatibility globals unavailable"); } });
    late.window.eval(bundled.outputFiles[0]!.text); await settle();
    assert.equal(late.window.document.querySelectorAll("#cards .card").length, 0);
    Object.defineProperty(late.window, "openai", { configurable: true, value: { toolOutput: first.structuredContent, toolResponseMetadata: { call_tool_result: first } } });
    late.window.dispatchEvent(new late.window.Event("openai:set_globals"));
    assert.equal(late.window.document.querySelectorAll("#cards img").length, 2, "late initial globals hydrate without a standard notification");
    lateBridge.app!.ontoolresult(first);
    assert.equal(late.window.document.querySelectorAll("#cards img").length, 2);
    assert.deepEqual(lateBridge.calls, ["figure_library_source_status"]);
  } finally { late.window.close(); }
});
