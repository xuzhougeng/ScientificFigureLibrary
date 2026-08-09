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
  providerId: string;
  exactSelector: {
    schema: "figure-library.provider-selector.v1";
    providerId: string;
    kind: string;
    identity: Record<string, unknown>;
  };
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
  reviewStatus: "not_reviewed" | "draft" | "approved" | "archived";
  codeStatus: "none" | "scaffold" | "provided" | "reviewed";
  executionStatus: "not_run" | "passed" | "failed" | "unknown";
  management: {
    templateId: string;
    adapter?: "direct" | "gallery" | "figure-transfer-package";
    registrySourceId?: string;
    galleryId?: string;
    identityMode?: "stable-source" | "content-addressed";
    canArchive: boolean;
    canUpdate: boolean;
    updateVia?: "plan-apply" | "diff-upsert" | "gallery-sync";
  };
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
const app = new App({ name: "Scientific Figure Library", version: "0.5.0" });

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
templateProvider: ${candidate.providerId}
templateTitle: ${candidate.title}
exactSelector: ${JSON.stringify(candidate.exactSelector)}
templateAdapter: ${candidate.management.adapter ?? "none"}
templateRegistrySource: ${candidate.management.registrySourceId ?? "none"}
templateGalleryId: ${candidate.management.galleryId ?? "none"}
---

The user asked the Agent to review **${candidate.title}** (\`${candidate.templateId}\`) from **${candidate.sourceLabel}**.
Classification: ${candidate.assetKind}; language ${candidate.language}; review ${candidate.reviewStatus}; code ${candidate.codeStatus}; execution ${candidate.executionStatus}.
Retrieval score is ${candidate.retrievalScore}/100; it is not a final recommendation or confidence.
Reasons: ${candidate.reasons.join("; ") || "catalog metadata match"}.
Next, call figure_library_describe with providerId and exactSelector, then call figure_library_preview exactly once, inspect it with view_image when a path is returned, and report a visual pass/reject score before figure_library_plan_materialize. Never select by bare templateId.`;

  try {
    if (app.getHostCapabilities()?.updateModelContext?.text) {
      await app.updateModelContext({ content: [{ type: "text", text: markdown }] });
      status.textContent = `已把 ${candidate.templateId} 发送到下一轮 Agent 上下文。`;
    } else {
      status.textContent = `已选择 ${candidate.templateId}。当前 Host 不支持上下文更新；请回到对话要求 Agent 保留该候选的 providerId 与 exactSelector。`;
    }
  } catch {
    status.textContent = `已选择 ${candidate.templateId}，但 Host 拒绝了上下文更新；请回到对话要求 Agent 保留该候选的 providerId 与 exactSelector。`;
  }
}

function render(result: SearchResult) {
  cards.replaceChildren();
  query.textContent = `“${result.query}” · v${result.libraryVersion}`;
  empty.hidden = result.candidates.length > 0;

  for (const candidate of result.candidates) {
    const card = element("article", "card");
    const preview = element("div", "preview");
    preview.append(
      element(
        "span",
        undefined,
        candidate.previewAvailable ? "按需加载单张预览" : "无可用预览",
      ),
    );

    const content = element("div", "content");
    const top = element("div", "topline");
    const heading = element("div");
    heading.append(
      element("h2", "module", candidate.title),
      element("code", "template-id", candidate.templateId),
      element(
        "span",
        `source source-${candidate.providerId === "org.scientificfigurelibrary.local" ? "local" : "external"}`,
        candidate.sourceLabel,
      ),
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
      candidate.executionStatus,
      candidate.exactSelector.kind,
      candidate.management.adapter,
      candidate.management.galleryId ? `gallery:${candidate.management.galleryId}` : "",
      candidate.management.registrySourceId
        ? `source:${candidate.management.registrySourceId}`
        : "",
      ...candidate.inputFiles.slice(0, 3),
      ...candidate.packages.slice(0, 3).map((name) => `pkg:${name}`),
    ].filter((value): value is string => Boolean(value));
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
