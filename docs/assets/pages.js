const I18N = {
  "zh": {
    "skip": "跳至主要内容",
    "nav.features": "功能",
    "nav.workflow": "使用流程",
    "nav.install": "安装",
    "nav.faq": "常见问题",
    "nav.download": "获取插件",
    "hero.eyebrow": "开源 · 本机优先 · MCP App",
    "hero.title": "让每一张好图，<br>成为下一次研究的起点。",
    "hero.lead": "把科学图、绘图代码与方法说明，收进你自己的本机图库。审阅、发布，再带到下一个项目，让已经打磨好的图形与风格持续复用。",
    "hero.download": "获取最新插件",
    "hero.start": "快速开始",
    "hero.source": "查看源码",
    "gallery.caption": "浏览本机已发布的模板，预览并确认后，将选中的图与代码带入项目。",
    "hosts.title": "在熟悉的科研与编程工具里使用",
    "001.label": "为长期积累而设计",
    "features.title": "自己的图库，越用越有价值。",
    "features.body": "把一次作图的成果，变成有来源、可审阅、能再次使用的研究资产。",
    "feature.local.title": "一份图库，留在本机",
    "feature.local.body": "自行指定全局图库目录，集中保存不同项目的图形与代码。备份这份目录，就能带走已发布的版本。",
    "feature.review.title": "审阅之后，再放心复用",
    "feature.review.body": "将图、代码和方法说明一起整理，记录验证情况，再发布为不可变版本。下次使用时，清楚知道自己选中了什么。",
    "feature.reuse.title": "选中哪张，就带走哪张",
    "feature.reuse.body": "在交互式图库里预览模板，确认后将所选版本复制到项目。保留来源与版本记录，让后续修改有迹可循。",
    "002.label": "从一张图到下一次复用",
    "workflow.title": "把好用的方法，一起留下。",
    "workflow.body": "导入、审阅、发布、复用。让每张图不仅有结果，也有可以继续工作的起点。",
    "step.1.title": "导入图与代码",
    "step.1.body": "收集图形、源代码和方法说明，整理到本机图库。",
    "step.2.title": "审阅与记录",
    "step.2.body": "检查模板与文件，记录绘图验证情况及适用条件。",
    "step.3.title": "发布固定版本",
    "step.3.body": "将审阅后的内容发布为可追溯的不可变版本。",
    "step.4.title": "在新项目中复用",
    "step.4.body": "预览并确认具体模板，将所需文件复制到项目中。",
    "workflow.note": "图与代码保存在一起；实际绘图由宿主在你批准的 R / Python 环境中完成。",
    "003.label": "几步开始使用",
    "install.title": "接入工具，打开你的图库。",
    "install.body": "需要 Node.js 22+ 和支持 stdio MCP 的宿主。可以从发布页获取插件，也可以从源码构建。",
    "install.1.title": "安装插件或构建源码",
    "install.1.body": "Wisp Science 可在「设置 → 插件」中安装 ZIP；其他宿主的安装方式见快速开始。",
    "install.2.title": "指定两个本机目录",
    "install.2.body": "分别绑定全局图库与本地工作区；由你选择实际路径。",
    "install.3.title": "打开图库，导入第一张图",
    "install.3.body": "在宿主中打开 Scientific Figure Library，导入图与代码，审阅后发布。",
    "install.guide": "阅读完整安装指南",
    "install.code": "从源码构建",
    "copy.label": "复制命令",
    "install.codeNote": "构建后，在 release/ 中找到 Wisp 插件 ZIP。通用 MCP 入口为 dist/index.js。",
    "004.label": "一些常见问题",
    "faq.title": "开始之前，<br>你可能想知道。",
    "faq.body": "更多技术细节，可查看项目文档与协议说明。",
    "faq.docs": "查看协议文档",
    "faq.1.q": "图和代码保存在什么地方？",
    "faq.1.a": "保存在你指定的本机全局图库目录。已发布的版本可跨项目使用；本地工作区用于工作内容。调用远程模型或在线服务时，相关数据处理范围取决于宿主、服务与任务配置。",
    "faq.2.q": "它会自动运行绘图脚本吗？",
    "faq.2.a": "不会。Scientific Figure Library 负责整理、检索、预览和复制模板。实际绘图需要由宿主在你批准的 R / Python 环境中执行。",
    "faq.3.q": "支持哪些工具？",
    "faq.3.a": "支持 Wisp Science、Claude Science、Codex、Cursor 等宿主，也可配置为通用 stdio MCP 服务。交互式图库需要宿主支持 MCP Apps。",
    "faq.4.q": "能使用外部模板吗？",
    "faq.4.a": "可以。默认先检索本机已发布内容，再检索 FigureYa、Open Figure Modules 与已启用的动态个人 Provider。预览并确认具体模板后，再将所选文件带入项目。",
    "faq.5.q": "代码与图形分别遵循什么许可？",
    "faq.5.a": "仓库代码采用 MIT 许可证。用户导入的图形保留导入时记录的许可证；复用模板时，请核对对应来源与许可。",
    "footer.releases": "版本记录",
    "footer.issues": "问题反馈",
    "footer.note": "代码 MIT · 导入图形保留其记录的许可证。",
    "meta.title": "Scientific Figure Library | 让好图成为下一次研究的起点",
    "meta.desc": "把科学图、代码与方法保存在本机，在不同项目中复用。Scientific Figure Library 是开源、本机优先的 MCP 服务与交互式图库。",
    "nav.aria": "页面导航",
    "lang.aria": "语言",
    "footer.aria": "项目链接",
    "gallery.alt": "科学图库预览：热图、火山图、生存曲线、t-SNE、Oncoplot 和 Circos 模板",
    "copy.success": "命令已复制",
    "copy.error": "无法自动复制，请选择上方命令手动复制。",
    "nav.gallery": "图库",
    "nav.home": "首页",
    "gallery.meta.title": "Figure Gallery | Scientific Figure Library",
    "gallery.meta.desc": "浏览 Open Figure Modules 科学图形模板：UMAP、热图、富集分析、系统发育树等，附预览、代码与来源。",
    "gallery.kicker": "开放的科学图形模板",
    "gallery.title": "为下一张图，找到灵感。",
    "gallery.lead": "来自 Open Figure Modules 的可复用图形模板。按类型浏览，查看预览与代码，把合适的方法带到自己的研究中。",
    "gallery.repository": "访问图库仓库",
    "gallery.use": "在 SFL 中使用",
    "gallery.sourceLabel": "图库来源",
    "gallery.sourceNote": "已作为 Open Figure Modules 接入 SFL，可在应用内检索。",
    "gallery.maintainers": "共同维护：jarxunlai 与 xuzhougeng",
    "gallery.search": "搜索图名、方法或 R 包",
    "gallery.searchPlaceholder": "试试 UMAP、KEGG、ggtree…",
    "gallery.filters": "按图形类型筛选",
    "gallery.all": "全部图形",
    "gallery.embedding": "UMAP / PCA",
    "gallery.heatmap": "热图与矩阵",
    "gallery.enrichment": "富集分析",
    "gallery.composition": "组成与比较",
    "gallery.genomics": "系统发育与基因组",
    "gallery.relationships": "关系与网络",
    "gallery.expression": "表达与分布",
    "gallery.count": "显示 {shown} / {total} 个图形",
    "gallery.loading": "正在加载图形目录…",
    "gallery.error": "图形目录暂时无法加载，请重试或访问源仓库。",
    "gallery.retry": "重新加载",
    "gallery.empty": "没有找到匹配的图形",
    "gallery.emptyHelp": "试试其他关键词，或清除搜索与筛选。",
    "gallery.reset": "清除筛选",
    "gallery.view": "查看图形",
    "gallery.close": "关闭预览",
    "gallery.description": "模块说明",
    "gallery.data": "数据要求",
    "gallery.packages": "依赖包",
    "gallery.license": "许可",
    "gallery.codeLicense": "代码",
    "gallery.contentLicense": "图形内容",
    "gallery.docsLicense": "文档",
    "gallery.module": "查看模块",
    "gallery.code": "查看绘图代码",
    "gallery.fullImage": "打开原始预览",
    "gallery.previewNote": "完整尺寸图像可通过「打开原始预览」查看。",
    "gallery.imageFallback": "当前显示缩略图，可通过源仓库查看原始预览。",
    "gallery.credit": "图形与说明来自 Open Figure Modules，各模块的内容与代码许可见详情。预览用于展示绘图方法，具体数据来源见原模块。",
    "gallery.snapshot": "目录快照",
    "gallery.homeTitle": "从开放图库，找到下一张图。",
    "gallery.homeBody": "Open Figure Modules 收录了热图、UMAP、富集分析与系统发育树等模板。每张图都附有预览、绘图代码和许可说明。",
    "gallery.browse": "浏览 Figure Gallery",
    "gallery.feature1": "通路 NES 热图",
    "gallery.feature2": "环形 UMAP",
    "gallery.feature3": "系统发育环形树"
  },
  "en": {
    "skip": "Skip to content",
    "nav.features": "Features",
    "nav.workflow": "Workflow",
    "nav.install": "Install",
    "nav.faq": "FAQ",
    "nav.download": "Get plugin",
    "hero.eyebrow": "Open source · Local first · MCP App",
    "hero.title": "Good figures.<br>A head start for your next study.",
    "hero.lead": "Keep scientific figures, plotting code, and methods together in your own local library. Review, publish, and bring them into your next project, building on the figures and styles you have already refined.",
    "hero.download": "Get the latest plugin",
    "hero.start": "Quick start",
    "hero.source": "View source",
    "gallery.caption": "Browse locally published templates. Preview and confirm a figure, then bring its files and code into your project.",
    "hosts.title": "At home in your research and coding tools",
    "001.label": "Built for a growing library",
    "features.title": "Your library gets better with every project.",
    "features.body": "Turn a finished figure into a research asset with its source, review record, and files ready for reuse.",
    "feature.local.title": "One library, on your machine",
    "feature.local.body": "Choose a global library directory to keep figures and code from different projects together. Back up that folder to take your published releases with you.",
    "feature.review.title": "Review once. Reuse with context.",
    "feature.review.body": "Organize figures, code, and methods, record their validation status, and publish an immutable release. Know exactly what you are choosing next time.",
    "feature.reuse.title": "Choose a figure. Take what you need.",
    "feature.reuse.body": "Preview templates in the interactive gallery, then copy the confirmed release into your project. Keep its source and version record alongside your changes.",
    "002.label": "From one figure to the next project",
    "workflow.title": "Keep the method with the figure.",
    "workflow.body": "Import, review, publish, reuse. Keep both the result and a starting point for your next piece of work.",
    "step.1.title": "Import your work",
    "step.1.body": "Collect figures, source code, and methods in your local library.",
    "step.2.title": "Review and document",
    "step.2.body": "Inspect the template and files, and record plot validation and intended use.",
    "step.3.title": "Publish a release",
    "step.3.body": "Publish the reviewed content as a traceable, immutable release.",
    "step.4.title": "Reuse in a new project",
    "step.4.body": "Preview and confirm a specific template, then copy its files into your project.",
    "workflow.note": "Figures and code stay together; plotting runs through your host in the R / Python environment you approve.",
    "003.label": "Get started in a few steps",
    "install.title": "Connect your tools. Open your library.",
    "install.body": "You need Node.js 22+ and a host that supports stdio MCP. Get a plugin from Releases or build from source.",
    "install.1.title": "Install a plugin or build from source",
    "install.1.body": "In Wisp Science, install the ZIP under Settings → Plugins. See the quick start for other hosts.",
    "install.2.title": "Choose two local directories",
    "install.2.body": "Bind a global Library and a Local workspace, each using a path you choose.",
    "install.3.title": "Open the gallery and import a figure",
    "install.3.body": "Open Scientific Figure Library in your host, import a figure and its code, then review and publish.",
    "install.guide": "Read the installation guide",
    "install.code": "Build from source",
    "copy.label": "Copy commands",
    "install.codeNote": "After building, find the Wisp plugin ZIP in release/. The standard MCP entry point is dist/index.js.",
    "004.label": "A few common questions",
    "faq.title": "Before you begin.",
    "faq.body": "Find more technical details in the project documentation and protocol.",
    "faq.docs": "Read the protocol",
    "faq.1.q": "Where are my figures and code stored?",
    "faq.1.a": "In the global Library directory you choose on your machine. Published releases can be reused across projects; the Local workspace holds working content. When you use remote models or online services, data handling depends on your host, service, and task configuration.",
    "faq.2.q": "Does it run plotting scripts automatically?",
    "faq.2.a": "No. Scientific Figure Library organizes, searches, previews, and copies templates. Your host executes plotting code in an R / Python environment you approve.",
    "faq.3.q": "Which tools can I use it with?",
    "faq.3.a": "Use it with Wisp Science, Claude Science, Codex, Cursor, or configure it as a standard stdio MCP server. The interactive gallery requires a host with MCP Apps support.",
    "faq.4.q": "Can I use external templates?",
    "faq.4.a": "Yes. Search starts with Local Published, followed by FigureYa, Open Figure Modules, and enabled dynamic personal providers. Preview and confirm a specific template before bringing its files into a project.",
    "faq.5.q": "How are the code and figures licensed?",
    "faq.5.a": "The repository code is MIT-licensed. Imported figures retain the license recorded at import. Check the source and license of each template before reuse.",
    "footer.releases": "Releases",
    "footer.issues": "Issues",
    "footer.note": "Code under MIT · Imported figures retain their recorded licenses.",
    "meta.title": "Scientific Figure Library | A head start for your next study",
    "meta.desc": "Keep scientific figures, code, and methods on your machine and reuse them across projects. Scientific Figure Library is an open-source, local-first MCP server and interactive gallery.",
    "nav.aria": "Page navigation",
    "lang.aria": "Language",
    "footer.aria": "Project links",
    "gallery.alt": "Scientific figure gallery showing heatmap, volcano plot, survival curve, t-SNE, Oncoplot, and Circos templates",
    "copy.success": "Commands copied",
    "copy.error": "Could not copy automatically. Select and copy the commands above.",
    "nav.gallery": "Gallery",
    "nav.home": "Home",
    "gallery.meta.title": "Figure Gallery | Scientific Figure Library",
    "gallery.meta.desc": "Explore Open Figure Modules: scientific figure templates with previews, plotting code, and source attribution.",
    "gallery.kicker": "An open collection of scientific figures",
    "gallery.title": "Find a starting point for your next figure.",
    "gallery.lead": "Reusable figure templates from Open Figure Modules. Explore by type, inspect the preview and code, and bring the right method into your research.",
    "gallery.repository": "Explore the repository",
    "gallery.use": "Use with SFL",
    "gallery.sourceLabel": "Library source",
    "gallery.sourceNote": "Available in SFL as Open Figure Modules. Search for these templates in the app.",
    "gallery.maintainers": "Maintained by jarxunlai and xuzhougeng",
    "gallery.search": "Search figures, methods, or R packages",
    "gallery.searchPlaceholder": "Try UMAP, KEGG, ggtree…",
    "gallery.filters": "Filter by figure type",
    "gallery.all": "All figures",
    "gallery.embedding": "UMAP / PCA",
    "gallery.heatmap": "Heatmaps & matrices",
    "gallery.enrichment": "Enrichment",
    "gallery.composition": "Composition & comparison",
    "gallery.genomics": "Phylogeny & genomics",
    "gallery.relationships": "Relationships & networks",
    "gallery.expression": "Expression & distributions",
    "gallery.count": "Showing {shown} of {total} figures",
    "gallery.loading": "Loading figure catalog…",
    "gallery.error": "The figure catalog could not be loaded. Retry or visit the source repository.",
    "gallery.retry": "Try again",
    "gallery.empty": "No matching figures",
    "gallery.emptyHelp": "Try a different keyword, or clear the search and filters.",
    "gallery.reset": "Clear filters",
    "gallery.view": "View figure",
    "gallery.close": "Close preview",
    "gallery.description": "Module description",
    "gallery.data": "Input data",
    "gallery.packages": "Packages",
    "gallery.license": "Licenses",
    "gallery.codeLicense": "Code",
    "gallery.contentLicense": "Content",
    "gallery.docsLicense": "Documentation",
    "gallery.module": "View module",
    "gallery.code": "View plotting code",
    "gallery.fullImage": "Open original preview",
    "gallery.previewNote": "Use Open original preview to view the full-size source image.",
    "gallery.imageFallback": "Showing the thumbnail. Open the source repository for the original preview.",
    "gallery.credit": "Figures and descriptions are from Open Figure Modules. See each module for content and code licenses. Previews illustrate plotting methods; consult the source module for data provenance.",
    "gallery.snapshot": "Catalog snapshot",
    "gallery.homeTitle": "Find your next figure in an open library.",
    "gallery.homeBody": "Open Figure Modules includes heatmaps, UMAPs, enrichment plots, phylogenetic trees, and more. Each module includes a preview, plotting code, and license information.",
    "gallery.browse": "Browse Figure Gallery",
    "gallery.feature1": "Pathway NES heatmap",
    "gallery.feature2": "Circular UMAP",
    "gallery.feature3": "Circular phylogenetic tree"
  }
};
const KEY = "sfl-pages-lang";
function lang() {
  const query = new URLSearchParams(location.search).get("lang");
  if (query === "en" || query === "zh") return query;
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === "en" || stored === "zh") return stored;
  } catch { /* Storage can be disabled by the host browser. */ }
  return "zh";
}
function apply(current) {
  const pack = I18N[current] || I18N.zh;
  document.documentElement.lang = current === "en" ? "en" : "zh-CN";
  document.documentElement.dataset.lang = current;
  const meta = document.documentElement.dataset.page === "gallery" ? "gallery.meta" : "meta";
  document.title = pack[`${meta}.title`];
  document.querySelector('meta[name="description"]').setAttribute("content", pack[`${meta}.desc`]);
  for (const [attribute, target] of [["data-i18n", "textContent"], ["data-i18n-html", "innerHTML"]]) {
    document.querySelectorAll(`[${attribute}]`).forEach((element) => {
      const value = pack[element.getAttribute(attribute)];
      if (value != null) element[target] = value;
    });
  }
  for (const [attribute, target] of [["data-i18n-aria", "aria-label"], ["data-i18n-alt", "alt"], ["data-i18n-placeholder", "placeholder"]]) {
    document.querySelectorAll(`[${attribute}]`).forEach((element) => {
      const value = pack[element.getAttribute(attribute)];
      if (value != null) element.setAttribute(target, value);
    });
  }
  document.querySelectorAll(".lang-switch [data-lang]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.lang === current));
  });
  document.querySelectorAll(".copy-status").forEach(element => { element.textContent = ""; });
  document.querySelectorAll("[data-page-link]").forEach(link => {
    const destination = new URL(link.getAttribute("href"), location.href);
    destination.searchParams.set("lang", current);
    link.setAttribute("href", destination.pathname.split("/").pop() + destination.search + destination.hash);
  });
  document.dispatchEvent(new CustomEvent("sfl:languagechange", { detail: current }));
}
function setLang(next) {
  try { localStorage.setItem(KEY, next); } catch { /* Language still updates without storage. */ }
  const url = new URL(location.href);
  url.searchParams.set("lang", next);
  history.replaceState(null, "", url);
  apply(next);
}
apply(lang());
document.querySelectorAll(".lang-switch [data-lang]").forEach((button) => {
  button.addEventListener("click", () => setLang(button.dataset.lang));
});
document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", async () => {
    const content = document.getElementById(button.dataset.copy).textContent;
    let message = "copy.success";
    try { await navigator.clipboard.writeText(content); }
    catch { message = "copy.error"; }
    document.querySelector(".copy-status").textContent = I18N[lang()][message];
  });
});
