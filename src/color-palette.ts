/**
 * Colour extraction for library entries: dominant colours of a preview image
 * and colour definitions written in template code.
 *
 * Everything here is pure and static. Image pixels are only counted, and code
 * is only scanned as text — it is never parsed into a program or executed. The
 * module has no Node dependencies so the local web client can run it on a
 * canvas while the backend runs it on cached reference packs.
 */

export interface RgbaImage {
  width: number;
  height: number;
  /** 8-bit RGBA, row-major. */
  data: ArrayLike<number>;
}

export interface PaletteColor {
  hex: string;
  /**
   * Area fraction within the colour's own list: chromatic colours add up to
   * (at most) 1 across `colors`, neutrals across `neutrals`; the background
   * share is of the whole image.
   */
  share: number;
}

export interface ImagePalette {
  /** The canvas colour, when one colour dominates the image border. */
  background?: PaletteColor;
  /** Chromatic colours, largest area first. */
  colors: PaletteColor[];
  /** Black, white and greys used for text, axes and outlines. */
  neutrals: PaletteColor[];
}

type Rgb = [number, number, number];
type Lab = [number, number, number];

const MAX_SAMPLES = 60_000;
/** CIE76 distance under which two colours are treated as the same ink. */
const MERGE_DELTA_E = 11;
const BACKGROUND_DELTA_E = 6;
const NEUTRAL_CHROMA = 8;

export function toHex([r, g, b]: Rgb) {
  return `#${[r, g, b].map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

function toLab([r, g, b]: Rgb): Lab {
  const linear = (value: number) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)];
  const f = (value: number) => (value > 0.008856 ? Math.cbrt(value) : 7.787 * value + 16 / 116);
  const x = f((0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / 0.95047);
  const y = f(0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb);
  const z = f((0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

function deltaE(left: Lab, right: Lab) {
  return Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
}

interface Bin {
  count: number;
  red: number;
  green: number;
  blue: number;
}

interface Cluster {
  rgb: Rgb;
  lab: Lab;
  count: number;
}

/**
 * Dominant colours of an image. The image is sampled on a grid, the colour
 * that fills its border is set aside as background, near-identical colours
 * are merged, and blends between an ink and the background are dropped.
 *
 * Only pixels whose right and lower neighbours have nearly the same colour are
 * counted, because anti-aliased edges and compression halos are by nature not
 * uniform while filled marks are. A figure drawn only with hairlines has no
 * such pixels; it is then read again without that requirement. A continuous
 * gradient has no discrete palette and yields representative steps of the ramp.
 */
export function extractImagePalette(image: RgbaImage, options: { maxColors?: number; maxNeutrals?: number } = {}): ImagePalette {
  const flat = paletteOf(image, options, true);
  if (flat.colors.length >= 2) return flat;
  const all = paletteOf(image, options, false);
  return all.colors.length > flat.colors.length ? all : flat;
}

/** Largest channel difference under which two neighbouring pixels count as the same flat area. */
const FLAT_TOLERANCE = 12;

function paletteOf(image: RgbaImage, options: { maxColors?: number; maxNeutrals?: number }, flatOnly: boolean): ImagePalette {
  const maxColors = options.maxColors ?? 10;
  const maxNeutrals = options.maxNeutrals ?? 3;
  const { width, height, data } = image;
  if (!(width > 0 && height > 0) || data.length < width * height * 4) return { colors: [], neutrals: [] };
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / MAX_SAMPLES)));
  const frame = Math.max(step, Math.round(Math.min(width, height) * 0.02));
  const bins = new Map<number, Bin>();
  const border = new Map<number, number>();
  let sampled = 0;
  let borderSampled = 0;
  // Transparent pixels show the page behind them; composite over white.
  const channel = (offset: number, index: number) => {
    const alpha = data[offset + 3]! / 255;
    return Math.round(data[offset + index]! * alpha + 255 * (1 - alpha));
  };
  const sameAs = (offset: number, red: number, green: number, blue: number) =>
    Math.abs(channel(offset, 0) - red) <= FLAT_TOLERANCE &&
    Math.abs(channel(offset, 1) - green) <= FLAT_TOLERANCE &&
    Math.abs(channel(offset, 2) - blue) <= FLAT_TOLERANCE;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const offset = (y * width + x) * 4;
      const red = channel(offset, 0);
      const green = channel(offset, 1);
      const blue = channel(offset, 2);
      if (flatOnly) {
        if (x + 1 < width && !sameAs(offset + 4, red, green, blue)) continue;
        if (y + 1 < height && !sameAs(offset + width * 4, red, green, blue)) continue;
      }
      const key = ((red >> 3) << 10) | ((green >> 3) << 5) | (blue >> 3);
      const bin = bins.get(key);
      if (bin) {
        bin.count += 1;
        bin.red += red;
        bin.green += green;
        bin.blue += blue;
      } else bins.set(key, { count: 1, red, green, blue });
      sampled += 1;
      if (x < frame || y < frame || x >= width - frame || y >= height - frame) {
        border.set(key, (border.get(key) ?? 0) + 1);
        borderSampled += 1;
      }
    }
  }
  if (!sampled) return { colors: [], neutrals: [] };
  const entries = [...bins.entries()]
    .map(([key, bin]) => {
      const rgb: Rgb = [bin.red / bin.count, bin.green / bin.count, bin.blue / bin.count];
      return { key, count: bin.count, rgb, lab: toLab(rgb) };
    })
    .sort((left, right) => right.count - left.count || left.key - right.key);

  let background: Cluster | undefined;
  const [borderKey, borderCount] = [...border.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0])[0] ?? [];
  if (borderKey !== undefined && borderCount! / borderSampled >= 0.5) {
    const seed = entries.find((entry) => entry.key === borderKey)!;
    background = { rgb: seed.rgb, lab: seed.lab, count: 0 };
  }

  const clusters: Cluster[] = [];
  for (const entry of entries) {
    if (background && deltaE(entry.lab, background.lab) <= BACKGROUND_DELTA_E) {
      background.count += entry.count;
      continue;
    }
    let nearest: Cluster | undefined;
    let distance = Infinity;
    for (const cluster of clusters) {
      const current = deltaE(entry.lab, cluster.lab);
      if (current < distance) {
        distance = current;
        nearest = cluster;
      }
    }
    // The first (most frequent) bin of a cluster stays its colour, so a flat ink is reported exactly, not averaged with its edges.
    if (nearest && (distance <= MERGE_DELTA_E || clusters.length >= 96)) nearest.count += entry.count;
    else clusters.push({ rgb: entry.rgb, lab: entry.lab, count: entry.count });
  }
  const foreground = clusters.reduce((sum, cluster) => sum + cluster.count, 0);
  if (!foreground) {
    return { ...(background ? { background: { hex: toHex(background.rgb), share: background.count / sampled } } : {}), colors: [], neutrals: [] };
  }
  clusters.sort((left, right) => right.count - left.count);

  // A tint of an ink also lies between that ink and a white canvas, so position alone cannot tell
  // an anti-aliased edge from a real pale category; only a small area relative to the ink can.
  const isBlend = (cluster: Cluster) => {
    if (!background || cluster.count / foreground >= 0.03) return false;
    return clusters.some((parent) => {
      if (parent === cluster || cluster.count >= parent.count * 0.1) return false;
      const axis = parent.rgb.map((value, index) => value - background.rgb[index]!);
      const length = axis.reduce((sum, value) => sum + value * value, 0);
      if (length < 400) return false;
      const offset = cluster.rgb.map((value, index) => value - background.rgb[index]!);
      const t = offset.reduce((sum, value, index) => sum + value * axis[index]!, 0) / length;
      if (t <= 0.1 || t >= 0.92) return false;
      return Math.hypot(...offset.map((value, index) => value - t * axis[index]!)) < 14;
    });
  };
  const kept = clusters.filter((cluster, index) => index < 2 || (cluster.count / foreground >= 0.004 && !isBlend(cluster)));
  const chroma = (cluster: Cluster) => Math.hypot(cluster.lab[1], cluster.lab[2]);
  const present = (list: Cluster[], limit: number): PaletteColor[] => {
    const total = list.reduce((sum, cluster) => sum + cluster.count, 0);
    return list.slice(0, limit).map((cluster) => ({ hex: toHex(cluster.rgb), share: cluster.count / total }));
  };
  return {
    ...(background ? { background: { hex: toHex(background.rgb), share: background.count / sampled } } : {}),
    colors: present(kept.filter((cluster) => chroma(cluster) >= NEUTRAL_CHROMA), maxColors),
    neutrals: present(kept.filter((cluster) => chroma(cluster) < NEUTRAL_CHROMA), maxNeutrals),
  };
}

/** Average colour of the square of pixels around one point, for a click-to-pick eyedropper. */
export function sampleColor(image: RgbaImage, x: number, y: number, radius = 1) {
  const { width, height, data } = image;
  const totals = [0, 0, 0];
  let count = 0;
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      const px = Math.round(x) + dx;
      const py = Math.round(y) + dy;
      if (px < 0 || py < 0 || px >= width || py >= height) continue;
      const offset = (py * width + px) * 4;
      const alpha = data[offset + 3]! / 255;
      for (let channel = 0; channel < 3; channel += 1) totals[channel]! += data[offset + channel]! * alpha + 255 * (1 - alpha);
      count += 1;
    }
  }
  return count ? toHex(totals.map((value) => value / count) as Rgb) : undefined;
}

export type CodeLanguage = "r" | "python";

export interface CodeColor {
  hex: string;
  /** How many times the literal appears across the scanned files. */
  count: number;
  file: string;
  line: number;
}

export interface CodeNamedColor {
  name: string;
  /** Present when the name has one well-defined value in that language. */
  hex?: string;
  count: number;
  file: string;
  line: number;
}

export interface CodePalette {
  /** Package or library that defines the palette, e.g. `ggsci`, `RColorBrewer`, `viridis`, `matplotlib`. */
  source: string;
  name: string;
  /** Known colours of the palette; absent when it is not in the built-in table. */
  colors?: string[];
  file: string;
  line: number;
}

export interface CodeColorReport {
  hex: CodeColor[];
  named: CodeNamedColor[];
  palettes: CodePalette[];
}

const BREWER: Record<string, string[]> = {
  Set1: ["#E41A1C", "#377EB8", "#4DAF4A", "#984EA3", "#FF7F00", "#FFFF33", "#A65628", "#F781BF", "#999999"],
  Set2: ["#66C2A5", "#FC8D62", "#8DA0CB", "#E78AC3", "#A6D854", "#FFD92F", "#E5C494", "#B3B3B3"],
  Set3: ["#8DD3C7", "#FFFFB3", "#BEBADA", "#FB8072", "#80B1D3", "#FDB462", "#B3DE69", "#FCCDE5", "#D9D9D9", "#BC80BD", "#CCEBC5", "#FFED6F"],
  Dark2: ["#1B9E77", "#D95F02", "#7570B3", "#E7298A", "#66A61E", "#E6AB02", "#A6761D", "#666666"],
  Paired: ["#A6CEE3", "#1F78B4", "#B2DF8A", "#33A02C", "#FB9A99", "#E31A1C", "#FDBF6F", "#FF7F00", "#CAB2D6", "#6A3D9A", "#FFFF99", "#B15928"],
  Pastel1: ["#FBB4AE", "#B3CDE3", "#CCEBC5", "#DECBE4", "#FED9A6", "#FFFFCC", "#E5D8BD", "#FDDAEC", "#F2F2F2"],
  Pastel2: ["#B3E2CD", "#FDCDAC", "#CBD5E8", "#F4CAE4", "#E6F5C9", "#FFF2AE", "#F1E2CC", "#CCCCCC"],
  Accent: ["#7FC97F", "#BEAED4", "#FDC086", "#FFFF99", "#386CB0", "#F0027F", "#BF5B17", "#666666"],
  RdBu: ["#67001F", "#B2182B", "#D6604D", "#F4A582", "#FDDBC7", "#F7F7F7", "#D1E5F0", "#92C5DE", "#4393C3", "#2166AC", "#053061"],
  RdYlBu: ["#A50026", "#D73027", "#F46D43", "#FDAE61", "#FEE090", "#FFFFBF", "#E0F3F8", "#ABD9E9", "#74ADD1", "#4575B4", "#313695"],
  RdYlGn: ["#A50026", "#D73027", "#F46D43", "#FDAE61", "#FEE08B", "#FFFFBF", "#D9EF8B", "#A6D96A", "#66BD63", "#1A9850", "#006837"],
  Spectral: ["#9E0142", "#D53E4F", "#F46D43", "#FDAE61", "#FEE08B", "#FFFFBF", "#E6F598", "#ABDDA4", "#66C2A5", "#3288BD", "#5E4FA2"],
  Blues: ["#F7FBFF", "#DEEBF7", "#C6DBEF", "#9ECAE1", "#6BAED6", "#4292C6", "#2171B5", "#08519C", "#08306B"],
  Reds: ["#FFF5F0", "#FEE0D2", "#FCBBA1", "#FC9272", "#FB6A4A", "#EF3B2C", "#CB181D", "#A50F15", "#67000D"],
  Greens: ["#F7FCF5", "#E5F5E0", "#C7E9C0", "#A1D99B", "#74C476", "#41AB5D", "#238B45", "#006D2C", "#00441B"],
  YlOrRd: ["#FFFFCC", "#FFEDA0", "#FED976", "#FEB24C", "#FD8D3C", "#FC4E2A", "#E31A1C", "#BD0026", "#800026"],
  YlGnBu: ["#FFFFD9", "#EDF8B1", "#C7E9B4", "#7FCDBB", "#41B6C4", "#1D91C0", "#225EA8", "#253494", "#081D58"],
};

const GGSCI: Record<string, string[]> = {
  npg: ["#E64B35", "#4DBBD5", "#00A087", "#3C5488", "#F39B7F", "#8491B4", "#91D1C2", "#DC0000", "#7E6148", "#B09C85"],
  aaas: ["#3B4992", "#EE0000", "#008B45", "#631879", "#008280", "#BB0021", "#5F559B", "#A20056", "#808180", "#1B1919"],
  nejm: ["#BC3C29", "#0072B5", "#E18727", "#20854E", "#7876B1", "#6F99AD", "#FFDC91", "#EE4C97"],
  lancet: ["#00468B", "#ED0000", "#42B540", "#0099B4", "#925E9F", "#FDAF91", "#AD002A", "#ADB6B6", "#1B1919"],
  jama: ["#374E55", "#DF8F44", "#00A1D5", "#B24745", "#79AF97", "#6A6599", "#80796B"],
  jco: ["#0073C2", "#EFC000", "#868686", "#CD534C", "#7AA6DC", "#003C67", "#8F7700", "#3B3B3B", "#A73030", "#4A6990"],
  d3: ["#1F77B4", "#FF7F0E", "#2CA02C", "#D62728", "#9467BD", "#8C564B", "#E377C2", "#7F7F7F", "#BCBD22", "#17BECF"],
};
const GGSCI_NAMES = "npg|aaas|nejm|lancet|jama|jco|bmj|ucscgb|d3|observable|locuszoom|igv|cosmic|uchicago|startrek|tron|futurama|rickandmorty|simpsons|flatui|frontiers|gsea|material";

/** Five evenly spaced steps of each viridis-family map. */
const VIRIDIS: Record<string, string[]> = {
  viridis: ["#440154", "#3B528B", "#21908C", "#5DC863", "#FDE725"],
  magma: ["#000004", "#51127C", "#B63679", "#FB8861", "#FCFDBF"],
  inferno: ["#000004", "#56106E", "#BB3754", "#F98C0A", "#FCFFA4"],
  plasma: ["#0D0887", "#7E03A8", "#CC4678", "#F89441", "#F0F921"],
  cividis: ["#00204D", "#414D6B", "#7C7B78", "#BCAF6F", "#FFEA46"],
};
const VIRIDIS_OPTION: Record<string, string> = { A: "magma", B: "inferno", C: "plasma", D: "viridis", E: "cividis" };

const MATPLOTLIB: Record<string, string[]> = {
  tab10: GGSCI.d3!,
  ...VIRIDIS,
  ...Object.fromEntries(Object.entries(BREWER).map(([name, colors]) => [name, colors])),
};

/** Names with the same value in R and matplotlib/CSS. */
const NAMED: Record<string, string> = {
  white: "#FFFFFF", black: "#000000", red: "#FF0000", blue: "#0000FF", yellow: "#FFFF00", cyan: "#00FFFF", magenta: "#FF00FF",
  orange: "#FFA500", pink: "#FFC0CB", brown: "#A52A2A", navy: "#000080", gold: "#FFD700", tomato: "#FF6347", salmon: "#FA8072",
  coral: "#FF7F50", orchid: "#DA70D6", tan: "#D2B48C", khaki: "#F0E68C", turquoise: "#40E0D0", violet: "#EE82EE", steelblue: "#4682B4",
  firebrick: "#B22222", darkred: "#8B0000", darkblue: "#00008B", darkgreen: "#006400", forestgreen: "#228B22", royalblue: "#4169E1",
  skyblue: "#87CEEB", darkorange: "#FF8C00", dodgerblue: "#1E90FF", lightblue: "#ADD8E6", lightgrey: "#D3D3D3", lightgray: "#D3D3D3",
  darkgrey: "#A9A9A9", darkgray: "#A9A9A9", indianred: "#CD5C5C", seagreen: "#2E8B57", slateblue: "#6A5ACD", goldenrod: "#DAA520",
  chocolate: "#D2691E", crimson: "#DC143C", limegreen: "#32CD32", cornflowerblue: "#6495ED", midnightblue: "#191970", orangered: "#FF4500",
  hotpink: "#FF69B4", deeppink: "#FF1493", darkviolet: "#9400D3", lightgreen: "#90EE90", lightyellow: "#FFFFE0", lightpink: "#FFB6C1",
  beige: "#F5F5DC", ivory: "#FFFFF0", lavender: "#E6E6FA", plum: "#DDA0DD", sienna: "#A0522D", peru: "#CD853F", teal: "#008080",
  olive: "#808000", indigo: "#4B0082", darkcyan: "#008B8B", cadetblue: "#5F9EA0", deepskyblue: "#00BFFF", springgreen: "#00FF7F",
};
/** Names whose value differs between R (X11) and matplotlib (CSS). */
const NAMED_BY_LANGUAGE: Record<CodeLanguage, Record<string, string>> = {
  r: { green: "#00FF00", grey: "#BEBEBE", gray: "#BEBEBE", purple: "#A020F0", maroon: "#B03060" },
  python: { green: "#008000", grey: "#808080", gray: "#808080", purple: "#800080", maroon: "#800000" },
};

function namedColor(name: string, language: CodeLanguage): { known: boolean; hex?: string } {
  const lower = name.toLowerCase();
  const direct = NAMED_BY_LANGUAGE[language][lower] ?? NAMED[lower];
  if (direct) return { known: true, hex: direct };
  if (language === "r") {
    const grey = /^gr[ae]y(\d{1,3})$/u.exec(lower);
    if (grey && Number(grey[1]) <= 100) {
      const level = Math.round((Number(grey[1]) / 100) * 255);
      return { known: true, hex: toHex([level, level, level]) };
    }
    // R's numbered shades (firebrick3, steelblue4) are real colours without a simple formula.
    const shade = /^([a-z]+)[1-4]$/u.exec(lower);
    if (shade && (NAMED[shade[1]!] || NAMED_BY_LANGUAGE.r[shade[1]!])) return { known: true };
  }
  return { known: false };
}

/** Cut a line at its first `#` that is outside a string literal. */
function stripComment(line: string) {
  let quote = "";
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = "";
    } else if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "#") return line.slice(0, index);
  }
  return line;
}

export function codeLanguage(file: string): CodeLanguage | undefined {
  if (/\.(?:r|rmd|qmd)$/iu.test(file)) return "r";
  if (/\.py$/iu.test(file)) return "python";
  return undefined;
}

/** Code lines of a file with their 1-based line numbers; R Markdown contributes only its fenced chunks. */
function codeLines(file: string, text: string) {
  const lines = text.split(/\r?\n/u).map((value, index) => ({ value, line: index + 1 }));
  if (!/\.(?:rmd|qmd)$/iu.test(file)) return lines.map((entry) => ({ ...entry, language: codeLanguage(file)! }));
  const result: Array<{ value: string; line: number; language: CodeLanguage }> = [];
  let chunk: CodeLanguage | "other" | undefined;
  for (const entry of lines) {
    const fence = /^\s*```+\s*(?:\{\s*([A-Za-z]+)[^}]*\})?/u.exec(entry.value);
    if (fence) {
      if (chunk) chunk = undefined;
      else chunk = /^r$/iu.test(fence[1] ?? "") ? "r" : /^python$/iu.test(fence[1] ?? "") ? "python" : "other";
      continue;
    }
    if (chunk && chunk !== "other") result.push({ ...entry, language: chunk });
  }
  return result;
}

/**
 * Colour definitions written in template code: quoted hex literals, quoted
 * colour names, and calls that select a named palette. Comments are ignored.
 * The scan is textual; a colour computed at run time is not found.
 */
export function extractCodeColors(
  files: Array<{
    path: string;
    text: string;
    /**
     * The text is a whitespace-collapsed dump (a catalog's bundled module
     * text) rather than a source file: it has no line structure, so comments
     * cannot be told apart and every match is reported on line 1.
     */
    flattened?: boolean;
  }>,
): CodeColorReport {
  const hex = new Map<string, CodeColor>();
  const named = new Map<string, CodeNamedColor>();
  const palettes = new Map<string, CodePalette>();
  const addPalette = (source: string, name: string, colors: string[] | undefined, file: string, line: number) => {
    const key = `${source}\0${name}`;
    if (!palettes.has(key)) palettes.set(key, { source, name, ...(colors ? { colors } : {}), file, line });
  };
  for (const file of files) {
    if (!file.flattened && !codeLanguage(file.path)) continue;
    const lines = file.flattened
      ? [{ value: file.text, line: 1, language: codeLanguage(file.path) ?? ("r" as const) }]
      : codeLines(file.path, file.text);
    for (const entry of lines) {
      const code = file.flattened ? entry.value : stripComment(entry.value);
      if (!code.trim()) continue;
      const language = entry.language;
      for (const match of code.matchAll(/(["'])#([0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\1/gu)) {
        let digits = match[2]!.toUpperCase();
        if (digits.length === 3) {
          if (language === "r") continue;
          digits = [...digits].map((digit) => digit + digit).join("");
        }
        const value = `#${digits.slice(0, 6)}`;
        const seen = hex.get(value);
        if (seen) seen.count += 1;
        else hex.set(value, { hex: value, count: 1, file: file.path, line: entry.line });
      }
      for (const match of code.matchAll(/(["'])([A-Za-z]{3,20}\d{0,3})\1/gu)) {
        const resolved = namedColor(match[2]!, language);
        if (!resolved.known) continue;
        const name = match[2]!.toLowerCase();
        const seen = named.get(name);
        if (seen) seen.count += 1;
        else named.set(name, { name, ...(resolved.hex ? { hex: resolved.hex } : {}), count: 1, file: file.path, line: entry.line });
      }
      for (const match of code.matchAll(new RegExp(`\\b(?:scale_(?:colou?r|fill)_|pal_)(${GGSCI_NAMES})\\s*\\(`, "gu"))) {
        addPalette("ggsci", match[1]!, GGSCI[match[1]!], file.path, entry.line);
      }
      for (const match of code.matchAll(/\bbrewer\.pal\s*\(\s*(?:n\s*=\s*)?[^,()]*,\s*(?:name\s*=\s*)?["']([A-Za-z0-9]+)["']/gu)) {
        addPalette("RColorBrewer", match[1]!, BREWER[match[1]!], file.path, entry.line);
      }
      for (const match of code.matchAll(/\bscale_(?:colou?r|fill)_(?:brewer|distiller|fermenter)\s*\([^)]*?\bpalette\s*=\s*["']([A-Za-z0-9]+)["']/gu)) {
        addPalette("RColorBrewer", match[1]!, BREWER[match[1]!], file.path, entry.line);
      }
      for (const match of code.matchAll(/\bscale_(?:colou?r|fill)_viridis(?:_[cdb])?\s*\(([^)]*)\)/gu)) {
        const option = /\boption\s*=\s*["']([A-Za-z]+)["']/u.exec(match[1]!)?.[1];
        const name = option ? (VIRIDIS_OPTION[option.toUpperCase()] ?? option.toLowerCase()) : "viridis";
        addPalette("viridis", name, VIRIDIS[name], file.path, entry.line);
      }
      if (language === "r") {
        for (const match of code.matchAll(/(?<![A-Za-z0-9_.])(viridis|magma|inferno|plasma|cividis)\s*\(/gu)) {
          addPalette("viridis", match[1]!, VIRIDIS[match[1]!], file.path, entry.line);
        }
      } else {
        for (const match of code.matchAll(/\b(?:cmap|palette)\s*=\s*["']([A-Za-z0-9_]+)["']/gu)) {
          const base = match[1]!.replace(/_r$/u, "");
          addPalette("matplotlib", match[1]!, MATPLOTLIB[base], file.path, entry.line);
        }
        for (const match of code.matchAll(/\b(?:color_palette|get_cmap)\s*\(\s*["']([A-Za-z0-9_]+)["']/gu)) {
          const base = match[1]!.replace(/_r$/u, "");
          addPalette("matplotlib", match[1]!, MATPLOTLIB[base], file.path, entry.line);
        }
        for (const match of code.matchAll(/\b(?:plt|mpl|matplotlib)\.cm\.([A-Za-z0-9_]+)/gu)) {
          const base = match[1]!.replace(/_r$/u, "");
          if (base !== "get_cmap") addPalette("matplotlib", match[1]!, MATPLOTLIB[base], file.path, entry.line);
        }
      }
    }
  }
  return { hex: [...hex.values()], named: [...named.values()], palettes: [...palettes.values()] };
}

export type ColorCopyFormat = "hex" | "r" | "python";

/** Text for the clipboard: a plain list, an R character vector, or a Python list. */
export function formatColors(colors: readonly string[], format: ColorCopyFormat) {
  if (format === "r") return `c(${colors.map((color) => `"${color}"`).join(", ")})`;
  if (format === "python") return `[${colors.map((color) => `"${color}"`).join(", ")}]`;
  return colors.join(", ");
}
