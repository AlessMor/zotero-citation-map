/// <reference lib="dom" />

const SVG_NS = "http://www.w3.org/2000/svg";

export type CitationMapIconName =
  | "search"
  | "similar"
  | "refresh"
  | "export"
  | "filter"
  | "sort"
  | "ascending"
  | "descending";

const ICON_PATHS: Record<CitationMapIconName, string[]> = {
  search: [
    "M10.5 4a6.5 6.5 0 1 0 3.95 11.66L20 21.2l1.2-1.2-5.55-5.55A6.5 6.5 0 0 0 10.5 4Zm0 1.8a4.7 4.7 0 1 1 0 9.4 4.7 4.7 0 0 1 0-9.4Z",
  ],
  similar: [
    "M10.5 4a6.5 6.5 0 1 0 3.95 11.66L20 21.2l1.2-1.2-5.55-5.55A6.5 6.5 0 0 0 10.5 4Zm0 1.8a4.7 4.7 0 1 1 0 9.4 4.7 4.7 0 0 1 0-9.4Z",
  ],
  refresh: [
    "M17.65 6.35A7.95 7.95 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8S7.58 20 12 20c3.73 0 6.84-2.55 7.73-6h-2.08A6 6 0 1 1 12 6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35Z",
  ],
  export: [
    "M11 3h2v9.17l2.59-2.58L17 11l-5 5-5-5 1.41-1.41L11 12.17V3Z",
    "M5 18h14v3H5v-3Z",
  ],
  filter: [
    "M3 5a1 1 0 0 1 1-1h16a1 1 0 0 1 .8 1.6L14 14.67V20a1 1 0 0 1-1.45.89l-3-1.5A1 1 0 0 1 9 18.5v-3.83L3.2 5.6A1 1 0 0 1 3 5Z",
  ],
  sort: ["M7 4 3 8h3v10h2V8h3L7 4Zm10 16 4-4h-3V6h-2v10h-3l4 4Z"],
  ascending: ["M12 5 6 11h4v8h4v-8h4l-6-6Z"],
  descending: ["M10 5v8H6l6 6 6-6h-4V5h-4Z"],
};

export function createCitationMapIcon(
  document: Document,
  name: CitationMapIconName,
  size = 16,
): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("cm-icon", `cm-icon-${name}`);
  svg.style.width = `${size}px`;
  svg.style.height = `${size}px`;
  svg.style.flex = `0 0 ${size}px`;
  svg.style.fill = "currentColor";
  for (const d of ICON_PATHS[name]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "currentColor");
    svg.appendChild(path);
  }
  return svg;
}
