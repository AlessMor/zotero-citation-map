import type {
  CitationProviderID,
  RelatedWorkMetadata,
} from "../domain/citationTypes";
import { getProviderPlan } from "../providers/registry";
import {
  externalWorkCacheIdentity,
  normalizeIdentifier,
  normalizeExactTitle,
  relatedWorkStableAliases,
} from "./citationIdentifiers";
import { getProviderPreference } from "./citationPreferences";
import { maximumKnownCount } from "./citationCountPolicy";
import {
  cachedExternalWorkMetadata,
  getExternalRelationshipCacheEntry,
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
  const item = Zotero.Items.get(node.itemID) as Zotero.Item | null;
  const libraryID = Number(item?.libraryID);
  return Number.isFinite(libraryID)
    ? libraryID
    : Zotero.Libraries.userLibraryID;
}

export function relationshipStoreKey(
  node: RelationshipStoreSubject,
  direction: StoredRelationshipDirection,
  provider: CitationProviderID,
): string {
  return `v3:${direction}:library:${nodeLibraryID(node)}:item:${node.itemKey.toLocaleUpperCase()}:provider:${provider}`;
}

function normalizedSurname(value: string): string {
  const compact = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .trim();
  const parts = compact.split(/\s+/).filter(Boolean);
  return parts.at(-1) ?? compact;
}

function authorsCompatible(
  left: RelatedWorkMetadata,
  right: RelatedWorkMetadata,
): boolean {
  const leftIDs = new Set(
    (left.authorIDs ?? [])
      .map((value) => normalizeIdentifier(value))
      .filter((value): value is string => Boolean(value)),
  );
  const rightIDs = (right.authorIDs ?? [])
    .map((value) => normalizeIdentifier(value))
    .filter((value): value is string => Boolean(value));
  if (leftIDs.size && rightIDs.length) {
    return rightIDs.some((value) => leftIDs.has(value));
  }
  if (!left.authors.length || !right.authors.length) return true;
  const leftSurnames = new Set(
    left.authors.map(normalizedSurname).filter(Boolean),
  );
  return right.authors.some((author) =>
    leftSurnames.has(normalizedSurname(author)),
  );
}

function yearsCompatible(
  left: number | null | undefined,
  right: number | null | undefined,
): boolean {
  return left == null || right == null || Math.abs(left - right) <= 1;
}

function latestTimestamp(
  left: string | null | undefined,
  right: string | null | undefined,
): string | null {
  const candidates = [left, right]
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  return candidates.at(-1) ?? null;
}

function richerList<T>(
  left: T[] | null | undefined,
  right: T[] | null | undefined,
): T[] | undefined {
  const richer = (left?.length ?? 0) >= (right?.length ?? 0) ? left : right;
  return richer ?? undefined;
}

function mergeWorkMetadata(
  existing: RelatedWorkMetadata,
  incoming: RelatedWorkMetadata,
): RelatedWorkMetadata {
  const dataSources = new Set<CitationProviderID>();
  for (const source of existing.dataSources ?? []) dataSources.add(source);
  for (const source of incoming.dataSources ?? []) dataSources.add(source);
  if (existing.provider !== "manual" && existing.provider !== "zotero") {
    dataSources.add(existing.provider);
  }
  if (incoming.provider !== "manual" && incoming.provider !== "zotero") {
    dataSources.add(incoming.provider);
  }
  return {
    ...existing,
    provider:
      existing.provider === "manual" || existing.provider === "zotero"
        ? incoming.provider
        : existing.provider,
    providerWorkID: existing.providerWorkID ?? incoming.providerWorkID,
    doi: existing.doi ?? incoming.doi,
    pmid: existing.pmid ?? incoming.pmid,
    arxiv: existing.arxiv ?? incoming.arxiv,
    isbn: existing.isbn ?? incoming.isbn,
    title: existing.title?.trim() ? existing.title : incoming.title,
    year: existing.year ?? incoming.year,
    authors: existing.authors.length ? existing.authors : incoming.authors,
    authorIDs: [
      ...new Set([
        ...(existing.authorIDs ?? []),
        ...(incoming.authorIDs ?? []),
      ]),
    ],
    sourceTitle: existing.sourceTitle?.trim()
      ? existing.sourceTitle
      : incoming.sourceTitle,
    abstract: existing.abstract?.trim() ? existing.abstract : incoming.abstract,
    citationCount: maximumKnownCount([
      existing.citationCount,
      incoming.citationCount,
    ]),
    referenceCount: maximumKnownCount([
      existing.referenceCount,
      incoming.referenceCount,
    ]),
    citationCountsByYear: richerList(
      existing.citationCountsByYear,
      incoming.citationCountsByYear,
    ),
    references: richerList(existing.references, incoming.references),
    resolvedReferenceCount: maximumKnownCount([
      existing.resolvedReferenceCount,
      incoming.resolvedReferenceCount,
      existing.references?.length,
      incoming.references?.length,
    ]),
    fwci: existing.fwci ?? incoming.fwci,
    citationPercentile:
      existing.citationPercentile ?? incoming.citationPercentile,
    isTop1Percent: existing.isTop1Percent ?? incoming.isTop1Percent,
    isTop10Percent: existing.isTop10Percent ?? incoming.isTop10Percent,
    citationsLastYear: existing.citationsLastYear ?? incoming.citationsLastYear,
    citationVelocity: existing.citationVelocity ?? incoming.citationVelocity,
    citationAcceleration:
      existing.citationAcceleration ?? incoming.citationAcceleration,
    influentialCitationCount:
      existing.influentialCitationCount ?? incoming.influentialCitationCount,
    publicationType: existing.publicationType ?? incoming.publicationType,
    sourceMetrics: existing.sourceMetrics ?? incoming.sourceMetrics,
    referenceAgeMean: existing.referenceAgeMean ?? incoming.referenceAgeMean,
    referenceAgeSpread:
      existing.referenceAgeSpread ?? incoming.referenceAgeSpread,
    selfCitationEstimate:
      existing.selfCitationEstimate ?? incoming.selfCitationEstimate,
    futureReferenceCount:
      existing.futureReferenceCount ?? incoming.futureReferenceCount,
    metadataCompleteness:
      existing.metadataCompleteness ?? incoming.metadataCompleteness,
    isOpenAccess: existing.isOpenAccess ?? incoming.isOpenAccess,
    openAccessStatus: existing.openAccessStatus ?? incoming.openAccessStatus,
    isRetracted: existing.isRetracted ?? incoming.isRetracted,
    zoteroItemKey: existing.zoteroItemKey ?? incoming.zoteroItemKey,
    inLibraryItemKey:
      existing.inLibraryItemKey ?? incoming.inLibraryItemKey ?? null,
    dataSources: [...dataSources],
    updatedAt: latestTimestamp(existing.updatedAt, incoming.updatedAt),
  };
}

function enrichFromMetadataCache(
  work: RelatedWorkMetadata,
): RelatedWorkMetadata {
  const key = externalWorkCacheIdentity(work);
  const metadata = key ? cachedExternalWorkMetadata(key) : null;
  return metadata ? mergeWorkMetadata(work, metadata) : work;
}

class DisjointSet {
  private readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }

  find(index: number): number {
    let root = index;
    while (this.parent[root] !== root) root = this.parent[root];
    while (this.parent[index] !== index) {
      const next = this.parent[index];
      this.parent[index] = root;
      index = next;
    }
    return root;
  }

  union(left: number, right: number): void {
    const a = this.find(left);
    const b = this.find(right);
    if (a === b) return;
    this.parent[Math.max(a, b)] = Math.min(a, b);
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

  const set = new DisjointSet(input.length);
  const aliasOwner = new Map<string, number>();
  for (const [index, work] of input.entries()) {
    for (const alias of relatedWorkStableAliases(work)) {
      const owner = aliasOwner.get(alias);
      if (owner === undefined) aliasOwner.set(alias, index);
      else set.union(owner, index);
    }
  }

  // Exact-title matching is deliberately conservative. A cluster is merged by
  // title only when it has one compatible counterpart after stable-identifier
  // unions have already been applied.
  const byTitle = new Map<string, number[]>();
  for (const [index, work] of input.entries()) {
    const title = normalizeExactTitle(work.title);
    if (!title) continue;
    const entries = byTitle.get(title) ?? [];
    entries.push(index);
    byTitle.set(title, entries);
  }
  for (const indices of byTitle.values()) {
    for (const index of indices) {
      const compatibleRoots = new Set<number>();
      for (const candidate of indices) {
        if (candidate === index) continue;
        if (
          yearsCompatible(input[index].year, input[candidate].year) &&
          authorsCompatible(input[index], input[candidate])
        ) {
          compatibleRoots.add(set.find(candidate));
        }
      }
      compatibleRoots.delete(set.find(index));
      if (compatibleRoots.size === 1) {
        set.union(index, [...compatibleRoots][0]);
      }
    }
  }

  const merged = new Map<number, RelatedWorkMetadata>();
  const firstIndex = new Map<number, number>();
  for (const [index, work] of input.entries()) {
    const root = set.find(index);
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

export function getStoredProviderRelationshipEntry(
  node: RelationshipStoreSubject,
  direction: StoredRelationshipDirection,
  provider: CitationProviderID,
): ExternalRelationshipCacheEntry | null {
  return getExternalRelationshipCacheEntry(
    relationshipStoreKey(node, direction, provider),
  );
}

function selectedRelationshipProviders(
  direction: StoredRelationshipDirection,
): CitationProviderID[] {
  const preference = getProviderPreference();
  return getProviderPlan(
    direction === "references" ? "references" : "citations",
    preference,
  ).providers;
}

export function getStoredRelationshipEntry(
  node: RelationshipStoreSubject,
  direction: StoredRelationshipDirection,
): ExternalRelationshipCacheEntry | null {
  const entries = selectedRelationshipProviders(direction)
    .map((provider) =>
      getStoredProviderRelationshipEntry(node, direction, provider),
    )
    .filter((entry): entry is ExternalRelationshipCacheEntry => Boolean(entry));
  if (!entries.length) return null;
  return {
    relationshipKey: `v3:${direction}:library:${nodeLibraryID(node)}:item:${node.itemKey.toLocaleUpperCase()}:selected`,
    works: mergeRelatedWorkLists(...entries.map((entry) => entry.works)),
    fetchedAt: entries
      .map((entry) => entry.fetchedAt)
      .sort()
      .at(-1)!,
  };
}

export function getStoredRelationshipWorks(
  node: RelationshipStoreSubject,
  direction: StoredRelationshipDirection,
): RelatedWorkMetadata[] {
  return getStoredRelationshipEntry(node, direction)?.works ?? [];
}

export async function replaceStoredProviderRelationships(
  node: RelationshipStoreSubject,
  direction: StoredRelationshipDirection,
  provider: CitationProviderID,
  works: RelatedWorkMetadata[],
): Promise<RelatedWorkMetadata[]> {
  const snapshot = mergeRelatedWorkLists(works).map((work) => ({
    ...work,
    dataSources: [...new Set([...(work.dataSources ?? []), provider])],
  }));
  await saveExternalRelationshipCache(
    relationshipStoreKey(node, direction, provider),
    snapshot,
  );
  return snapshot;
}

/** Compatibility wrapper. New code should replace one provider snapshot. */
export async function mergeStoredRelationships(
  node: RelationshipStoreSubject,
  direction: StoredRelationshipDirection,
  works: RelatedWorkMetadata[],
): Promise<RelatedWorkMetadata[]> {
  const byProvider = new Map<CitationProviderID, RelatedWorkMetadata[]>();
  for (const work of works) {
    if (work.provider === "manual" || work.provider === "zotero") continue;
    const list = byProvider.get(work.provider) ?? [];
    list.push(work);
    byProvider.set(work.provider, list);
  }
  for (const [provider, providerWorks] of byProvider) {
    await replaceStoredProviderRelationships(
      node,
      direction,
      provider,
      providerWorks,
    );
  }
  return getStoredRelationshipWorks(node, direction);
}
