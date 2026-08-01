import type { RelatedWorkMetadata, WorkIdentifiers } from "./citationTypes";
import type { CitationGraphNode } from "./graphTypes";
import { normalizeDOI, normalizeExactTitle } from "./workIdentity";

export function workIdentifiersForRelatedWork(
  work: RelatedWorkMetadata,
): WorkIdentifiers {
  return {
    doi: normalizeDOI(work.doi),
    pmid: String(work.pmid ?? "").trim() || null,
    arxiv: String(work.arxiv ?? "").trim() || null,
    isbn: String(work.isbn ?? "").trim() || null,
    title: String(work.title ?? "").trim(),
    normalizedTitle: normalizeExactTitle(work.title),
    year: work.year,
    authors: work.authors,
    sourceTitle: work.sourceTitle ?? null,
  };
}

export function workIdentifiersForGraphNode(
  node: CitationGraphNode,
): WorkIdentifiers {
  const external = node.externalWork;
  return {
    doi: normalizeDOI(node.doi ?? external?.doi),
    pmid: external?.pmid?.trim() || null,
    arxiv: external?.arxiv?.trim() || null,
    isbn: external?.isbn?.trim() || null,
    title: node.title || external?.title || "",
    normalizedTitle: normalizeExactTitle(node.title || external?.title),
    year: node.year ?? external?.year ?? null,
    authors: node.authors.length ? node.authors : (external?.authors ?? []),
    sourceTitle: node.sourceTitle ?? external?.sourceTitle ?? null,
  };
}
