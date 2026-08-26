const I18N = {
  zh: {
    "meta.title": "Scientific Figure Library | 本机科学图库",
    "meta.desc": "本机优先的科学图 MCP App：导入、审阅、发布到你磁盘上的全局 Library，再在 Claude Science 与 Wisp Science 里跨项目复用。",
    "nav.features": "功能",
    "nav.install": "安装",
    "nav.docs": "协议",
    "nav.github": "GitHub",
    "nav.release": "Releases",
    "lang.aria": "语言",
    "hero.eyebrow": "Local first · MCP App · Claude Science · Wisp Science",
    "hero.title": "你的科学图<br>留在本机一份库里",
    "hero.lead": "导入图和代码，审阅后发布成不可变 Release。一份全局 Library 跨项目复用。服务器不执行绘图脚本。可选外部目录只是补充，权威始终是 Local Published。",
    "hero.cta": "查看 Releases",
    "hero.source": "源码",
    "shot.caption": "在 MCP App 里浏览本机已发布模板，确认后再物化到项目。",
    "feat.kicker": "Features",
    "feat.heading": "本机优先的图库",
    "feat.local.title": "本机全局 Library",
    "feat.local.body": "目录由你指定。不会悄悄写进当前项目。备份这份磁盘目录即可带走全部 Release。",
    "feat.review.title": "审阅再发布",
    "feat.review.body": "图与代码分开记录。作图是否跑过、上游流程、科学判断是三件独立的事。",
    "feat.reuse.title": "精确物化",
    "feat.reuse.body": "预览、确认、plan、apply。只有你点过的那一张会进项目，不会整库下载。",
    "install.kicker": "Install",
    "install.heading": "接到 MCP 宿主",
    "install.s1": "Node.js 22+。clone 后 npm ci && npm run check。",
    "install.s2": "stdio MCP 名称 figure-library，入口 dist/index.js。",
    "install.s3": "Wisp Science：npm run package:wisp，安装 release/ 里的 ZIP。",
    "install.s4": "先绑定一个本机全局 Library 目录，再导入或检索 Local Published。",
    "tools.heading": "主要工具",
    "tools.bind": "选择本机 Library 目录",
    "tools.open": "打开 MCP App",
    "tools.search": "检索 Local Published",
    "tools.publish": "发布 Release",
    "footer.note": "代码 MIT。用户导入的图保留导入时记录的许可证。",
  },
  en: {
    "meta.title": "Scientific Figure Library | local-first figure MCP App",
    "meta.desc": "Local-first MCP App for your scientific figures. Import, review, and publish a global library on disk; reuse exact templates in Claude Science and Wisp Science.",
    "nav.features": "Features",
    "nav.install": "Install",
    "nav.docs": "Protocol",
    "nav.github": "GitHub",
    "nav.release": "Releases",
    "lang.aria": "Language",
    "hero.eyebrow": "Local first · MCP App · Claude Science · Wisp Science",
    "hero.title": "Your figures,<br>one library on disk",
    "hero.lead": "Import a figure and its code, review them, and publish an immutable Release. One global Library is reused across projects. The server never runs plot scripts. Extra catalogs are optional; Local Published stays authoritative.",
    "hero.cta": "View Releases",
    "hero.source": "Source",
    "shot.caption": "Browse locally published templates in the MCP App, then confirm one exact Release.",
    "feat.kicker": "Features",
    "feat.heading": "A library that stays on your machine",
    "feat.local.title": "Global library on disk",
    "feat.local.body": "You choose the directory. SFL does not silently use the current project. Back up that folder to take every Release with you.",
    "feat.review.title": "Review, then publish",
    "feat.review.body": "Figure and code are recorded separately. Plot execution, upstream workflow, and scientific judgment are three distinct claims.",
    "feat.reuse.title": "Exact materialize",
    "feat.reuse.body": "Preview, confirm, plan, apply. Only the card you confirmed is copied into a project.",
    "install.kicker": "Install",
    "install.heading": "Connect it to an MCP host",
    "install.s1": "Node.js 22+. Clone, then npm ci && npm run check.",
    "install.s2": "stdio MCP name figure-library, entry dist/index.js.",
    "install.s3": "Wisp Science: npm run package:wisp, then install the ZIP in release/.",
    "install.s4": "Bind one absolute global Library directory, then import or search Local Published.",
    "tools.heading": "Main tools",
    "tools.bind": "Choose the local Library directory",
    "tools.open": "Open the MCP App",
    "tools.search": "Search Local Published",
    "tools.publish": "Publish a Release",
    "footer.note": "Code is MIT. User-imported figures keep the license recorded at import.",
  },
};

const KEY = "sfl-pages-lang";

function lang() {
  const q = new URLSearchParams(location.search).get("lang");
  if (q === "en" || q === "zh") return q;
  try {
    const stored = localStorage.getItem(KEY);
    if (stored === "en" || stored === "zh") return stored;
  } catch {
    /* ignore */
  }
  return "zh";
}

function apply(current) {
  const pack = I18N[current] || I18N.zh;
  document.documentElement.lang = current === "en" ? "en" : "zh-CN";
  document.documentElement.dataset.lang = current;
  document.title = pack["meta.title"];
  document.querySelector('meta[name="description"]')?.setAttribute("content", pack["meta.desc"]);
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    if (pack[el.dataset.i18n] != null) el.textContent = pack[el.dataset.i18n];
  });
  document.querySelectorAll("[data-i18n-html]").forEach((el) => {
    if (pack[el.dataset.i18nHtml] != null) el.innerHTML = pack[el.dataset.i18nHtml];
  });
  document.querySelectorAll(".lang-switch [data-lang]").forEach((btn) => {
    btn.setAttribute("aria-pressed", btn.dataset.lang === current ? "true" : "false");
  });
  document.documentElement.classList.add("i18n-ready");
}

function setLang(next) {
  try { localStorage.setItem(KEY, next); } catch { /* ignore */ }
  const url = new URL(location.href);
  url.searchParams.set("lang", next);
  history.replaceState(null, "", url);
  apply(next);
}

document.addEventListener("DOMContentLoaded", () => {
  apply(lang());
  document.querySelectorAll(".lang-switch [data-lang]").forEach((btn) => {
    btn.addEventListener("click", () => setLang(btn.dataset.lang));
  });
});
