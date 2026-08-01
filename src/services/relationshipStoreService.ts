import type {
  CitationProviderID,
  RelatedWorkMetadata,
} from "../domain/citationTypes";
import {
  bibliographicWorkAliases,
  matchRelatedWorks,
  relationshipStableAliases,
  stableExternalWorkIdentity,
} from "../domain/workIdentity";
import {
  CANONICAL_RELATED_WORK_MERGE,
  mergeRelatedWorkRecords,
} from "../domain/relatedWorkMetadata";
import {
  cachedExternalWorkMetadata,
  getExternalRelationshipCacheEntry,
  getExternalRelationshipCacheSize,
  saveExternalRelationshipCache,
  type ExternalRelationshipCacheEntry,
} from "./externalWorkCacheService";

export type StoredRelationshipDirection = "references" | "cited-by";

export interface RelationshipStoreSubject {
  itemID: number;
  itemKey: string;
  doi: string | null;
  provider: CitationProviderID | null;
  providerWorkID: string | null;
  title: string;
  year: number | null;
}

function nodeLibraryID(node: RelationshipStoreSubject): number {
  if (node.itemID > 0) {
    try {
      const item = Zotero.Items.get(node.itemID) as Zotero.Item | null;
      const libraryID = Number(item?.libraryID);
      if (Number.isFinite(libraryID)) return libraryID;
    } catch {
      // External focus nodes deliberately have no Zotero item.
    }
  }
  return Zotero.Libraries.userLibraryID;
}

function selectedRelationshipStoreKey(
  node: RelationshipStoreSubject,
  direction: StoredRelationshipDirection,
): string {
  return `v4:${direction}:library:${nodeLibraryID(node)}:item:${node.itemKey.toLocaleUpperCase()}:selected`;
}

function mergeWorkMetadata(
  existing: RelatedWorkMetadata,
  incoming: RelatedWorkMetadata,
): RelatedWorkMetadata {
  return mergeRelatedWorkRecords(
    existing,
    incoming,
    CANONICAL_RELATED_WORK_MERGE,
  );
}

function enrichFromMetadataCache(
  work: RelatedWorkMetadata,
): RelatedWorkMetadata {
  const key = stableExternalWorkIdentity(work);
  const metadata = key ? cachedExternalWorkMetadata(key) : null;
  return metadata ? mergeWorkMetadata(work, metadata) : work;
}

function findRoot(parent: number[], index: number): number {
  let root = index;
  while (parent[root] !== root) root = parent[root];
  let current = index;
  while (parent[current] !== current) {
    const next = parent[current];
    parent[current] = root;
    current = next;
  }
  return root;
}

function unionRoots(parent: number[], left: number, right: number): void {
  const leftRoot = findRoot(parent, left);
  const rightRoot = findRoot(parent, right);
  if (leftRoot === rightRoot) return;
  parent[Math.max(leftRoot, rightRoot)] = Math.min(leftRoot, rightRoot);
}

function unionMatchingBucket(
  parent: number[],
  input: RelatedWorkMetadata[],
  indices: number[],
): void {
  for (let position = 1; position < indices.length; position += 1) {
    const index = indices[position];
    for (
      let candidatePosition = 0;
      candidatePosition < position;
      candidatePosition += 1
    ) {
      const candidate = indices[candidatePosition];
      if (
        matchRelatedWorks(input[index], input[candidate]).decision ===
        "same-work"
      ) {
        unionRoots(parent, index, candidate);
        break;
      }
    }
  }
}

/**
 * Build a canonical union of relationship records. A record that bridges two
 * previously separate aliases (for example, a DOI from one provider and a
 * provider ID from another) collapses both clusters instead of creating a
 * third duplicate.
 */
export function mergeRelatedWorkLists(
  ...groups: RelatedWorkMetadata[][]
): RelatedWorkMetadata[] {
  const input = groups
    .flat()
    .map((work) => enrichFromMetadataCache({ ...work }));
  if (input.length < 2) return input;

  const parent = Array.from({ length: input.length }, (_, index) => index);
  const byAlias = new Map<string, number[]>();
  for (const [index, work] of input.entries()) {
    for (const alias of relationshipStableAliases(work)) {
      const indices = byAlias.get(alias) ?? [];
      indices.push(index);
      byAlias.set(alias, indices);
    }
  }
  for (const indices of byAlias.values()) {
    if (indices.length > 1) unionMatchingBucket(parent, input, indices);
  }

  // Exact-title matching is deliberately conservative. A cluster is merged by
  // title only when it has one compatible counterpart after stable-identifier
  // unions have already been applied.
  const byBibliographicAlias = new Map<string, number[]>();
  for (const [index, work] of input.entries()) {
    for (const alias of bibliographicWorkAliases(work)) {
      const indices = byBibliographicAlias.get(alias) ?? [];
      indices.push(index);
      byBibliographicAlias.set(alias, indices);
    }
  }
  for (const indices of byBibliographicAlias.values()) {
    if (indices.length > 1) unionMatchingBucket(parent, input, indices);
  }

  const merged = new Map<number, RelatedWorkMetadata>();
  const firstIndex = new Map<number, number>();
  for (const [index, work] of input.entries()) {
    const root = findRoot(parent, index);
    firstIndex.set(root, Math.min(firstIndex.get(root) ?? index, index));
    const previous = merged.get(root);
    merged.set(root, previous ? mergeWorkMetadata(previous, work) : work);
  }
  return [...merged.entries()]
    .sort(
      ([left], [right]) =>
        (firstIndex.get(left) ?? left) - (firstIndex.get(right) ?? right),
    )
    .map(([, work]) => work);
}

export function getStoredRelationshipEntry(
  node: RelationshipStoreSubject,
  direction: StoredRelationshipDirection,
): ExternalRelationshipCacheEntry | null {
  return getExternalRelationshipCacheEntry(
    selectedRelationshipStoreKey(node, direction),
  );
}

export function getStoredRelationshipWorks(
  node: RelationshipStoreSubject,
  direction: StoredRelationshipDirection,
): RelatedWorkMetadata[] {
  return getStoredRelationshipEntry(node, direction)?.works ?? [];
}

export function getStoredRelationshipCount(
  node: RelationshipStoreSubject,
  direction: StoredRelationshipDirection,
): number {
  return getExternalRelationshipCacheSize(
    selectedRelationshipStoreKey(node, direction),
  );
}

export async function replaceStoredRelationshipSelection(
  node: RelationshipStoreSubject,
  direction: StoredRelationshipDirection,
  works: RelatedWorkMetadata[],
): Promise<RelatedWorkMetadata[]> {
  const snapshot = mergeRelatedWorkLists(works);
  await saveExternalRelationshipCache(
    selectedRelationshipStoreKey(node, direction),
    snapshot,
  );
  return snapshot;
}
