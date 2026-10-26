import { createHash } from "node:crypto";

export const THUMBNAIL_URL_PREFIX = "/api/thumb/";
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

export interface LocalThumbnail {
  bytes: Uint8Array;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
}

/**
 * Session-scoped, content-addressed store of card thumbnails for the local web client.
 * Only bytes this service rendered are servable; the URL key is the SHA-256 of those bytes,
 * so a URL always names the same image and browsers may cache it as immutable.
 */
export class LocalThumbnailStore {
  private readonly entries = new Map<string, LocalThumbnail>();
  private bytes = 0;
  private readonly maxBytes: number;

  constructor(maxBytes = DEFAULT_MAX_BYTES) {
    this.maxBytes = maxBytes;
  }

  register(bytes: Uint8Array, mimeType: LocalThumbnail["mimeType"]) {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const existing = this.entries.get(sha256);
    if (existing) this.entries.delete(sha256);
    else this.bytes += bytes.byteLength;
    this.entries.set(sha256, existing ?? { bytes, mimeType });
    for (const [key, entry] of this.entries) {
      if (this.bytes <= this.maxBytes || key === sha256) break;
      this.entries.delete(key);
      this.bytes -= entry.bytes.byteLength;
    }
    return `${THUMBNAIL_URL_PREFIX}${sha256}`;
  }

  get(sha256: string) {
    return this.entries.get(sha256);
  }
}
