/**
 * Reduced preview renditions for the legacy Open Figure feed.
 *
 * Clients up to 0.9.2 download every preview of an update in one ZIP capped at
 * 64 MiB, so that channel carries a smaller rendition of each preview instead
 * of the original. The original stays inside the module archive and is what a
 * user gets when the template is materialized.
 *
 * The output must be byte-stable: the publisher builds a feed twice and only
 * raises the sequence when bytes change. Everything here is plain arithmetic
 * and a pure-JavaScript JPEG encoder, so it does not depend on the zlib build
 * of the Node version that happens to run it.
 */
import { decodeRaster, encodeJpegRaster, type RasterImage } from "./transport-image.ts";

export const LEGACY_PREVIEW_MAX_EDGE = 1200;
export const LEGACY_PREVIEW_JPEG_QUALITY = 85;

export interface ReducedPreview {
  bytes: Uint8Array;
  mediaType: "image/jpeg";
  width: number;
  height: number;
}

/** For each target pixel along one axis: the first source pixel it covers and the coverage of each. */
function axisSpans(source: number, target: number) {
  const scale = source / target;
  const spans: Array<{ first: number; weights: Float64Array }> = [];
  for (let index = 0; index < target; index += 1) {
    const start = index * scale;
    const end = (index + 1) * scale;
    const first = Math.floor(start);
    const last = Math.min(source - 1, Math.ceil(end) - 1);
    const weights = new Float64Array(last - first + 1);
    for (let pixel = first; pixel <= last; pixel += 1) {
      weights[pixel - first] = Math.min(end, pixel + 1) - Math.max(start, pixel);
    }
    spans.push({ first, weights });
  }
  return spans;
}

/**
 * Downscale by averaging every source pixel a target pixel covers. Point or
 * bilinear sampling skips pixels at these ratios and drops thin axis lines and
 * small text; area averaging keeps them as lighter strokes. Transparent pixels
 * are composited over white first, the page colour a figure is shown on.
 */
function downscaleOverWhite(source: RasterImage, width: number, height: number): RasterImage {
  const columns = axisSpans(source.width, width);
  const rows = axisSpans(source.height, height);
  const horizontal = new Float64Array(width * source.height * 3);
  for (let y = 0; y < source.height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const { first, weights } = columns[x]!;
      let red = 0;
      let green = 0;
      let blue = 0;
      let total = 0;
      for (let index = 0; index < weights.length; index += 1) {
        const offset = (y * source.width + first + index) * 4;
        const weight = weights[index]!;
        const alpha = source.data[offset + 3]! / 255;
        red += (source.data[offset]! * alpha + 255 * (1 - alpha)) * weight;
        green += (source.data[offset + 1]! * alpha + 255 * (1 - alpha)) * weight;
        blue += (source.data[offset + 2]! * alpha + 255 * (1 - alpha)) * weight;
        total += weight;
      }
      const target = (y * width + x) * 3;
      horizontal[target] = red / total;
      horizontal[target + 1] = green / total;
      horizontal[target + 2] = blue / total;
    }
  }
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const { first, weights } = rows[y]!;
    for (let x = 0; x < width; x += 1) {
      let red = 0;
      let green = 0;
      let blue = 0;
      let total = 0;
      for (let index = 0; index < weights.length; index += 1) {
        const offset = ((first + index) * width + x) * 3;
        const weight = weights[index]!;
        red += horizontal[offset]! * weight;
        green += horizontal[offset + 1]! * weight;
        blue += horizontal[offset + 2]! * weight;
        total += weight;
      }
      const target = (y * width + x) * 4;
      data[target] = Math.round(red / total);
      data[target + 1] = Math.round(green / total);
      data[target + 2] = Math.round(blue / total);
      data[target + 3] = 255;
    }
  }
  return { width, height, data, alpha: false };
}

/**
 * A JPEG rendition whose long edge is at most `maxEdge`, or `undefined` when
 * the image should be published as it is: it already fits, its format cannot
 * be decoded here (WebP), or the rendition would not be smaller in bytes.
 * Images are never enlarged.
 */
export function reducePreviewImage(
  bytes: Uint8Array,
  mediaType: string,
  options: { maxEdge?: number; quality?: number } = {},
): ReducedPreview | undefined {
  const maxEdge = options.maxEdge ?? LEGACY_PREVIEW_MAX_EDGE;
  const quality = options.quality ?? LEGACY_PREVIEW_JPEG_QUALITY;
  if (mediaType !== "image/png" && mediaType !== "image/jpeg") return undefined;
  const source = decodeRaster(bytes, mediaType);
  const edge = Math.max(source.width, source.height);
  if (edge <= maxEdge) return undefined;
  const scale = maxEdge / edge;
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));
  const encoded = encodeJpegRaster(downscaleOverWhite(source, width, height), quality);
  // A PNG of a few flat colours can already be smaller than any JPEG of it; the cap is on bytes, so keep it.
  if (encoded.byteLength >= bytes.byteLength) return undefined;
  return { bytes: encoded, mediaType: "image/jpeg", width, height };
}
