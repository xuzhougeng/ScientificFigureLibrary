import { readFileSync } from "node:fs";
import path from "node:path";

export const SFL_WEBSITE_URL = "https://xuzhougeng.github.io/ScientificFigureLibrary/";
export const SFL_APP_DESCRIPTION =
  "Browse reviewed scientific-figure templates, inspect exact previews, and hand an explicit selection back to the Agent.";

const BRAND_ASSET_PATH = path.resolve(import.meta.dirname, "../assets/brand/sfl-logo.svg");
const BRAND_LOGO_SVG = readFileSync(BRAND_ASSET_PATH, "utf8");

if (
  !/^(?:<\?xml[^>]*>\s*)?<svg\b/iu.test(BRAND_LOGO_SVG.trimStart()) ||
  /<script\b|<image\b|<foreignObject\b|(?:href|src|xlink:href)\s*=\s*["']https?:\/\//iu.test(
    BRAND_LOGO_SVG,
  )
) {
  throw new Error("SFL brand asset must be a self-contained, script-free SVG");
}

export const SFL_BRAND_ICON_DATA_URI =
  `data:image/svg+xml;base64,${Buffer.from(BRAND_LOGO_SVG, "utf8").toString("base64")}`;

export const SFL_SERVER_IDENTITY = {
  name: "Scientific Figure Library",
  title: "Scientific Figure Library",
  description: SFL_APP_DESCRIPTION,
  websiteUrl: SFL_WEBSITE_URL,
  icons: [
    {
      src: SFL_BRAND_ICON_DATA_URI,
      mimeType: "image/svg+xml",
      sizes: ["any"],
    },
  ],
};
