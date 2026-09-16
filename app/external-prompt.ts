import { formatCatalogProse } from "../src/catalog-prose.ts";
import type { Candidate } from "./view.ts";

function line(label: string, value: string | undefined) {
  const text = value?.trim();
  return text ? `${label}：${text}` : undefined;
}

function list(label: string, values: string[] | undefined) {
  const items = (values ?? []).map((item) => item.trim()).filter(Boolean);
  if (!items.length) return undefined;
  return [`${label}：`, ...items.map((item) => `- ${item}`)].join("\n");
}

function candidateBlock(candidate: Candidate, index: number) {
  const description = formatCatalogProse(candidate.description || candidate.excerpt || "");
  const application = formatCatalogProse(candidate.application ?? "");
  const dataProfile = formatCatalogProse(candidate.dataProfile ?? "");
  return [
    `## ${index + 1}. ${candidate.title}`,
    line("来源", candidate.sourceLabel),
    line("模板", candidate.templateId),
    line("类型", [candidate.assetKind, candidate.language, candidate.plotFamily].filter(Boolean).join(" · ")),
    description ? `需求描述：\n${description}` : undefined,
    application ? `应用场景：\n${application}` : undefined,
    dataProfile ? `数据特征：\n${dataProfile}` : undefined,
    list("输入文件", candidate.inputFiles),
    list("代码文件", candidate.codeFiles),
    list("依赖包", candidate.packages),
  ].filter(Boolean).join("\n");
}

export function buildExternalPlotPrompt(candidates: Candidate[]) {
  const items = candidates.filter((candidate) => candidate.title.trim());
  if (!items.length) return "";
  return [
    "请根据下面这些科学绘图模板，帮我写出可运行的绘图代码。不需要安装 Scientific Figure Library、MCP 或 Skill。",
    "",
    "要求：",
    "- 按每个模板的图类型、应用场景和数据特征来画，不要编造论文结果。",
    "- 如果我还没提供数据，先列出每个图需要的输入表，再用示例或占位数据给出完整代码。",
    "- 保持原模板的视觉结构：坐标轴、分组、图例和配色逻辑。",
    "- 使用列出的语言和依赖包；每个图单独一个脚本或代码块，并注明对应模板名称。",
    "- 不要执行未知下载，也不要声称已经画过或验证过这些图。",
    "",
    ...items.map((candidate, index) => candidateBlock(candidate, index)),
  ].join("\n");
}
