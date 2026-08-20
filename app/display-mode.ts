export type WorkbenchDisplayMode = "inline" | "fullscreen" | "pip";

export const APP_DISPLAY_MODES: readonly WorkbenchDisplayMode[] = [
  "inline",
  "fullscreen",
  "pip",
];

export function isDisplayMode(value: unknown): value is WorkbenchDisplayMode {
  return value === "inline" || value === "fullscreen" || value === "pip";
}

export function supportedDisplayModes(available: unknown): WorkbenchDisplayMode[] {
  if (!Array.isArray(available)) return [];
  return APP_DISPLAY_MODES.filter((mode) => available.includes(mode));
}

export function hostSupportsMode(
  available: unknown,
  mode: WorkbenchDisplayMode,
): boolean {
  return supportedDisplayModes(available).includes(mode);
}

export interface WorkbenchDisplayElements {
  root: HTMLElement;
  controls: HTMLElement;
  expandButton: HTMLButtonElement;
  keepVisibleButton: HTMLButtonElement;
  reexpandButton: HTMLButtonElement;
  pipSummary: HTMLElement;
}

export function applyWorkbenchDisplayMode(options: {
  elements: WorkbenchDisplayElements;
  mode: WorkbenchDisplayMode;
  available: unknown;
  summary: string;
}): WorkbenchDisplayMode {
  const { elements, available, summary } = options;
  const supported = supportedDisplayModes(available);
  const resolved = supported.includes(options.mode) ? options.mode : "inline";
  elements.root.dataset.displayMode = resolved;
  const canFullscreen = supported.includes("fullscreen");
  const canPip = supported.includes("pip");
  elements.controls.hidden = !canFullscreen && !canPip;
  elements.expandButton.hidden = !canFullscreen;
  elements.keepVisibleButton.hidden = !canPip;
  elements.reexpandButton.hidden = resolved !== "pip";
  elements.expandButton.disabled = resolved === "fullscreen";
  elements.keepVisibleButton.disabled = resolved === "pip";
  elements.expandButton.setAttribute("aria-pressed", String(resolved === "fullscreen"));
  elements.keepVisibleButton.setAttribute("aria-pressed", String(resolved === "pip"));
  elements.pipSummary.textContent = summary;
  elements.pipSummary.hidden = resolved !== "pip";
  return resolved;
}

export function compactWorkbenchSummary(options: {
  query: string;
  pageIndex?: number;
  pageCount?: number;
  selectedTitles: string[];
}): string {
  const query = options.query.trim() || "等待搜索结果";
  const page =
    typeof options.pageIndex === "number" && typeof options.pageCount === "number"
      ? "第 " + options.pageIndex + " / " + options.pageCount + " 页"
      : "尚未分页";
  const titles = options.selectedTitles.filter(Boolean);
  const selected =
    titles.length === 0
      ? "尚未选择模板"
      : titles.length <= 3
        ? "已选 " + titles.join("、")
        : "已选 " + titles.slice(0, 3).join("、") + " 等 " + titles.length + " 个";
  return query + " · " + page + " · " + selected;
}
