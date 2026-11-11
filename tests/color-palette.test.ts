import assert from "node:assert/strict";
import test from "node:test";
import { extractCodeColors, extractImagePalette, formatColors, sampleColor, type RgbaImage } from "../src/color-palette.ts";

type Rgb = [number, number, number];

/** A white canvas with solid rectangles; `edge` paints a one-pixel blend ring around each to mimic anti-aliasing. */
function canvas(width: number, height: number, rects: Array<{ x: number; y: number; w: number; h: number; color: Rgb }>, options: { background?: Rgb; edge?: boolean } = {}): RgbaImage {
  const background = options.background ?? [255, 255, 255];
  const data = new Uint8Array(width * height * 4);
  const put = (x: number, y: number, [r, g, b]: Rgb) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    data.set([r, g, b, 255], (y * width + x) * 4);
  };
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) put(x, y, background);
  for (const rect of rects) {
    if (options.edge) {
      const blend = rect.color.map((value, index) => Math.round((value + background[index]!) / 2)) as Rgb;
      for (let x = rect.x - 1; x <= rect.x + rect.w; x += 1) { put(x, rect.y - 1, blend); put(x, rect.y + rect.h, blend); }
      for (let y = rect.y - 1; y <= rect.y + rect.h; y += 1) { put(rect.x - 1, y, blend); put(rect.x + rect.w, y, blend); }
    }
    for (let y = rect.y; y < rect.y + rect.h; y += 1) for (let x = rect.x; x < rect.x + rect.w; x += 1) put(x, y, rect.color);
  }
  return { width, height, data };
}

test("flat inks are reported exactly, largest area first, with the canvas set aside as background", () => {
  const image = canvas(200, 120, [
    { x: 20, y: 20, w: 80, h: 80, color: [228, 26, 28] },
    { x: 110, y: 20, w: 40, h: 80, color: [55, 126, 184] },
    { x: 160, y: 20, w: 20, h: 80, color: [77, 175, 74] },
  ]);
  const palette = extractImagePalette(image);
  assert.equal(palette.background?.hex, "#FFFFFF");
  assert.deepEqual(palette.colors.map((color) => color.hex), ["#E41A1C", "#377EB8", "#4DAF4A"]);
  assert.ok(palette.colors[0]!.share > palette.colors[1]!.share && palette.colors[1]!.share > palette.colors[2]!.share);
  assert.ok(Math.abs(palette.colors.reduce((sum, color) => sum + color.share, 0) - 1) < 0.02);
  assert.deepEqual(palette.neutrals, []);
});

test("thin blends between an ink and the background are not reported as colours", () => {
  const image = canvas(240, 160, [
    { x: 20, y: 20, w: 90, h: 120, color: [31, 120, 180] },
    { x: 130, y: 20, w: 90, h: 120, color: [227, 26, 28] },
  ], { edge: true });
  const palette = extractImagePalette(image);
  assert.deepEqual(palette.colors.map((color) => color.hex).sort(), ["#1F78B4", "#E31A1C"]);
});

test("black text and grey axes are neutrals, and a dark canvas is still the background", () => {
  const light = extractImagePalette(canvas(200, 120, [
    { x: 20, y: 20, w: 100, h: 60, color: [230, 75, 53] },
    { x: 20, y: 90, w: 160, h: 6, color: [0, 0, 0] },
    { x: 130, y: 20, w: 50, h: 40, color: [128, 128, 128] },
  ]));
  assert.deepEqual(light.colors.map((color) => color.hex), ["#E64B35"]);
  assert.deepEqual(light.neutrals.map((color) => color.hex).sort(), ["#000000", "#808080"]);
  const dark = extractImagePalette(canvas(200, 120, [{ x: 40, y: 30, w: 120, h: 60, color: [253, 231, 37] }], { background: [20, 20, 24] }));
  assert.equal(dark.background?.hex, "#141418");
  assert.deepEqual(dark.colors.map((color) => color.hex), ["#FDE725"]);
});

test("transparent pixels are read as the white page behind them, and empty input yields an empty palette", () => {
  const image = canvas(100, 100, [{ x: 30, y: 30, w: 40, h: 40, color: [0, 160, 135] }]);
  const data = image.data as Uint8Array;
  for (let index = 0; index < data.length; index += 4) if (data[index] === 255 && data[index + 1] === 255) data.set([0, 0, 0, 0], index);
  const palette = extractImagePalette(image);
  assert.equal(palette.background?.hex, "#FFFFFF");
  assert.deepEqual(palette.colors.map((color) => color.hex), ["#00A087"]);
  assert.deepEqual(extractImagePalette({ width: 0, height: 0, data: [] }), { colors: [], neutrals: [] });
});

test("a continuous gradient yields several representative steps, capped at the requested size", () => {
  const width = 256;
  const height = 60;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) data.set([x, 40, 255 - x, 255], (y * width + x) * 4);
  const palette = extractImagePalette({ width, height, data }, { maxColors: 6 });
  assert.equal(palette.colors.length, 6);
  assert.equal(new Set(palette.colors.map((color) => color.hex)).size, 6);
});

test("the eyedropper averages the pixels around a point and ignores points outside the image", () => {
  const image = canvas(20, 20, [{ x: 5, y: 5, w: 10, h: 10, color: [60, 84, 136] }]);
  assert.equal(sampleColor(image, 10, 10), "#3C5488");
  assert.equal(sampleColor(image, 1, 1), "#FFFFFF");
  assert.equal(sampleColor(image, 0, 0), "#FFFFFF");
  assert.equal(sampleColor(image, -5, -5), undefined);
});

test("R code: quoted hex literals, named colours and palette calls are found; comments are ignored", () => {
  const report = extractCodeColors([{
    path: "code/plot.R",
    text: [
      'library(ggsci)  # "#111111" in a comment is not a colour',
      'cols <- c(up = "#E9584B", down = "#3B86B6", ns = "grey80")',
      'p <- ggplot(df) + geom_point(color = "#E9584B") + scale_fill_npg()',
      'pal <- brewer.pal(9, "Set1"); other <- brewer.pal(n = 8, name = "PuOr")',
      'p + scale_color_brewer(palette = "Dark2") + scale_fill_viridis_c(option = "magma")',
      'heat <- colorRampPalette(c("#08519CFF", "white", "firebrick3"))(100)',
      'label <- "#abc"  # three-digit hex is not valid in R',
      'url <- "https://example.org/page#123456"',
    ].join("\n"),
  }]);
  assert.deepEqual(report.hex.map((color) => [color.hex, color.count, color.line]), [["#E9584B", 2, 2], ["#3B86B6", 1, 2], ["#08519C", 1, 6]]);
  assert.deepEqual(report.named.map((color) => [color.name, color.hex]), [["grey80", "#CCCCCC"], ["white", "#FFFFFF"], ["firebrick3", undefined]]);
  const palettes = Object.fromEntries(report.palettes.map((palette) => [`${palette.source}:${palette.name}`, palette.colors]));
  assert.equal(palettes["ggsci:npg"]?.[0], "#E64B35");
  assert.equal(palettes["RColorBrewer:Set1"]?.length, 9);
  assert.equal(palettes["RColorBrewer:Dark2"]?.[0], "#1B9E77");
  assert.equal(palettes["viridis:magma"]?.length, 5);
  // A palette outside the built-in table is still named, without colours.
  assert.ok("RColorBrewer:PuOr" in palettes);
  assert.equal(palettes["RColorBrewer:PuOr"], undefined);
});

test("R Markdown contributes only its code chunks, and names resolve per language", () => {
  const rmd = extractCodeColors([{
    path: "FigureYa.Rmd",
    text: ['The colour "#ABCDEF" is discussed in prose.', "```{r}", 'x <- "#123456"; y <- "green"', "```", "```", '"#654321"', "```", "```{python}", 'z = "green"', "```"].join("\n"),
  }]);
  assert.deepEqual(rmd.hex.map((color) => color.hex), ["#123456"]);
  assert.deepEqual(rmd.named.map((color) => color.hex), ["#00FF00"]);
  const python = extractCodeColors([{
    path: "plot.py",
    text: ['colors = ["#1f77b4", "#abc", "green"]  # "#000000"', 'sns.heatmap(data, cmap="RdBu_r")', "plt.cm.viridis(0.5)", 'pal = sns.color_palette("Set2")'].join("\n"),
  }]);
  assert.deepEqual(python.hex.map((color) => color.hex), ["#1F77B4", "#AABBCC"]);
  assert.deepEqual(python.named.map((color) => [color.name, color.hex]), [["green", "#008000"]]);
  assert.deepEqual(python.palettes.map((palette) => [palette.name, palette.colors?.length]), [["RdBu_r", 11], ["viridis", 5], ["Set2", 8]]);
});

test("files that are not R or Python are skipped; flattened catalog text is scanned without line structure", () => {
  assert.deepEqual(extractCodeColors([{ path: "README.md", text: '"#112233"' }]), { hex: [], named: [], palettes: [] });
  const flattened = extractCodeColors([{
    path: "FigureYa59volcanoV2.Rmd",
    flattened: true,
    text: 'mycol <- c ( "darkgreen" , "#223D6C" , "#D20A13" ) # note "#088247" scale_fill_lancet ( )',
  }]);
  assert.deepEqual(flattened.hex.map((color) => color.hex), ["#223D6C", "#D20A13", "#088247"]);
  assert.deepEqual(flattened.named.map((color) => color.name), ["darkgreen"]);
  assert.deepEqual(flattened.palettes.map((palette) => palette.name), ["lancet"]);
});

test("colours are formatted for the clipboard as a list, an R vector or a Python list", () => {
  const colors = ["#E64B35", "#4DBBD5"];
  assert.equal(formatColors(colors, "hex"), "#E64B35, #4DBBD5");
  assert.equal(formatColors(colors, "r"), 'c("#E64B35", "#4DBBD5")');
  assert.equal(formatColors(colors, "python"), '["#E64B35", "#4DBBD5"]');
});
