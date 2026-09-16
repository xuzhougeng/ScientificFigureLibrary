export const PAGE_TITLES = {
  discover: "图库",
  library: "我的图库",
  galleries: "外部图库",
  import: "创建参考图",
  integrations: "连接外部工具",
  settings: "设置",
} as const;

export type PageId = keyof typeof PAGE_TITLES;
export const PAGE_STORAGE_KEY = "sfl-local-page";

export function isPageId(value: string): value is PageId {
  return Object.prototype.hasOwnProperty.call(PAGE_TITLES, value);
}

export function readSavedPage(hash: string, stored: string | null): PageId {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const fromHash = params.get("page");
  if (fromHash && isPageId(fromHash)) return fromHash;
  if (stored && isPageId(stored)) return stored;
  return "discover";
}

export function pageHash(hash: string, page: PageId) {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  params.delete("connect");
  if (page === "discover") params.delete("page");
  else params.set("page", page);
  const query = params.toString();
  return query ? `#${query}` : "";
}

export function galleryMissingCount(gallery: Record<string, unknown> | undefined) {
  if (!gallery) return 0;
  const declared = Number(gallery.declared ?? 0);
  const cached = Number(gallery.cached ?? 0);
  const missing = Number(gallery.missing ?? declared - cached);
  return Number.isFinite(missing) ? Math.max(0, missing) : 0;
}

export function prefetchButtonLabel(gallery: Record<string, unknown> | undefined, failed = false) {
  const missing = galleryMissingCount(gallery);
  const cached = Number(gallery?.cached ?? 0);
  if (missing > 0) return cached > 0 ? "继续缓存" : "缓存图片";
  if (failed) return "继续缓存";
  return undefined;
}
