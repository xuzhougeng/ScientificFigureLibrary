import brandLogoSvg from "../assets/brand/sfl-logo.svg?raw";

export const SFL_WEBSITE_URL = "https://xuzhougeng.github.io/ScientificFigureLibrary/";
export const SFL_APP_DESCRIPTION =
  "Browse reviewed scientific-figure templates, inspect exact previews, and hand an explicit selection back to the Agent.";

function svgDataUri(svg: string) {
  const bytes = new TextEncoder().encode(svg);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

export const SFL_BRAND_ICON_DATA_URI = svgDataUri(brandLogoSvg);
