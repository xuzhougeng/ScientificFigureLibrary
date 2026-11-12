import {
  extractImagePalette,
  formatColors,
  sampleColor,
  type CodeColorReport,
  type ColorCopyFormat,
  type RgbaImage,
} from "../../src/color-palette.ts";

/** Code colours as returned by `/api/reference-colors`. */
export interface ReferenceCodeColors extends CodeColorReport {
  source: "reference_pack" | "catalog_text" | "unavailable";
  files: string[];
  canCache: boolean;
}

const FORMAT_KEY = "sfl-color-format";
const FORMAT_LABELS: Array<[ColorCopyFormat, string]> = [["hex", "HEX"], ["r", "R 向量"], ["python", "Python 列表"]];
const MAX_PICKED = 12;
const LOUPE_PIXELS = 11;
const LOUPE_SCALE = 10;

function readFormat(): ColorCopyFormat {
  try {
    const stored = localStorage.getItem(FORMAT_KEY);
    if (stored === "r" || stored === "python" || stored === "hex") return stored;
  } catch { /* Storage may be unavailable. */ }
  return "hex";
}

/** Dark text on light colours and light text on dark ones. */
function inkFor(hex: string) {
  const value = Number.parseInt(hex.slice(1), 16);
  const luminance = 0.2126 * ((value >> 16) & 255) + 0.7152 * ((value >> 8) & 255) + 0.0722 * (value & 255);
  return luminance > 150 ? "#1d2a23" : "#ffffff";
}

function imagePixels(document: Document, image: HTMLImageElement): RgbaImage | undefined {
  if (!image.complete || !image.naturalWidth) return undefined;
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return undefined;
  try {
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    return { width: pixels.width, height: pixels.height, data: pixels.data };
  } catch {
    // A cross-origin image would taint the canvas; local previews are same-origin or data URLs.
    return undefined;
  }
}

/**
 * Mount the colour panel of a reference detail view: the dominant colours of
 * the displayed image, an eyedropper on that image, and the colours written in
 * the reference's code. Everything runs locally; no model is involved.
 */
export function mountColorPanel(options: {
  document: Document;
  /** The element that holds the preview `<img>`; it may be replaced when the exact image arrives. */
  preview: HTMLElement;
  loadCodeColors: () => Promise<ReferenceCodeColors>;
  /** Fetch the fixed-version reference pack, then call `done` so code colours reload. */
  onCacheCode?: (done: () => void) => void;
  hasCode: boolean;
}) {
  const { document, preview } = options;
  const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const panel = make("section", "color-panel detail-section");
  panel.setAttribute("aria-label", "配色");
  const header = make("div", "color-panel-header");
  const status = make("span", "color-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const formatPicker = make("select", "color-format");
  formatPicker.setAttribute("aria-label", "复制格式");
  for (const [value, label] of FORMAT_LABELS) {
    const option = make("option", undefined, label);
    option.value = value;
    formatPicker.append(option);
  }
  formatPicker.value = readFormat();
  formatPicker.addEventListener("change", () => {
    try { localStorage.setItem(FORMAT_KEY, formatPicker.value); } catch { /* Storage may be unavailable. */ }
  });
  const formatLabel = make("label", "color-format-label", "复制为");
  formatLabel.append(formatPicker);
  header.append(make("h3", "detail-section-title", "配色"), status, formatLabel);

  const copy = async (colors: string[], what: string) => {
    if (!colors.length) return;
    const text = colors.length === 1 && formatPicker.value === "hex" ? colors[0]! : formatColors(colors, formatPicker.value as ColorCopyFormat);
    try {
      await navigator.clipboard.writeText(text);
      status.textContent = `已复制${what}：${text.length > 60 ? `${text.slice(0, 60)}…` : text}`;
    } catch {
      status.textContent = `无法写入剪贴板。${what}：${text}`;
    }
  };

  const swatch = (hex: string, detail?: string) => {
    const control = make("button", "color-swatch");
    control.type = "button";
    control.style.background = hex;
    control.style.color = inkFor(hex);
    control.textContent = hex;
    control.title = detail ? `${hex} · ${detail}（点击复制）` : `${hex}（点击复制）`;
    control.addEventListener("click", () => void copy([hex], "颜色"));
    return control;
  };
  const group = (title: string, hint?: string) => {
    const block = make("div", "color-group");
    const heading = make("div", "color-group-heading");
    heading.append(make("span", "color-group-title", title));
    if (hint) heading.append(make("span", "color-group-hint", hint));
    const row = make("div", "color-swatches");
    block.append(heading, row);
    return { block, heading, row };
  };
  const copyAll = (heading: HTMLElement, colors: () => string[], what: string) => {
    const control = make("button", "color-copy-all", "复制全部");
    control.type = "button";
    control.addEventListener("click", () => void copy(colors(), what));
    heading.append(control);
    return control;
  };

  // Image palette.
  const imageGroup = group("图片主色", "按面积从大到小");
  let imageColors: string[] = [];
  const copyImage = copyAll(imageGroup.heading, () => imageColors, "图片主色");
  const minor = make("div", "color-swatches color-swatches-minor");
  imageGroup.block.append(minor);

  // Eyedropper.
  const pickGroup = group("点击取色", "在上方图片上移动鼠标，点击取该点颜色");
  const pickToggle = make("button", "color-pick-toggle", "开始取色");
  pickToggle.type = "button";
  pickToggle.setAttribute("aria-pressed", "false");
  pickGroup.heading.append(pickToggle);
  let picked: string[] = [];
  const copyPicked = copyAll(pickGroup.heading, () => picked, "已取颜色");
  const loupe = make("div", "color-loupe");
  loupe.hidden = true;
  const loupeCanvas = make("canvas");
  loupeCanvas.width = LOUPE_PIXELS * LOUPE_SCALE;
  loupeCanvas.height = LOUPE_PIXELS * LOUPE_SCALE;
  const loupeLabel = make("span", "color-loupe-label");
  loupe.append(loupeCanvas, loupeLabel);

  // Code colours.
  const codeGroup = group("代码中的颜色");
  const codeNote = make("p", "color-note");
  const codeBody = make("div", "color-code-body");
  codeGroup.block.append(codeBody, codeNote);
  let codeColors: string[] = [];
  const copyCode = copyAll(codeGroup.heading, () => codeColors, "代码色值");

  panel.append(header, imageGroup.block, pickGroup.block, codeGroup.block);
  preview.after(panel);
  preview.append(loupe);

  let pixels: RgbaImage | undefined;
  let currentImage: HTMLImageElement | undefined;
  let picking = false;

  const renderPicked = () => {
    pickGroup.row.replaceChildren(...picked.map((hex) => swatch(hex)));
    copyPicked.hidden = picked.length === 0;
  };
  const setPicking = (value: boolean) => {
    picking = value && Boolean(pixels);
    pickToggle.setAttribute("aria-pressed", String(picking));
    pickToggle.textContent = picking ? "结束取色" : "开始取色";
    preview.classList.toggle("color-picking", picking);
    if (!picking) loupe.hidden = true;
  };
  const pointOf = (event: MouseEvent) => {
    if (!pixels || !currentImage) return undefined;
    const rect = currentImage.getBoundingClientRect();
    if (!rect.width || !rect.height) return undefined;
    const x = ((event.clientX - rect.left) / rect.width) * pixels.width;
    const y = ((event.clientY - rect.top) / rect.height) * pixels.height;
    if (x < 0 || y < 0 || x >= pixels.width || y >= pixels.height) return undefined;
    return { x: Math.floor(x), y: Math.floor(y) };
  };
  const drawLoupe = (x: number, y: number) => {
    const context = loupeCanvas.getContext("2d");
    if (!context || !pixels) return;
    const half = Math.floor(LOUPE_PIXELS / 2);
    for (let dy = -half; dy <= half; dy += 1) {
      for (let dx = -half; dx <= half; dx += 1) {
        const px = x + dx;
        const py = y + dy;
        const inside = px >= 0 && py >= 0 && px < pixels.width && py < pixels.height;
        const offset = (py * pixels.width + px) * 4;
        context.fillStyle = inside ? `rgb(${pixels.data[offset]},${pixels.data[offset + 1]},${pixels.data[offset + 2]})` : "#ffffff";
        context.fillRect((dx + half) * LOUPE_SCALE, (dy + half) * LOUPE_SCALE, LOUPE_SCALE, LOUPE_SCALE);
      }
    }
    context.strokeStyle = "#ffffff";
    context.lineWidth = 2;
    context.strokeRect((half - 1) * LOUPE_SCALE, (half - 1) * LOUPE_SCALE, LOUPE_SCALE * 3, LOUPE_SCALE * 3);
    context.strokeStyle = "#1d2a23";
    context.lineWidth = 1;
    context.strokeRect((half - 1) * LOUPE_SCALE - 1, (half - 1) * LOUPE_SCALE - 1, LOUPE_SCALE * 3 + 2, LOUPE_SCALE * 3 + 2);
  };
  const onMove = (event: MouseEvent) => {
    if (!picking) return;
    const point = pointOf(event);
    if (!point || !pixels) { loupe.hidden = true; return; }
    drawLoupe(point.x, point.y);
    loupeLabel.textContent = sampleColor(pixels, point.x, point.y, 1) ?? "";
    const box = preview.getBoundingClientRect();
    const size = LOUPE_PIXELS * LOUPE_SCALE;
    const left = event.clientX - box.left + preview.scrollLeft + 18;
    const top = event.clientY - box.top + preview.scrollTop + 18;
    loupe.style.left = `${Math.min(left, preview.scrollLeft + box.width - size - 12)}px`;
    loupe.style.top = `${Math.min(top, preview.scrollTop + box.height - size - 34)}px`;
    loupe.hidden = false;
  };
  const onClick = (event: MouseEvent) => {
    if (!picking || !pixels) return;
    const point = pointOf(event);
    if (!point) return;
    event.preventDefault();
    const hex = sampleColor(pixels, point.x, point.y, 1);
    if (!hex) return;
    picked = [hex, ...picked.filter((value) => value !== hex)].slice(0, MAX_PICKED);
    renderPicked();
    void copy([hex], "颜色");
  };
  preview.addEventListener("mousemove", onMove);
  preview.addEventListener("mouseleave", () => { loupe.hidden = true; });
  preview.addEventListener("click", onClick);
  pickToggle.addEventListener("click", () => setPicking(!picking));

  const renderImage = () => {
    imageGroup.row.replaceChildren();
    minor.replaceChildren();
    imageColors = [];
    if (!pixels) {
      imageGroup.row.append(make("span", "color-empty", currentImage ? "无法读取图片像素。" : "图片加载后显示。"));
      copyImage.hidden = true;
      pickToggle.disabled = true;
      setPicking(false);
      return;
    }
    const palette = extractImagePalette(pixels);
    imageColors = palette.colors.map((color) => color.hex);
    if (palette.colors.length) {
      for (const color of palette.colors) imageGroup.row.append(swatch(color.hex, `约占彩色区域 ${Math.max(1, Math.round(color.share * 100))}%`));
    } else {
      imageGroup.row.append(make("span", "color-empty", "这张图没有明显的彩色区域。"));
    }
    if (palette.background) {
      minor.append(make("span", "color-minor-label", "背景"), swatch(palette.background.hex, "背景"));
    }
    if (palette.neutrals.length) {
      minor.append(make("span", "color-minor-label", "黑白灰"), ...palette.neutrals.map((color) => swatch(color.hex, "文字、坐标轴或描边")));
    }
    copyImage.hidden = imageColors.length === 0;
    pickToggle.disabled = false;
  };
  const adopt = (image: HTMLImageElement | null) => {
    // The preview's children are replaced when the exact image arrives; keep the loupe attached.
    if (loupe.parentElement !== preview) preview.append(loupe);
    if (image === currentImage) return;
    currentImage = image ?? undefined;
    pixels = undefined;
    if (!image) { renderImage(); return; }
    const read = () => {
      if (currentImage !== image) return;
      pixels = imagePixels(document, image);
      renderImage();
    };
    if (image.complete && image.naturalWidth) read();
    else {
      renderImage();
      image.addEventListener("load", read, { once: true });
    }
  };
  const observer = new MutationObserver(() => adopt(preview.querySelector("img")));
  observer.observe(preview, { childList: true, subtree: true });
  adopt(preview.querySelector("img"));
  renderPicked();

  const renderCode = (report: ReferenceCodeColors) => {
    codeBody.replaceChildren();
    codeNote.replaceChildren();
    codeColors = report.hex.map((color) => color.hex);
    copyCode.hidden = codeColors.length === 0;
    if (report.hex.length) {
      const row = make("div", "color-swatches");
      for (const color of report.hex) {
        row.append(swatch(color.hex, report.source === "reference_pack" ? `${color.file} 第 ${color.line} 行，出现 ${color.count} 次` : `出现 ${color.count} 次`));
      }
      codeBody.append(row);
    }
    if (report.named.length) {
      const row = make("div", "color-swatches color-swatches-minor");
      row.append(make("span", "color-minor-label", "命名色"));
      for (const color of report.named) {
        if (color.hex) {
          const control = swatch(color.hex, color.name);
          control.textContent = color.name;
          row.append(control);
        } else {
          const tag = make("span", "color-name", color.name);
          tag.title = "这个颜色名没有内置色值";
          row.append(tag);
        }
      }
      codeBody.append(row);
    }
    for (const palette of report.palettes) {
      const row = make("div", "color-palette-row");
      const name = make("button", "color-palette-name", `${palette.source} · ${palette.name}`);
      name.type = "button";
      if (palette.colors) {
        name.title = "点击复制整套调色板";
        name.addEventListener("click", () => void copy(palette.colors!, `调色板 ${palette.name}`));
        const strip = make("div", "color-swatches");
        strip.append(...palette.colors.map((hex) => swatch(hex, `${palette.source} ${palette.name}`)));
        row.append(name, strip);
      } else {
        name.disabled = true;
        name.title = "这套调色板不在内置对照表中，只显示名称";
        row.append(name, make("span", "color-empty", "未内置色值"));
      }
      codeBody.append(row);
    }
    const found = report.hex.length + report.named.length + report.palettes.length > 0;
    const cacheButton = () => {
      const control = make("button", "color-cache", "下载代码");
      control.type = "button";
      control.addEventListener("click", () => options.onCacheCode?.(() => void refreshCode()));
      return control;
    };
    if (report.source === "reference_pack") {
      codeNote.textContent = found
        ? `来自本地代码：${report.files.slice(0, 4).join("、")}${report.files.length > 4 ? ` 等 ${report.files.length} 个文件` : ""}。只做文本解析，不执行代码；运行时计算出的颜色不会出现在这里。`
        : report.files.length
          ? "本地代码里没有找到写明的色值或调色板。"
          : "这个参考的本地文件里没有 R 或 Python 代码。";
    } else if (report.source === "catalog_text") {
      codeNote.append(found
        ? "来自图库目录收录的代码正文，可能包含被注释掉的颜色。下载代码后可得到精确结果。"
        : "目录收录的代码正文里没有找到写明的色值。下载代码后可再检查。");
      if (report.canCache && options.onCacheCode) codeNote.append(" ", cacheButton());
    } else if (!options.hasCode) {
      codeNote.textContent = "这个参考没有代码，只能从图片取色。";
    } else {
      codeNote.append("代码还没有下载到本机。");
      if (report.canCache && options.onCacheCode) codeNote.append(" ", cacheButton());
    }
  };
  async function refreshCode() {
    codeNote.textContent = "正在读取代码中的颜色…";
    try {
      renderCode(await options.loadCodeColors());
    } catch (error) {
      codeBody.replaceChildren();
      copyCode.hidden = true;
      codeNote.textContent = `读取代码颜色失败：${error instanceof Error ? error.message : String(error)}`;
    }
  }
  copyCode.hidden = true;
  void refreshCode();

  return {
    panel,
    refreshCode,
    dispose: () => {
      observer.disconnect();
      preview.removeEventListener("mousemove", onMove);
      preview.removeEventListener("click", onClick);
    },
  };
}
