import assert from "node:assert/strict";
import test from "node:test";
import { PNG } from "pngjs";
import { LEGACY_PREVIEW_MAX_EDGE, reducePreviewImage } from "../src/preview-reduction.ts";
import { decodeRaster } from "../src/transport-image.ts";

type Rgba = [number, number, number, number];

function png(width: number, height: number, paint: (x: number, y: number) => Rgba) {
  const image = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) image.data.set(paint(x, y), (y * width + x) * 4);
  }
  return new Uint8Array(PNG.sync.write(image));
}

function pixel(bytes: Uint8Array, x: number, y: number): [number, number, number] {
  const raster = decodeRaster(bytes, "image/jpeg");
  const offset = (y * raster.width + x) * 4;
  return [raster.data[offset]!, raster.data[offset + 1]!, raster.data[offset + 2]!];
}

test("a preview larger than the limit becomes a JPEG whose long edge is the limit, keeping its aspect ratio", () => {
  // Light per-pixel variation stands in for the anti-aliased detail of a real figure.
  const source = png(2400, 1600, (x, y) => {
    const shade = ((x * 31 + y * 17) % 23) - 11;
    return x < 1200 ? [228 + shade, 26, 28, 255] : [55, 126, 184 + shade, 255];
  });
  const reduced = reducePreviewImage(source, "image/png")!;
  assert.equal(reduced.mediaType, "image/jpeg");
  assert.deepEqual([reduced.width, reduced.height], [LEGACY_PREVIEW_MAX_EDGE, 800]);
  assert.ok(reduced.bytes.byteLength < source.byteLength);
  const decoded = decodeRaster(reduced.bytes, "image/jpeg");
  assert.deepEqual([decoded.width, decoded.height], [1200, 800]);
  const [red] = pixel(reduced.bytes, 200, 400);
  const [, , blue] = pixel(reduced.bytes, 1000, 400);
  assert.ok(red > 200 && blue > 160, `left is red (${red}) and right is blue (${blue})`);
  const tall = reducePreviewImage(png(900, 3600, (x, y) => [(x * 13 + y * 7) % 256, (x * 5) % 256, (y * 3) % 256, 255]), "image/png")!;
  assert.deepEqual([tall.width, tall.height], [300, 1200]);
});

test("an image that already fits, or one that cannot be decoded here, is published as it is", () => {
  assert.equal(reducePreviewImage(png(1200, 800, () => [10, 20, 30, 255]), "image/png"), undefined);
  assert.equal(reducePreviewImage(png(64, 64, () => [10, 20, 30, 255]), "image/png"), undefined);
  assert.equal(reducePreviewImage(new Uint8Array([1, 2, 3]), "image/webp"), undefined);
  assert.equal(reducePreviewImage(png(4000, 10, () => [0, 0, 0, 255]), "image/png", { maxEdge: 4000 }), undefined);
  // Two flat colours compress to a PNG smaller than any JPEG of them; the byte cap is what matters.
  const flat = png(2400, 1600, (x) => (x < 1200 ? [228, 26, 28, 255] : [55, 126, 184, 255]));
  assert.equal(reducePreviewImage(flat, "image/png"), undefined);
});

test("transparent pixels are composited over white, and the output has no alpha channel", () => {
  const reduced = reducePreviewImage(
    png(2000, 2000, (x, y) => (x < 1000 ? [(x * 7 + y) % 256, (y * 3) % 256, x % 256, 0] : [(x + y) % 3, 0, 255, 128])),
    "image/png",
  )!;
  const [r1, g1, b1] = pixel(reduced.bytes, 100, 600);
  assert.ok(r1 > 245 && g1 > 245 && b1 > 245, `fully transparent reads as white: ${r1},${g1},${b1}`);
  const [r2, g2, b2] = pixel(reduced.bytes, 1000, 600);
  assert.ok(Math.abs(r2 - 127) < 12 && Math.abs(g2 - 127) < 12 && b2 > 240, `half-transparent blue blends with white: ${r2},${g2},${b2}`);
});

test("a one-pixel line survives a four-fold reduction as a lighter stroke instead of vanishing", () => {
  const source = png(4800, 1200, (x, y) => {
    if (x === 2401 || y === 601) return [0, 0, 0, 255];
    const paper = 250 + ((x * 3 + y * 5) % 6);
    return [paper, paper, paper, 255];
  });
  const reduced = reducePreviewImage(source, "image/png")!;
  assert.deepEqual([reduced.width, reduced.height], [1200, 300]);
  const raster = decodeRaster(reduced.bytes, "image/jpeg");
  let darkestOnRow = 255;
  for (let x = 0; x < raster.width; x += 1) darkestOnRow = Math.min(darkestOnRow, raster.data[(40 * raster.width + x) * 4]!);
  let darkestOnColumn = 255;
  for (let y = 0; y < raster.height; y += 1) darkestOnColumn = Math.min(darkestOnColumn, raster.data[(y * raster.width + 300) * 4]!);
  assert.ok(darkestOnRow < 215, `the vertical line is still visible on row 40: ${darkestOnRow}`);
  assert.ok(darkestOnColumn < 215, `the horizontal line is still visible on column 300: ${darkestOnColumn}`);
});

test("the same input always produces the same bytes", () => {
  const source = png(1800, 1500, (x, y) => [(x * 7) % 256, (y * 5) % 256, (x + y) % 256, 255]);
  const first = reducePreviewImage(source, "image/png")!;
  const second = reducePreviewImage(source, "image/png")!;
  assert.deepEqual(Buffer.from(first.bytes), Buffer.from(second.bytes));
  const other = reducePreviewImage(source, "image/png", { maxEdge: 600, quality: 70 })!;
  assert.equal(other.width, 600);
  assert.ok(other.bytes.byteLength < first.bytes.byteLength);
});
