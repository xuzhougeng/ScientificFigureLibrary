import assert from "node:assert/strict";
import test from "node:test";
import { createTestWindow } from "./helpers/dom.ts";
import { renderMarkdown, safeDocumentationUrl } from "../app/markdown.ts";

function document() { return createTestWindow().document as unknown as Document; }

test("Markdown renders semantic headings, paragraphs, lists, tables, quotations and code", () => {
  const block = renderMarkdown(document(), "### 场景\n\n**重点** and *emphasis*\n\n- item\n\n1. numbered\n\n> 保留边界\n\n|A|B|\n|---|---|\n|a|b|\n\n`support`\n\n```r\nplot(1:3)\n```\n\n[paper](https://example.org/paper)");
  for (const selector of ["h3", "strong", "em", "ul li", "ol li", "blockquote", "table", "code", "pre code", "a"]) assert.ok(block.querySelector(selector), selector);
  assert.ok(block.querySelector(".markdown-table-scroll table"));
  assert.match(block.textContent ?? "", /plot\(1:3\)/u);
});

test("untrusted Markdown cannot create HTML, images, styles, events, downloads or unsafe URLs", () => {
  const text = [
    '<script>alert(1)</script><iframe src="https://evil.invalid"></iframe>',
    '<img src="https://evil.invalid/track" onerror="alert(1)">',
    '<svg><foreignObject><style>*{display:none}</style></foreignObject></svg>',
    '![tracking](https://evil.invalid/pixel.png)',
    '[x](javascript:alert%281%29)', '[x](data:text/html,alert)', '[x](file:///etc/passwd)',
    '[x](//evil.invalid)', '[x](https://user:secret@example.org)',
    '<a href="https://example.org" download onclick="alert(1)">x</a>',
  ].join("\n\n");
  const block = renderMarkdown(document(), text);
  assert.equal(block.querySelectorAll("script,iframe,img,svg,style,foreignObject,object,embed,form,input").length, 0);
  for (const element of Array.from(block.querySelectorAll("*"))) {
    for (const attr of Array.from(element.attributes)) assert.doesNotMatch(attr.name, /^(?:on|style|src|download|id)/iu);
  }
  assert.equal(block.querySelectorAll("a").length, 0);
  for (const url of ["javascript:alert(1)", "data:text/html,x", "//example.org", "file:///x", "https://user:pw@example.org", "https:\n//example.org"]) assert.equal(safeDocumentationUrl(url), undefined);
});

test("safe links request the Host only on explicit click; unsupported Hosts get a copyable URL", async () => {
  const calls: string[] = [];
  const block = renderMarkdown(document(), "[paper](https://example.org/paper)", async (url) => { calls.push(url); });
  assert.deepEqual(calls, []);
  block.querySelector<HTMLAnchorElement>("a")!.click();
  await Promise.resolve();
  assert.deepEqual(calls, ["https://example.org/paper"]);
  const fallback = renderMarkdown(document(), "[paper](https://example.org/paper)");
  fallback.querySelector<HTMLAnchorElement>("a")!.click();
  assert.match(fallback.textContent ?? "", /请复制地址：https:\/\/example.org\/paper/u);
  assert.equal(fallback.querySelector("a")!.hasAttribute("href"), false);
});

test("failed Host links stay copyable; detached documents fail closed to text", async () => {
  const block = renderMarkdown(document(), "[paper](https://example.org/paper)", async () => { throw new Error("denied"); });
  block.querySelector<HTMLAnchorElement>("a")!.click();
  await Promise.resolve();
  assert.match(block.textContent ?? "", /请复制地址/u);
  const detached = document().implementation.createHTMLDocument();
  const text = "<img src=x onerror=evil()>\n### literal";
  const fallback = renderMarkdown(detached, text);
  assert.equal(fallback.textContent, text);
  assert.equal(fallback.querySelectorAll("*").length, 0);
});
