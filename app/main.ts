import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import "./styles.css";

interface Candidate {
  templateId: string;
  sourceId: "figureya" | "user";
  sourceLabel: string;
  title: string;
  retrievalScore: number;
  reasons: string[];
  warnings: string[];
  excerpt: string;
  description: string;
  inputFiles: string[];
  packages: string[];
  materializable: boolean;
  previewAvailable: boolean;
  assetKind: "plot_template" | "visual_reference";
  language: string;
  plotFamily: string;
  reviewStatus: "draft" | "approved" | "archived";
  codeStatus: "none" | "scaffold" | "reviewed";
  previewDataUrl?: string;
}

interface SearchResult {
  query: string;
  libraryVersion: string;
  intentFamilies: string[];
  reviewRequired: boolean;
  candidates: Candidate[];
}

const root = document.getElementById("app")!;
const cards = document.getElementById("cards")!;
const empty = document.getElementById("empty")!;
const query = document.getElementById("query")!;
const status = document.getElementById("status")!;
const app = new App({ name: "Scientific Figure Library", version: "0.2.0" });

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function chips(values: string[]) {
  const container = element("div", "chips");
  for (const value of values.slice(0, 6)) {
    container.append(element("span", "chip", value));
  }
  return container;
}

async function selectCandidate(candidate: Candidate, button: HTMLButtonElement) {
  document.querySelectorAll<HTMLButtonElement>("button[aria-pressed]").forEach((item) => {
    item.setAttribute("aria-pressed", String(item === button));
    item.textContent = item === button ? "等待审核" : "交给 Agent 审核";
  });

  const markdown = `---
source: Scientific Figure Library MCP App
selectedTemplate: ${candidate.templateId}
templateSource: ${candidate.sourceId}
---

The user asked the Agent to review **${candidate.templateId}** from **${candidate.sourceLabel}**.
Classification: ${candidate.assetKind}; language ${candidate.language}; review ${candidate.reviewStatus}; code ${candidate.codeStatus}.
Retrieval score is ${candidate.retrievalScore}/100; it is not a final recommendation or confidence.
Reasons: ${candidate.reasons.join("; ") || "catalog metadata match"}.
Next, call figure_library_preview, inspect it with view_image, and report a visual pass/reject score before figure_library_describe or figure_library_materialize.`;

  try {
    if (app.getHostCapabilities()?.updateModelContext?.text) {
      await app.updateModelContext({ content: [{ type: "text", text: markdown }] });
      status.textContent = `已把 ${candidate.templateId} 发送到下一轮 Agent 上下文。`;
    } else {
      status.textContent = `已选择 ${candidate.templateId}。当前 Host 不支持上下文更新，请在对话中发送模板 ID。`;
    }
  } catch {
    status.textContent = `已选择 ${candidate.templateId}，但 Host 拒绝了上下文更新；请在对话中发送模板 ID。`;
  }
}

function render(result: SearchResult) {
  cards.replaceChildren();
  query.textContent = `“${result.query}” · v${result.libraryVersion}`;
  empty.hidden = result.candidates.length > 0;

  for (const candidate of result.candidates) {
    const card = element("article", "card");
    const preview = element("div", "preview");
    if (candidate.previewDataUrl) {
      const image = element("img");
      image.src = candidate.previewDataUrl;
      image.alt = `${candidate.templateId} preview`;
      preview.append(image);
    } else {
      preview.append(element("span", undefined, "No preview"));
    }

    const content = element("div", "content");
    const top = element("div", "topline");
    const heading = element("div");
    heading.append(
      element("h2", "module", candidate.templateId),
      element("span", `source source-${candidate.sourceId}`, candidate.sourceLabel),
    );
    top.append(
      heading,
      element("span", "score", `召回 ${candidate.retrievalScore}`),
    );
    const description = candidate.description || candidate.excerpt || "查看模板详情以确认输入要求。";
    content.append(top, element("p", "description", description));

    const tags = [
      candidate.assetKind,
      candidate.language,
      candidate.plotFamily,
      candidate.reviewStatus,
      candidate.codeStatus,
      ...candidate.inputFiles.slice(0, 3),
      ...candidate.packages.slice(0, 3).map((name) => `pkg:${name}`),
    ].filter(Boolean);
    if (tags.length) content.append(chips(tags));
    if (candidate.reasons[0]) content.append(element("p", "reason", candidate.reasons[0]));
    if (candidate.warnings[0]) content.append(element("p", "warning", candidate.warnings[0]));

    const button = element("button", undefined, "交给 Agent 审核");
    button.type = "button";
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => void selectCandidate(candidate, button));
    content.append(button);
    card.append(preview, content);
    cards.append(card);
  }
}

function parseResult(result: CallToolResult): SearchResult | undefined {
  const value = result.structuredContent as Partial<SearchResult> | undefined;
  if (!value || typeof value.query !== "string" || !Array.isArray(value.candidates)) return;
  return {
    query: value.query,
    libraryVersion: typeof value.libraryVersion === "string" ? value.libraryVersion : "unknown",
    intentFamilies: Array.isArray(value.intentFamilies)
      ? value.intentFamilies.filter((item): item is string => typeof item === "string")
      : [],
    reviewRequired: value.reviewRequired === true,
    candidates: value.candidates as Candidate[],
  };
}

function applyHostContext(context: NonNullable<ReturnType<App["getHostContext"]>>) {
  if (context.theme) applyDocumentTheme(context.theme);
  if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
  if (context.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
  if (context.safeAreaInsets) {
    root.style.paddingTop = `${context.safeAreaInsets.top + 20}px`;
    root.style.paddingRight = `${context.safeAreaInsets.right + 20}px`;
    root.style.paddingBottom = `${context.safeAreaInsets.bottom + 20}px`;
    root.style.paddingLeft = `${context.safeAreaInsets.left + 20}px`;
  }
}

app.ontoolinput = (input) => {
  const request = input.arguments as { query?: unknown };
  if (typeof request.query === "string") query.textContent = `“${request.query}”`;
};
app.ontoolresult = (result) => {
  const parsed = parseResult(result);
  if (parsed) render(parsed);
  else status.textContent = "Host 返回了无法识别的候选格式。";
};
app.onhostcontextchanged = applyHostContext;

window.addEventListener("error", (event) => {
  console.error(event.error);
  status.textContent = "MCP App 发生错误，请回到对话查看文本候选。";
});
window.addEventListener("unhandledrejection", (event) => {
  console.error(event.reason);
  status.textContent = "MCP App 发生错误，请回到对话查看文本候选。";
});

app
  .connect()
  .then(() => {
    const context = app.getHostContext();
    if (context) applyHostContext(context);
  })
  .catch((error: unknown) => {
    console.error(error);
    status.textContent = "无法连接 MCP Host，请回到对话使用文本候选。";
  });
