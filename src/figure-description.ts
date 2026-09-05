import MarkdownIt from "markdown-it";

// The original Markdown is authoritative. This parser is only used for search
// projections and conservative, read-only compatibility with old revisions.
const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false });

export function markdownPlainText(value: string): string {
  const parts: string[] = [];
  const visit = (tokens: ReturnType<MarkdownIt["parse"]>) => {
    for (const token of tokens) {
      if (token.children) visit(token.children);
      else if (["text", "code_inline", "code_block", "fence"].includes(token.type)) parts.push(token.content);
      else if (token.type === "softbreak" || token.type === "hardbreak" || token.block) parts.push(" ");
    }
  };
  visit(markdown.parse(value, {}));
  return parts.join("").replace(/\s+/gu, " ").trim();
}

export interface FigureDescription {
  description: string;
  application: string;
  applicationOrigin: "explicit" | "legacy_description" | "missing";
}

const SCENARIO_HEADING = /^(?:使用场景|适用场景|应用场景|recommended\s+use|application(?:\s+scenarios?)?|usage\s+scenarios?)(?:\s*[（(][^\n]*[)）])?\s*[:：]?$/iu;
const OTHER_SECTION = /^(?:视觉结构|视觉特征|数据特征|数据要求|输入(?:文件|要求|说明)?|来源|验证状态|visual\s+(?:structure|profile)|data(?:\s+profile)?|inputs?|source|references?|provenance)(?:\s*[（(][^\n]*[)）])?\s*[:：]?$/iu;

/** Never reads arbitrary reference files or rewrites an immutable revision. */
export function resolveFigureDescription(description: string, application?: string): FigureDescription {
  if (application?.trim()) return { description, application, applicationOrigin: "explicit" };
  const lines = description.split(/\r?\n/u);
  let fence: string | undefined;
  let start = -1;
  let contentStart = -1;
  let level = 0;
  let end = lines.length;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    const marker = line.match(/^(`{3,}|~{3,})/u)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*$/u);
    const label = (heading?.[2] ?? line).replace(/^\*\*(.*?)\*\*$/u, "$1").trim();
    if (start < 0) {
      if (SCENARIO_HEADING.test(label)) {
        start = i;
        contentStart = i + 1;
        level = heading?.[1]?.length ?? 0;
      } else if (/^(?:场景[一二三四五六七八九十\d]+|scenario\s+\d+)\s*[:：]/iu.test(line)) {
        start = i;
        contentStart = i;
      }
    } else if (OTHER_SECTION.test(label) || (heading && level > 0 && heading[1]!.length <= level)) {
      end = i;
      break;
    }
  }
  const extracted = start < 0 ? "" : lines.slice(contentStart, end).join("\n").trim();
  if (!extracted) return { description, application: "", applicationOrigin: "missing" };
  return {
    description: [...lines.slice(0, start), ...lines.slice(end)].join("\n").trim(),
    application: extracted,
    applicationOrigin: "legacy_description",
  };
}

export function figureDescriptionMarkdown(input: {
  title: string; description: string; application: string; dataProfile: string;
}) {
  return [
    `# ${input.title}`,
    ...(input.description.trim() ? ["## 需求描述", input.description.trim()] : []),
    "## 应用场景", input.application.trim() || "未单独记录。",
    ...(input.dataProfile.trim() ? ["## 数据特征", input.dataProfile.trim()] : []),
  ].join("\n\n") + "\n";
}
