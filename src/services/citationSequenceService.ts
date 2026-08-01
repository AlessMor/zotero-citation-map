import type {
  CitationGraphEdge,
  CitationGraphNode,
} from "../domain/graphTypes";
import { publicationYearOrNull } from "../domain/valueNormalization";

interface PublicationOrder {
  value: number;
  precision: "day" | "month" | "year";
}

/**
 * Convert Zotero/provider dates into a sortable UTC value without inventing
 * day-level precision. Year-only dates use the middle of the year and
 * month-only dates use the middle of the month.
 */
export function publicationOrder(
  publicationDate: string | null | undefined,
  fallbackYear: number | null | undefined,
): PublicationOrder | null {
  const text = String(publicationDate ?? "").trim();
  const isoDay = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\D|$)/);
  if (isoDay) {
    const year = publicationYearOrNull(isoDay[1]);
    const month = Number(isoDay[2]);
    const day = Number(isoDay[3]);
    if (year !== null && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return { value: Date.UTC(year, month - 1, day), precision: "day" };
    }
  }

  const isoMonth = text.match(/^(\d{4})-(\d{1,2})(?:\D|$)/);
  if (isoMonth) {
    const year = publicationYearOrNull(isoMonth[1]);
    const month = Number(isoMonth[2]);
    if (year !== null && month >= 1 && month <= 12) {
      return { value: Date.UTC(year, month - 1, 15), precision: "month" };
    }
  }

  if (text && !/^\d{4}$/.test(text)) {
    const parsed = Date.parse(text);
    if (Number.isFinite(parsed)) {
      return { value: parsed, precision: "day" };
    }
  }

  const yearFromText = publicationYearOrNull(
    text.match(/\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/)?.[1],
  );
  const year = yearFromText ?? publicationYearOrNull(fallbackYear);
  return year === null
    ? null
    : { value: Date.UTC(year, 6, 1), precision: "year" };
}

function nodeOrder(node: CitationGraphNode): PublicationOrder | null {
  return publicationOrder(node.publicationDate, node.year);
}

function stableCompare(
  left: CitationGraphNode,
  right: CitationGraphNode,
): number {
  return (
    left.title.localeCompare(right.title, undefined, {
      sensitivity: "base",
    }) || left.key.localeCompare(right.key)
  );
}

function compareChronologically(
  left: CitationGraphNode,
  right: CitationGraphNode,
  ascending: boolean,
): number {
  const leftOrder = nodeOrder(left);
  const rightOrder = nodeOrder(right);
  if (leftOrder && rightOrder && leftOrder.value !== rightOrder.value) {
    return ascending
      ? leftOrder.value - rightOrder.value
      : rightOrder.value - leftOrder.value;
  }
  if (leftOrder && !rightOrder) return -1;
  if (!leftOrder && rightOrder) return 1;
  return stableCompare(left, right);
}

/**
 * Assign a graph-wide ordinal publication sequence. The earliest known paper
 * is 0, then 1, 2, and so on. This is intentionally ordinal: equal physical
 * spacing means one publication step, not a fixed amount of elapsed time.
 */
export function assignGraphCitationSequence(nodes: CitationGraphNode[]): void {
  for (const node of nodes) node.citationSequence = null;
  const ordered = nodes
    .filter((node) => nodeOrder(node) !== null)
    .sort((left, right) => compareChronologically(left, right, true));
  ordered.forEach((node, index) => {
    node.citationSequence = index;
  });
}

function relationToAnchor(
  key: string,
  anchorKey: string,
  edges: CitationGraphEdge[],
): "reference" | "cited-by" | null {
  const anchorReferencesNode = edges.some(
    (edge) => edge.source === anchorKey && edge.target === key,
  );
  const nodeReferencesAnchor = edges.some(
    (edge) => edge.source === key && edge.target === anchorKey,
  );
  if (anchorReferencesNode && !nodeReferencesAnchor) return "reference";
  if (nodeReferencesAnchor && !anchorReferencesNode) return "cited-by";
  return null;
}

/**
 * Assign seed-relative citation steps for Focus View. The primary seed is 0;
 * its references are -1, -2, ... from newest to oldest, while citing papers
 * are +1, +2, ... from earliest to latest. Exact dates are used when known;
 * year-only ties remain deterministic but should be interpreted as uncertain.
 */
export function assignFocusCitationSequence(
  nodes: CitationGraphNode[],
  edges: CitationGraphEdge[],
  primarySeedKey: string,
): void {
  for (const node of nodes) node.citationSequence = null;
  const anchor = nodes.find((node) => node.key === primarySeedKey);
  if (!anchor) {
    assignGraphCitationSequence(nodes);
    return;
  }
  anchor.citationSequence = 0;
  const anchorOrder = nodeOrder(anchor);
  const references: CitationGraphNode[] = [];
  const citedBy: CitationGraphNode[] = [];

  for (const node of nodes) {
    if (node.key === primarySeedKey) continue;
    const direct = relationToAnchor(node.key, primarySeedKey, edges);
    if (direct === "reference") {
      references.push(node);
      continue;
    }
    if (direct === "cited-by") {
      citedBy.push(node);
      continue;
    }
    if (node.focusRole === "reference") {
      references.push(node);
      continue;
    }
    if (node.focusRole === "cited-by") {
      citedBy.push(node);
      continue;
    }

    const order = nodeOrder(node);
    if (anchorOrder && order && order.value < anchorOrder.value) {
      references.push(node);
    } else {
      citedBy.push(node);
    }
  }

  references
    .sort((left, right) => compareChronologically(left, right, false))
    .forEach((node, index) => {
      node.citationSequence = -(index + 1);
    });
  citedBy
    .sort((left, right) => compareChronologically(left, right, true))
    .forEach((node, index) => {
      node.citationSequence = index + 1;
    });
}
