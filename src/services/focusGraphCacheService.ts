import type { ExternalWork } from "../domain/externalWork";
import { relationshipCandidateIdentity } from "../domain/workIdentity";
import type {
  GraphFocusProjection,
  GraphFocusState,
} from "./graphFocusService";
import { cloneCitationGraphNode } from "./graphSnapshotStore";

const MAX_FRAGMENT_ENTRIES = 64;
const MAX_PROJECTION_ENTRIES = 24;

interface FocusRelationshipFragment {
  references: ExternalWork[];
  citedBy: ExternalWork[];
  fingerprint: string;
  revision: number;
  touchedAt: number;
}

interface CachedProjection {
  projection: GraphFocusProjection;
  touchedAt: number;
}

const fragments = new Map<string, FocusRelationshipFragment>();
const projections = new Map<string, CachedProjection>();
let fragmentRevision = 0;

function fragmentKey(libraryID: number, seedKey: string): string {
  return `${libraryID}:${seedKey}`;
}

function cloneWork(work: ExternalWork): ExternalWork {
  return {
    ...work,
    authors: [...(work.authors ?? [])],
    // Nested bibliographies are immutable provider data and are not needed for
    // editing the cached fragment, so keep one shared reference instead of
    // recursively cloning large graphs.
    references: work.references,
    citationCountsByYear: work.citationCountsByYear?.map((entry) => ({
      ...entry,
    })),
    sourceMetrics: work.sourceMetrics
      ? { ...work.sourceMetrics }
      : work.sourceMetrics,
  };
}

function cloneWorks(works: readonly ExternalWork[]): ExternalWork[] {
  return works.map(cloneWork);
}

function workFingerprint(work: ExternalWork): string {
  return [
    relationshipCandidateIdentity(work),
    work.provider,
    work.providerWorkID ?? "",
    work.year ?? "",
    work.citationCount ?? "",
    work.referenceCount ?? "",
    work.title ?? "",
    work.authors.join(";"),
    work.sourceTitle ?? "",
    work.publicationDate ?? "",
    work.updatedAt ?? "",
  ].join("|");
}

function fragmentFingerprint(
  references: readonly ExternalWork[],
  citedBy: readonly ExternalWork[],
): string {
  const hash = (values: readonly ExternalWork[]): string =>
    values.map(workFingerprint).join("\u001e");
  return `${hash(references)}\u001f${hash(citedBy)}`;
}

function evictOldest<T extends { touchedAt: number }>(
  map: Map<string, T>,
  maximum: number,
): void {
  while (map.size > maximum) {
    let oldestKey: string | null = null;
    let oldest = Infinity;
    for (const [key, value] of map) {
      if (value.touchedAt < oldest) {
        oldest = value.touchedAt;
        oldestKey = key;
      }
    }
    if (oldestKey === null) return;
    map.delete(oldestKey);
  }
}

export function getFocusRelationshipFragment(
  libraryID: number,
  seedKey: string,
): { references: ExternalWork[]; citedBy: ExternalWork[] } | null {
  const cached = fragments.get(fragmentKey(libraryID, seedKey));
  if (!cached) return null;
  cached.touchedAt = Date.now();
  return {
    references: cloneWorks(cached.references),
    citedBy: cloneWorks(cached.citedBy),
  };
}

export function setFocusRelationshipFragment(
  libraryID: number,
  seedKey: string,
  relationships: {
    references: readonly ExternalWork[];
    citedBy: readonly ExternalWork[];
  },
): number {
  const key = fragmentKey(libraryID, seedKey);
  const fingerprint = fragmentFingerprint(
    relationships.references,
    relationships.citedBy,
  );
  const existing = fragments.get(key);
  if (existing?.fingerprint === fingerprint) {
    existing.touchedAt = Date.now();
    return existing.revision;
  }
  const revision = ++fragmentRevision;
  fragments.set(key, {
    references: cloneWorks(relationships.references),
    citedBy: cloneWorks(relationships.citedBy),
    fingerprint,
    revision,
    touchedAt: Date.now(),
  });
  evictOldest(fragments, MAX_FRAGMENT_ENTRIES);
  return revision;
}

export function invalidateFocusRelationshipFragment(
  libraryID: number,
  seedKey: string,
): void {
  fragments.delete(fragmentKey(libraryID, seedKey));
  ++fragmentRevision;
}

function fragmentRevisionKey(
  libraryID: number,
  seedKeys: readonly string[],
): string {
  return [...new Set(seedKeys)]
    .sort()
    .map((seedKey) => {
      const cached = fragments.get(fragmentKey(libraryID, seedKey));
      return `${seedKey}:${cached?.revision ?? 0}`;
    })
    .join(",");
}

function focusStateKey(state: GraphFocusState): string {
  return [
    [...new Set(state.seedKeys)].join(","),
    state.direction,
    state.locality,
    state.ranking,
    state.maxPerDirection,
  ].join("|");
}

export function focusProjectionCacheKey(
  libraryID: number,
  graphRevision: string,
  state: GraphFocusState,
): string {
  return [
    libraryID,
    graphRevision,
    focusStateKey(state),
    fragmentRevisionKey(libraryID, state.seedKeys),
    fragmentRevision,
  ].join("::");
}

function cloneProjection(
  projection: GraphFocusProjection,
): GraphFocusProjection {
  return {
    state: { ...projection.state, seedKeys: [...projection.state.seedKeys] },
    seeds: projection.seeds.map(cloneCitationGraphNode),
    nodes: projection.nodes.map(cloneCitationGraphNode),
    edges: projection.edges.map((edge) => ({ ...edge })),
    seedKeys: new Set(projection.seedKeys),
    externalKeys: new Set(projection.externalKeys),
    hidden: { ...projection.hidden },
  };
}

export function getCachedFocusProjection(
  key: string,
): GraphFocusProjection | null {
  const cached = projections.get(key);
  if (!cached) return null;
  cached.touchedAt = Date.now();
  return cloneProjection(cached.projection);
}

export function setCachedFocusProjection(
  key: string,
  projection: GraphFocusProjection,
): void {
  projections.set(key, {
    projection: cloneProjection(projection),
    touchedAt: Date.now(),
  });
  evictOldest(projections, MAX_PROJECTION_ENTRIES);
}

export function clearFocusGraphCachesForLibrary(libraryID: number): void {
  const prefix = `${libraryID}:`;
  for (const key of [...fragments.keys()]) {
    if (key.startsWith(prefix)) fragments.delete(key);
  }
  const projectionPrefix = `${libraryID}::`;
  for (const key of [...projections.keys()]) {
    if (key.startsWith(projectionPrefix)) projections.delete(key);
  }
  ++fragmentRevision;
}

export function clearFocusGraphCaches(): void {
  fragments.clear();
  projections.clear();
  ++fragmentRevision;
}

export function focusGraphCacheStats(): {
  fragments: number;
  projections: number;
} {
  return { fragments: fragments.size, projections: projections.size };
}
