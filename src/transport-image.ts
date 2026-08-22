import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { decode as decodeJpeg, encode as encodeJpeg } from "jpeg-js";
import { PNG } from "pngjs";
import {
  inspectImageHeader,
  MAX_SAFE_IMAGE_PIXELS,
} from "./image-validation.ts";

export const ENCODER_POLICY_VERSION = "transport-image-v1";
export const SEARCH_MAX_DATA_URL_BYTES = 256 * 1024;
export const SEARCH_MAX_PAGE_DATA_URL_BYTES = 3 * 1024 * 1024;
export const SEARCH_PAGE_SAFETY = 0.8;
export const SINGLE_PREVIEW_MAX_DATA_URL_BYTES = 1024 * 1024;
export const SINGLE_PREVIEW_JSON_SLACK_BYTES = 16 * 1024;
export const BUDGET_BUCKET_BYTES = 4096;
export const MIN_DATA_URL_BUDGET_BYTES = 32 * 1024;
export const SEARCH_LONG_EDGE_RUNGS = [720, 640, 560, 480, 384] as const;
export const PREVIEW_LONG_EDGE_RUNGS = [1400, 1200, 1000, 800, 640, 480] as const;
export const JPEG_QUALITIES = [88, 82, 76] as const;
export const MAX_ENCODE_ATTEMPTS = 24;
export const DEFAULT_ENCODE_TIMEOUT_MS = 8_000;
export const SEARCH_CONCURRENCY = 3;

export type TransportImagePurpose =
  | "SearchCard"
  | "ExactPreview"
  | "WorkingPreview"
  | "CompatibilityPreview";

export type TransportFailureReason =
  | "too_large"
  | "unreadable"
  | "unsupported"
  | "unsafe_pixels"
  | "timeout"
  | "encode_failed";

export interface PreparedTransportImage {
  ok: true;
  dataUrl: string;
  transportBytes: Uint8Array;
  transportMime: "image/png" | "image/jpeg" | "image/webp";
  transportSha256: string;
  width: number;
  height: number;
  inlineBytes: number;
  cacheHit: boolean;
  passthrough: boolean;
  attemptCount: number;
  elapsedMs: number;
  budgetBytes: number;
  purpose: TransportImagePurpose;
}

export interface FailedTransportImage {
  ok: false;
  reason: TransportFailureReason;
  attemptCount: number;
  elapsedMs: number;
  budgetBytes: number;
  purpose: TransportImagePurpose;
}

export type TransportImageResult = PreparedTransportImage | FailedTransportImage;

interface RasterImage {
  width: number;
  height: number;
  data: Uint8Array;
  alpha: boolean;
}

interface CacheManifest {
  schema: "figure-library.transport-image-cache.v1";
  sourceHash: string;
  renditionHash: string;
  purpose: TransportImagePurpose;
  outputMime: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
  rawByteSize: number;
  estimatedInlineSize: number;
  encoderPolicyVersion: string;
  budgetBucket: number;
}

const inflight = new Map<string, Promise<TransportImageResult>>();

export function estimateDataUrlLength(byteLength: number, mimeType: string) {
  return `data:${mimeType};base64,`.length + 4 * Math.ceil(byteLength / 3);
}

export function budgetBucket(maxDataUrlBytes: number) {
  return Math.max(
    MIN_DATA_URL_BUDGET_BYTES,
    Math.floor(Math.max(0, maxDataUrlBytes) / BUDGET_BUCKET_BYTES) * BUDGET_BUCKET_BYTES,
  );
}

export function searchPerImageBudget(candidateCount: number) {
  const usablePage = Math.floor(SEARCH_MAX_PAGE_DATA_URL_BYTES * SEARCH_PAGE_SAFETY);
  const share = Math.floor(usablePage / Math.max(1, candidateCount));
  return Math.min(SEARCH_MAX_DATA_URL_BYTES, share);
}

export function singlePreviewBudget() {
  return SINGLE_PREVIEW_MAX_DATA_URL_BYTES - SINGLE_PREVIEW_JSON_SLACK_BYTES;
}

export function dataUrlFrom(bytes: Uint8Array, mimeType: string) {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}

function sha256Hex(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function renditionCacheKey(input: {
  sourceSha256: string;
  purpose: TransportImagePurpose;
  maxDataUrlBytes: number;
}) {
  return sha256Hex(
    `${input.sourceSha256}\0${input.purpose}\0${budgetBucket(input.maxDataUrlBytes)}\0${ENCODER_POLICY_VERSION}`,
  );
}

function cacheDirectory(libraryRoot: string) {
  return path.join(libraryRoot, "indexes", "transport-images", "v1");
}

function longEdgeRungs(purpose: TransportImagePurpose, sourceEdge: number) {
  const rungs =
    purpose === "SearchCard" ? SEARCH_LONG_EDGE_RUNGS : PREVIEW_LONG_EDGE_RUNGS;
  const edges = [sourceEdge, ...rungs.filter((edge) => edge < sourceEdge)];
  return [...new Set(edges)].sort((left, right) => right - left);
}

function targetSize(width: number, height: number, maxEdge: number) {
  const edge = Math.max(width, height);
  if (edge <= maxEdge) return { width, height };
  const scale = maxEdge / edge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function sampleChannel(data: Uint8Array, width: number, height: number, x: number, y: number, channel: number) {
  const sx = Math.min(width - 1, Math.max(0, x));
  const sy = Math.min(height - 1, Math.max(0, y));
  return data[(sy * width + sx) * 4 + channel] ?? 0;
}

function resizeRaster(source: RasterImage, width: number, height: number): RasterImage {
  if (source.width === width && source.height === height) return source;
  const data = new Uint8Array(width * height * 4);
  const xRatio = (source.width - 1) / Math.max(1, width - 1);
  const yRatio = (source.height - 1) / Math.max(1, height - 1);
  for (let y = 0; y < height; y += 1) {
    const srcY = y * yRatio;
    const y0 = Math.floor(srcY);
    const y1 = Math.min(source.height - 1, y0 + 1);
    const fy = srcY - y0;
    for (let x = 0; x < width; x += 1) {
      const srcX = x * xRatio;
      const x0 = Math.floor(srcX);
      const x1 = Math.min(source.width - 1, x0 + 1);
      const fx = srcX - x0;
      const dest = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel += 1) {
        const c00 = sampleChannel(source.data, source.width, source.height, x0, y0, channel);
        const c10 = sampleChannel(source.data, source.width, source.height, x1, y0, channel);
        const c01 = sampleChannel(source.data, source.width, source.height, x0, y1, channel);
        const c11 = sampleChannel(source.data, source.width, source.height, x1, y1, channel);
        data[dest + channel] = Math.round(
          c00 * (1 - fx) * (1 - fy) + c10 * fx * (1 - fy) + c01 * (1 - fx) * fy + c11 * fx * fy,
        );
      }
    }
  }
  let alpha = false;
  if (source.alpha) {
    for (let index = 3; index < data.length; index += 4) {
      if (data[index] !== 255) {
        alpha = true;
        break;
      }
    }
  }
  return { width, height, data, alpha };
}

function jpegExifOrientation(bytes: Uint8Array) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) break;
    const marker = bytes[offset + 1]!;
    const length = (bytes[offset + 2]! << 8) + bytes[offset + 3]!;
    if (length < 2 || offset + 2 + length > bytes.length) break;
    if (marker === 0xe1 && offset + 10 <= bytes.length) {
      const exifStart = offset + 4;
      if (
        bytes[exifStart] === 0x45 &&
        bytes[exifStart + 1] === 0x78 &&
        bytes[exifStart + 2] === 0x69 &&
        bytes[exifStart + 3] === 0x66 &&
        bytes[exifStart + 4] === 0x00 &&
        bytes[exifStart + 5] === 0x00
      ) {
        const tiff = exifStart + 6;
        const little = bytes[tiff] === 0x49 && bytes[tiff + 1] === 0x49;
        const read16 = (at: number) =>
          little ? bytes[at]! + (bytes[at + 1]! << 8) : (bytes[at]! << 8) + bytes[at + 1]!;
        const read32 = (at: number) =>
          little
            ? bytes[at]! + (bytes[at + 1]! << 8) + (bytes[at + 2]! << 16) + (bytes[at + 3]! << 24)
            : (bytes[at]! << 24) + (bytes[at + 1]! << 16) + (bytes[at + 2]! << 8) + bytes[at + 3]!;
        if (tiff + 8 <= bytes.length) {
          const ifd0 = tiff + read32(tiff + 4);
          if (ifd0 + 2 <= bytes.length) {
            const count = read16(ifd0);
            for (let index = 0; index < count; index += 1) {
              const entry = ifd0 + 2 + index * 12;
              if (entry + 12 > bytes.length) break;
              if (read16(entry) === 0x0112 && read16(entry + 2) === 3) {
                const value = read16(entry + 8);
                if (value >= 1 && value <= 8) return value;
              }
            }
          }
        }
      }
    }
    if (marker === 0xda) break;
    offset += 2 + length;
  }
  return 1;
}

function applyOrientation(raster: RasterImage, orientation: number): RasterImage {
  if (orientation === 1) return raster;
  const { width, height, data, alpha } = raster;
  const swap = orientation >= 5;
  const nextWidth = swap ? height : width;
  const nextHeight = swap ? width : height;
  const next = new Uint8Array(nextWidth * nextHeight * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let dx = x;
      let dy = y;
      switch (orientation) {
        case 2:
          dx = width - 1 - x;
          dy = y;
          break;
        case 3:
          dx = width - 1 - x;
          dy = height - 1 - y;
          break;
        case 4:
          dx = x;
          dy = height - 1 - y;
          break;
        case 5:
          dx = y;
          dy = x;
          break;
        case 6:
          dx = height - 1 - y;
          dy = x;
          break;
        case 7:
          dx = height - 1 - y;
          dy = width - 1 - x;
          break;
        case 8:
          dx = y;
          dy = width - 1 - x;
          break;
        default:
          dx = x;
          dy = y;
      }
      const source = (y * width + x) * 4;
      const dest = (dy * nextWidth + dx) * 4;
      next[dest] = data[source] ?? 0;
      next[dest + 1] = data[source + 1] ?? 0;
      next[dest + 2] = data[source + 2] ?? 0;
      next[dest + 3] = data[source + 3] ?? 255;
    }
  }
  return { width: nextWidth, height: nextHeight, data: next, alpha };
}

function decodeRaster(bytes: Uint8Array, mimeType: string): RasterImage {
  if (mimeType === "image/png") {
    const png = PNG.sync.read(Buffer.from(bytes));
    const data = Uint8Array.from(png.data);
    let alpha = Boolean(png.alpha);
    if (alpha) {
      alpha = false;
      for (let index = 3; index < data.length; index += 4) {
        if (data[index] !== 255) {
          alpha = true;
          break;
        }
      }
    }
    return { width: png.width, height: png.height, data, alpha };
  }
  if (mimeType === "image/jpeg") {
    const decoded = decodeJpeg(bytes, {
      useTArray: true,
      formatAsRGBA: true,
      maxResolutionInMP: MAX_SAFE_IMAGE_PIXELS / 1_000_000,
      maxMemoryUsageInMB: 256,
    });
    return applyOrientation(
      {
        width: decoded.width,
        height: decoded.height,
        data: decoded.data instanceof Uint8Array ? decoded.data : Uint8Array.from(decoded.data),
        alpha: false,
      },
      jpegExifOrientation(bytes),
    );
  }
  throw new Error("unsupported decode");
}

function encodePng(raster: RasterImage) {
  const png = new PNG({
    width: raster.width,
    height: raster.height,
    colorType: raster.alpha ? 6 : 2,
  });
  png.data = Buffer.from(raster.data);
  return new Uint8Array(PNG.sync.write(png));
}

function encodeJpegRaster(raster: RasterImage, quality: number) {
  const encoded = encodeJpeg(
    { data: raster.data, width: raster.width, height: raster.height },
    quality,
  );
  return encoded.data instanceof Uint8Array ? encoded.data : Uint8Array.from(encoded.data);
}

async function writeAtomic(file: string, bytes: Uint8Array) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  await fs.writeFile(temporary, bytes, { flag: "wx" });
  await fs.rename(temporary, file);
}

async function readCache(directory: string, key: string): Promise<PreparedTransportImage | undefined> {
  const metaFile = path.join(directory, `${key}.json`);
  const imageFile = path.join(directory, `${key}.img`);
  try {
    const [metaBytes, imageBytes] = await Promise.all([
      fs.readFile(metaFile),
      fs.readFile(imageFile),
    ]);
    const meta = JSON.parse(metaBytes.toString("utf8")) as CacheManifest;
    if (
      meta.schema !== "figure-library.transport-image-cache.v1" ||
      meta.encoderPolicyVersion !== ENCODER_POLICY_VERSION ||
      meta.renditionHash !== sha256Hex(imageBytes) ||
      (meta.outputMime !== "image/png" && meta.outputMime !== "image/jpeg" && meta.outputMime !== "image/webp")
    ) {
      await Promise.allSettled([fs.unlink(metaFile), fs.unlink(imageFile)]);
      return undefined;
    }
    const dataUrl = dataUrlFrom(imageBytes, meta.outputMime);
    return {
      ok: true,
      dataUrl,
      transportBytes: new Uint8Array(imageBytes),
      transportMime: meta.outputMime,
      transportSha256: meta.renditionHash,
      width: meta.width,
      height: meta.height,
      inlineBytes: dataUrl.length,
      cacheHit: true,
      passthrough: false,
      attemptCount: 0,
      elapsedMs: 0,
      budgetBytes: meta.budgetBucket,
      purpose: meta.purpose,
    };
  } catch {
    return undefined;
  }
}

async function writeCache(
  directory: string,
  key: string,
  result: PreparedTransportImage,
  sourceSha256: string,
) {
  const manifest: CacheManifest = {
    schema: "figure-library.transport-image-cache.v1",
    sourceHash: sourceSha256,
    renditionHash: result.transportSha256,
    purpose: result.purpose,
    outputMime: result.transportMime,
    width: result.width,
    height: result.height,
    rawByteSize: result.transportBytes.byteLength,
    estimatedInlineSize: result.inlineBytes,
    encoderPolicyVersion: ENCODER_POLICY_VERSION,
    budgetBucket: budgetBucket(result.budgetBytes),
  };
  await writeAtomic(path.join(directory, `${key}.img`), result.transportBytes);
  await writeAtomic(
    path.join(directory, `${key}.json`),
    new Uint8Array(Buffer.from(`${JSON.stringify(manifest)}\n`)),
  );
}

function fail(
  reason: TransportFailureReason,
  input: { attemptCount: number; startedAt: number; budgetBytes: number; purpose: TransportImagePurpose },
): FailedTransportImage {
  return {
    ok: false,
    reason,
    attemptCount: input.attemptCount,
    elapsedMs: performance.now() - input.startedAt,
    budgetBytes: input.budgetBytes,
    purpose: input.purpose,
  };
}

function success(input: {
  bytes: Uint8Array;
  mime: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
  cacheHit: boolean;
  passthrough: boolean;
  attemptCount: number;
  startedAt: number;
  budgetBytes: number;
  purpose: TransportImagePurpose;
}): PreparedTransportImage {
  const dataUrl = dataUrlFrom(input.bytes, input.mime);
  return {
    ok: true,
    dataUrl,
    transportBytes: input.bytes,
    transportMime: input.mime,
    transportSha256: sha256Hex(input.bytes),
    width: input.width,
    height: input.height,
    inlineBytes: dataUrl.length,
    cacheHit: input.cacheHit,
    passthrough: input.passthrough,
    attemptCount: input.attemptCount,
    elapsedMs: performance.now() - input.startedAt,
    budgetBytes: input.budgetBytes,
    purpose: input.purpose,
  };
}

async function generateRendition(input: {
  sourceBytes: Uint8Array;
  sourceMime: string;
  sourceSha256: string;
  purpose: TransportImagePurpose;
  maxDataUrlBytes: number;
  timeoutMs: number;
}): Promise<TransportImageResult> {
  const startedAt = performance.now();
  let attemptCount = 0;
  const deadline = startedAt + input.timeoutMs;
  const header = inspectImageHeader(input.sourceBytes);
  if (!header) return fail("unreadable", { attemptCount, startedAt, budgetBytes: input.maxDataUrlBytes, purpose: input.purpose });
  if (!header.pixelsSafe || header.width * header.height > MAX_SAFE_IMAGE_PIXELS) {
    return fail("unsafe_pixels", { attemptCount, startedAt, budgetBytes: input.maxDataUrlBytes, purpose: input.purpose });
  }
  if (header.mimeType !== "image/png" && header.mimeType !== "image/jpeg") {
    return fail("unsupported", { attemptCount, startedAt, budgetBytes: input.maxDataUrlBytes, purpose: input.purpose });
  }

  let raster: RasterImage;
  try {
    raster = decodeRaster(input.sourceBytes, header.mimeType);
  } catch {
    return fail("unreadable", { attemptCount, startedAt, budgetBytes: input.maxDataUrlBytes, purpose: input.purpose });
  }

  for (const edge of longEdgeRungs(input.purpose, Math.max(raster.width, raster.height))) {
    if (performance.now() > deadline) {
      return fail("timeout", { attemptCount, startedAt, budgetBytes: input.maxDataUrlBytes, purpose: input.purpose });
    }
    const sized = targetSize(raster.width, raster.height, edge);
    const resized = resizeRaster(raster, sized.width, sized.height);
    if (attemptCount >= MAX_ENCODE_ATTEMPTS) {
      return fail("too_large", { attemptCount, startedAt, budgetBytes: input.maxDataUrlBytes, purpose: input.purpose });
    }
    try {
      attemptCount += 1;
      const png = encodePng(resized);
      if (estimateDataUrlLength(png.byteLength, "image/png") <= input.maxDataUrlBytes) {
        return success({
          bytes: png,
          mime: "image/png",
          width: resized.width,
          height: resized.height,
          cacheHit: false,
          passthrough: false,
          attemptCount,
          startedAt,
          budgetBytes: input.maxDataUrlBytes,
          purpose: input.purpose,
        });
      }
    } catch {
      return fail("encode_failed", { attemptCount, startedAt, budgetBytes: input.maxDataUrlBytes, purpose: input.purpose });
    }
    if (resized.alpha) continue;
    for (const quality of JPEG_QUALITIES) {
      if (attemptCount >= MAX_ENCODE_ATTEMPTS || performance.now() > deadline) break;
      try {
        attemptCount += 1;
        const jpeg = encodeJpegRaster(resized, quality);
        if (estimateDataUrlLength(jpeg.byteLength, "image/jpeg") <= input.maxDataUrlBytes) {
          return success({
            bytes: jpeg,
            mime: "image/jpeg",
            width: resized.width,
            height: resized.height,
            cacheHit: false,
            passthrough: false,
            attemptCount,
            startedAt,
            budgetBytes: input.maxDataUrlBytes,
            purpose: input.purpose,
          });
        }
      } catch {
        return fail("encode_failed", { attemptCount, startedAt, budgetBytes: input.maxDataUrlBytes, purpose: input.purpose });
      }
    }
  }
  return fail("too_large", { attemptCount, startedAt, budgetBytes: input.maxDataUrlBytes, purpose: input.purpose });
}

export async function prepareTransportImage(input: {
  sourceBytes: Uint8Array;
  sourceMime: string;
  sourceSha256: string;
  purpose: TransportImagePurpose;
  maxDataUrlBytes: number;
  libraryRoot: string;
  timeoutMs?: number;
}): Promise<TransportImageResult> {
  const startedAt = performance.now();
  const header = inspectImageHeader(input.sourceBytes);
  if (!header) {
    return fail("unreadable", {
      attemptCount: 0,
      startedAt,
      budgetBytes: input.maxDataUrlBytes,
      purpose: input.purpose,
    });
  }
  if (!header.pixelsSafe) {
    return fail("unsafe_pixels", {
      attemptCount: 0,
      startedAt,
      budgetBytes: input.maxDataUrlBytes,
      purpose: input.purpose,
    });
  }
  const sourceMime = header.mimeType;
  const inline = estimateDataUrlLength(input.sourceBytes.byteLength, sourceMime);
  if (
    inline <= input.maxDataUrlBytes &&
    (sourceMime === "image/png" || sourceMime === "image/jpeg" || sourceMime === "image/webp")
  ) {
    return success({
      bytes: input.sourceBytes,
      mime: sourceMime,
      width: header.width,
      height: header.height,
      cacheHit: false,
      passthrough: true,
      attemptCount: 0,
      startedAt,
      budgetBytes: input.maxDataUrlBytes,
      purpose: input.purpose,
    });
  }
  if (sourceMime === "image/webp" || sourceMime === "image/gif") {
    return fail("too_large", {
      attemptCount: 0,
      startedAt,
      budgetBytes: input.maxDataUrlBytes,
      purpose: input.purpose,
    });
  }

  const key = renditionCacheKey({
    sourceSha256: input.sourceSha256,
    purpose: input.purpose,
    maxDataUrlBytes: input.maxDataUrlBytes,
  });
  const existing = inflight.get(key);
  if (existing) return existing;

  const work = (async () => {
    const directory = cacheDirectory(input.libraryRoot);
    const cached = await readCache(directory, key);
    if (cached && cached.inlineBytes <= input.maxDataUrlBytes) {
      return {
        ...cached,
        elapsedMs: performance.now() - startedAt,
        budgetBytes: input.maxDataUrlBytes,
        purpose: input.purpose,
      };
    }
    const generated = await generateRendition({
      sourceBytes: input.sourceBytes,
      sourceMime,
      sourceSha256: input.sourceSha256,
      purpose: input.purpose,
      maxDataUrlBytes: input.maxDataUrlBytes,
      timeoutMs: input.timeoutMs ?? DEFAULT_ENCODE_TIMEOUT_MS,
    });
    if (generated.ok) {
      await writeCache(directory, key, generated, input.sourceSha256);
    }
    return generated;
  })().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, work);
  return work;
}

export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      output[index] = await mapper(items[index]!, index);
    }
  });
  await Promise.all(workers);
  return output;
}

