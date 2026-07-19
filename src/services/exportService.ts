import type { CitationGraphModel } from "../domain/graphTypes";
import type { LibrarySnapshot } from "../domain/types";

function sanitizeFilename(value: string): string {
  return (
    value
      .normalize("NFKD")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "citation-map"
  );
}

function download(
  document: Document,
  filename: string,
  content: string | Blob,
  type: string,
): void {
  const blob =
    content instanceof Blob ? content : new Blob([content], { type });
  const url = document.defaultView?.URL.createObjectURL(blob);
  if (!url) throw new Error("Unable to create an export URL.");
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  document.defaultView?.setTimeout(
    () => document.defaultView?.URL.revokeObjectURL(url),
    1000,
  );
}

export function exportGraphJSON(
  document: Document,
  snapshot: LibrarySnapshot,
  model: CitationGraphModel,
  visibleKeys: Set<string>,
  includeExternal = false,
): void {
  const nodes = model.nodes.filter((node) => visibleKeys.has(node.key));
  const keys = new Set(nodes.map((node) => node.key));
  const edges = model.edges.filter(
    (edge) => keys.has(edge.source) && keys.has(edge.target),
  );
  download(
    document,
    `${sanitizeFilename(snapshot.libraryName)}-citation-map.json`,
    JSON.stringify(
      {
        schema: "zotero-citation-map/1",
        generatedAt: new Date().toISOString(),
        library: snapshot.libraryName,
        includeExternal,
        nodes,
        edges,
      },
      null,
      2,
    ),
    "application/json",
  );
}

function csvEscape(value: unknown): string {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function exportGraphCSV(
  document: Document,
  snapshot: LibrarySnapshot,
  model: CitationGraphModel,
  visibleKeys: Set<string>,
): void {
  const nodes = model.nodes.filter((node) => visibleKeys.has(node.key));
  const keys = new Set(nodes.map((node) => node.key));
  const nodeByKey = new Map(nodes.map((node) => [node.key, node]));
  const lines = [
    [
      "source_item_key",
      "source_title",
      "source_doi",
      "target_item_key",
      "target_title",
      "target_doi",
      "provenance",
      "manual",
    ].join(","),
  ];
  for (const edge of model.edges) {
    if (!keys.has(edge.source) || !keys.has(edge.target)) continue;
    const source = nodeByKey.get(edge.source);
    const target = nodeByKey.get(edge.target);
    lines.push(
      [
        edge.source,
        source?.title,
        source?.doi,
        edge.target,
        target?.title,
        target?.doi,
        edge.provenance,
        edge.manual,
      ]
        .map(csvEscape)
        .join(","),
    );
  }
  download(
    document,
    `${sanitizeFilename(snapshot.libraryName)}-citation-links.csv`,
    lines.join("\r\n"),
    "text/csv;charset=utf-8",
  );
}

export function exportGraphPNG(
  document: Document,
  canvas: HTMLCanvasElement,
  snapshot: LibrarySnapshot,
): void {
  canvas.toBlob((blob) => {
    if (!blob) throw new Error("Unable to render the graph image.");
    download(
      document,
      `${sanitizeFilename(snapshot.libraryName)}-citation-map.png`,
      blob,
      "image/png",
    );
  }, "image/png");
}
