export type SflIconName =
  | "check"
  | "chevron-left"
  | "chevron-right"
  | "close"
  | "details"
  | "expand"
  | "eye"
  | "image"
  | "layers"
  | "loader"
  | "pip"
  | "retry"
  | "scan"
  | "send"
  | "warning";

type IconPart = readonly [
  tag: "circle" | "line" | "path" | "polyline" | "rect",
  attributes: Readonly<Record<string, string>>,
];

const ICON_PARTS: Readonly<Record<SflIconName, readonly IconPart[]>> = {
  check: [["path", { d: "m5 12 4 4L19 6" }]],
  "chevron-left": [["path", { d: "m15 18-6-6 6-6" }]],
  "chevron-right": [["path", { d: "m9 18 6-6-6-6" }]],
  close: [
    ["path", { d: "M18 6 6 18" }],
    ["path", { d: "m6 6 12 12" }],
  ],
  details: [
    ["circle", { cx: "11", cy: "11", r: "7" }],
    ["path", { d: "m20 20-3.4-3.4" }],
    ["path", { d: "M8 11h6M11 8v6" }],
  ],
  expand: [
    ["path", { d: "M8 3H3v5M16 3h5v5M8 21H3v-5M21 16v5h-5" }],
  ],
  eye: [
    ["path", { d: "M2.4 12s3.5-6 9.6-6 9.6 6 9.6 6-3.5 6-9.6 6-9.6-6-9.6-6Z" }],
    ["circle", { cx: "12", cy: "12", r: "2.7" }],
  ],
  image: [
    ["rect", { x: "3", y: "4", width: "18", height: "16", rx: "2" }],
    ["circle", { cx: "8.5", cy: "9", r: "1.5" }],
    ["path", { d: "m4 17 4.5-4.5 3.5 3 2.5-2.5 5.5 5" }],
  ],
  layers: [
    ["path", { d: "m12 3-9 5 9 5 9-5-9-5Z" }],
    ["path", { d: "m3 12 9 5 9-5M3 16l9 5 9-5" }],
  ],
  loader: [
    ["path", { d: "M21 12a9 9 0 1 1-3-6.7" }],
    ["path", { d: "M21 4v6h-6" }],
  ],
  pip: [
    ["rect", { x: "3", y: "4", width: "18", height: "16", rx: "2" }],
    ["rect", { x: "12", y: "11", width: "7", height: "6", rx: "1" }],
  ],
  retry: [
    ["path", { d: "M20 7v5h-5" }],
    ["path", { d: "M19 12a7 7 0 1 0-2 5" }],
  ],
  scan: [
    ["path", { d: "M3 8V4a1 1 0 0 1 1-1h4M16 3h4a1 1 0 0 1 1 1v4M21 16v4a1 1 0 0 1-1 1h-4M8 21H4a1 1 0 0 1-1-1v-4" }],
    ["circle", { cx: "12", cy: "12", r: "3" }],
  ],
  send: [
    ["path", { d: "m22 2-7 20-4-9-9-4 20-7Z" }],
    ["path", { d: "M22 2 11 13" }],
  ],
  warning: [
    ["path", { d: "M10.3 3.7 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0Z" }],
    ["path", { d: "M12 9v4" }],
    ["circle", { cx: "12", cy: "17", r: ".6", fill: "currentColor", stroke: "none" }],
  ],
};

const SVG_NS = "http://www.w3.org/2000/svg";

export function createIcon(
  document: Document,
  name: SflIconName,
  className = "sfl-icon",
): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.classList.add(...className.split(/\s+/u).filter(Boolean));
  for (const [tag, attributes] of ICON_PARTS[name]) {
    const part = document.createElementNS(SVG_NS, tag);
    for (const [attribute, value] of Object.entries(attributes)) {
      part.setAttribute(attribute, value);
    }
    svg.append(part);
  }
  return svg;
}

export function setButtonContent(
  button: HTMLButtonElement,
  name: SflIconName,
  label: string,
  options: { iconOnly?: boolean; spinning?: boolean; title?: string } = {},
) {
  const document = button.ownerDocument;
  const icon = createIcon(
    document,
    name,
    options.spinning ? "sfl-icon sfl-icon-spinning" : "sfl-icon",
  );
  const labelNode = document.createElement("span");
  labelNode.className = options.iconOnly ? "visually-hidden" : "button-label";
  labelNode.textContent = label;
  button.replaceChildren(icon, labelNode);
  button.classList.toggle("icon-button", options.iconOnly === true);
  if (options.iconOnly) button.setAttribute("aria-label", label);
  button.title = options.title ?? (options.iconOnly ? label : "");
}
