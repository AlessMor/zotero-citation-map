import type { RelatedWorkMetadata } from "../domain/citationTypes";
import type { CitationGraphNode } from "../domain/graphTypes";
import { normalizeDOI, normalizeExactTitle } from "./citationIdentifiers";
import {
  getExternalRelationshipCacheEntry,
  saveExternalRelationshipCache,
  type ExternalRelationshipCacheEntry,
} from "./externalWorkCacheService";

export type StoredRelationshipDirection = "references" | "cited-by";

function nodeLibraryID(node: CitationGraphNode): number {
  const item = Zotero.Items.get(node.itemID) as Zotero.Item | null;
  const libraryID = Number(item?.libraryID);
  return Number.isFinite(libraryID)
    ? libraryID
    : Zotero.Libraries.userLibraryID;
}

export function relationshipStoreKey(
  node: CitationGraphNode,
  direction: StoredRelationshipDirection,
): string {
  return `v2:${direction}:library:${nodeLibraryID(node)}:item:${node.itemKey}`;
}

function legacyRelationshipKeys(
  node: CitationGraphNode,
  direction: StoredRelationshipDirection,
): string[] {
  const keys = [
    `${direction}:library:${nodeLibraryID(node)}:item:${node.itemKey}`,
  ];
  const doi = normalizeDOI(node.doi);
  if (doi) keys.push(`${direction}:doi:${doi}`);
  if (node.provider && node.providerWorkID) {
    keys.push(
      `${direction}:provider:${node.provider}:${node.providerWorkID.toLocaleLowerCase()}`,
    );
  }
  const title = normalizeExactTitle(node.title);
  if (title) {
    keys.push(`${direction}:title:${title}:year:${node.year ?? "unknown"}`);
  }
  return keys;
}

function workIdentity(work: RelatedWorkMetadata): string {
  const localKey = work.zoteroItemKey?.trim();
  if (localKey) return `zotero:${localKey.toLocaleUpperCase()}`;
  const doi = normalizeDOI(work.doi);
  if (doi) return `doi:${doi}`;
  if (work.providerWorkID?.trim()) {
    return `${work.provider}:${work.providerWorkID.trim().toLocaleLowerCase()}`;
  }
  const title = normalizeExactTitle(work.title);
  if (title) return `title:${title}:year:${work.year ?? "unknown"}`;
  return `${work.provider}:unknown:${JSON.stringify([
    work.authors.slice(0, 2),
    work.year,
    work.sourceTitle ?? null,
  ])}`;
}

function mergeWorkMetadata(
  existing: RelatedWorkMetadata,
  incoming: RelatedWorkMetadata,
): RelatedWorkMetadata {
  return {
    ...existing,
    ...incoming,
    providerWorkID: incoming.providerWorkID ?? existing.providerWorkID,
    doi: incoming.doi ?? existing.doi,
    pmid: incoming.pmid ?? existing.pmid,
    arxiv: incoming.arxiv ?? existing.arxiv,
    isbn: incoming.isbn ?? existing.isbn,
    title: incoming.title?.trim() ? incoming.title : existing.title,
    year: incoming.year ?? existing.year,
    authors: incoming.authors.length ? incoming.authors : existing.authors,
    sourceTitle: incoming.sourceTitle?.trim()
      ? incoming.sourceTitle
      : existing.sourceTitle,
    abstract: incoming.abstract?.trim() ? incoming.abstract : existing.abstract,
    citationCount: incoming.citationCount ?? existing.citationCount,
    referenceCount: incoming.referenceCount ?? existing.referenceCount,
    isOpenAccess: incoming.isOpenAccess ?? existing.isOpenAccess,
    openAccessStatus: incoming.openAccessStatus ?? existing.openAccessStatus,
    isRetracted: incoming.isRetracted ?? existing.isRetracted,
    zoteroItemKey: incoming.zoteroItemKey ?? existing.zoteroItemKey,
  };
}

export function mergeRelatedWorkLists(
  ...groups: RelatedWorkMetadata[][]
): RelatedWorkMetadata[] {
  const merged = new Map<string, RelatedWorkMetadata>();
  for (const group of groups) {
    for (const work of group) {
      const key = workIdentity(work);
      const previous = merged.get(key);
      merged.set(
        key,
        previous ? mergeWorkMetadata(previous, work) : { ...work },
      );
    }
  }
  return [...merged.values()];
}

export function getStoredRelationshipEntry(
  node: CitationGraphNode,
  direction: StoredRelationshipDirection,
): ExternalRelationshipCacheEntry | null {
  const keys = [
    relationshipStoreKey(node, direction),
    ...legacyRelationshipKeys(node, direction),
  ];
  const entries = keys
    .map((key) => getExternalRelationshipCacheEntry(key))
    .filter((entry): entry is ExternalRelationshipCacheEntry => Boolean(entry));
  if (!entries.length) return null;
  const fetchedAt = entries
    .map((entry) => entry.fetchedAt)
    .sort()
    .at(-1)!;
  return {
    relationshipKey: relationshipStoreKey(node, direction),
    works: mergeRelatedWorkLists(...entries.map((entry) => entry.works)),
    fetchedAt,
  };
}

export function getStoredRelationshipWorks(
  node: CitationGraphNode,
  direction: StoredRelationshipDirection,
): RelatedWorkMetadata[] {
  return getStoredRelationshipEntry(node, direction)?.works ?? [];
}

export async function mergeStoredRelationships(
  node: CitationGraphNode,
  direction: StoredRelationshipDirection,
  works: RelatedWorkMetadata[],
): Promise<RelatedWorkMetadata[]> {
  const existing = getStoredRelationshipWorks(node, direction);
  const merged = mergeRelatedWorkLists(existing, works);
  await saveExternalRelationshipCache(
    relationshipStoreKey(node, direction),
    merged,
  );
  return merged;
}
