export const PLOTTING_EXAMPLE = "使用已选模板和这份数据，生成用于 A4 PPT 拼版的子图，宽 85 mm，统一 Arial，同组同色；导出 PDF 和 600 DPI PNG，并检查文字重叠、裁切和字体是否生效。其他样式保留模板设置。";

export function mountPlottingTips(document: Document, parent: HTMLElement, options: {
  storage?: Pick<Storage, "getItem" | "setItem">;
  copy: (text: string) => Promise<void>;
}) {
  const tips = document.createElement("details");
  tips.className = "plotting-tips";
  let collapsed = false;
  try { collapsed = options.storage?.getItem("sfl.plotting-tips.collapsed") === "true"; } catch { /* Restricted host storage. */ }
  tips.open = !collapsed;
  const summary = document.createElement("summary");
  summary.textContent = "科研绘图提示 · 自然语言就能表达需求";
  tips.append(summary);
  for (const text of [
    "可以告诉模型：图的用途或期刊要求、数据文件与列名、分组及单位、最终宽高（mm/cm）、字体字号、分组配色、线宽、输出格式与 DPI。可提供参考图；没有特殊要求可沿用模板，不必一次填齐。",
    "按最终放置尺寸出图，同一实验组跨图保持同色。请说明线宽指坐标轴、图例框还是整图外框。示例数值不是通用投稿标准，不能为了美观改变数据或统计含义。",
    "字体需检查是否安装；导出格式取决于绘图后端。PDF/SVG 矢量内容与 PNG 栅格 DPI 不同，提高低分辨率图片的 DPI 数值不会增加细节。交付前检查文字裁切、重叠、图例颜色和单位。",
    "选择模板只在本界面标记；宿主的工具运行审批不代表已选模板。确认已选计数后，点击“交给 Agent 绘制”。",
    "想跨会话沿用规范，可以说“记住我的实验室绘图规范：Arial，A 组蓝色、B 组橙色，宽 85 mm，导出 PDF 和 600 DPI PNG”。也可查看、修改或重置；说“仅这次宽 100 mm”不会改写长期规范。",
  ]) {
    const paragraph = document.createElement("p"); paragraph.textContent = text; tips.append(paragraph);
  }
  const example = document.createElement("blockquote"); example.textContent = PLOTTING_EXAMPLE;
  const copy = document.createElement("button"); copy.type = "button"; copy.textContent = "复制示例";
  const status = document.createElement("span"); status.setAttribute("role", "status");
  copy.addEventListener("click", async () => {
    copy.disabled = true;
    try { await options.copy(PLOTTING_EXAMPLE); status.textContent = "已复制，可在对话中修改后使用。"; }
    catch { status.textContent = "无法访问剪贴板，请选中上方示例手动复制。"; }
    finally { copy.disabled = false; }
  });
  tips.addEventListener("toggle", () => {
    try { options.storage?.setItem("sfl.plotting-tips.collapsed", String(!tips.open)); } catch { /* Optional preference. */ }
  });
  tips.append(example, copy, status); parent.append(tips);
  return tips;
}
