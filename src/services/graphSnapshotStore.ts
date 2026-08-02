import type {
  CitationGraphEdge,
  CitationGraphIndex,
  CitationGraphModel,
  CitationGraphNode,
} from "../domain/graphTypes";
import type { LibrarySnapshot } from "../domain/types";
import { graphNodeLookupAliases } from "../domain/workIdentity";
import { getCitationMetricsRevision } from "./citationMetricsStore";

const MAX_LIBRARY_SNAPSHOTS = 2;

export interface CitationGraphSnapshot {
  libraryID: number;
  /** Stable input signature used to decide whether the snapshot is reusable. */
  sourceSignature: string;
  /** Unique graph revision used by dependent projection caches. */
  signature: string;
  model: CitationGraphModel;
  index: CitationGraphIndex;
  builtAt: number;
}

const snapshotsByLibrary = new Map<number, CitationGraphSnapshot>();
const accessOrder: number[] = [];
const signatureBySnapshot = new WeakMap<
  LibrarySnapshot,
  { metricsRevision: number; signature: string }
>();
let snapshotGeneration = 0;

function touchLibrary(libraryID: number): void {
  const existing = accessOrder.indexOf(libraryID);
  if (existing >= 0) accessOrder.splice(existing, 1);
  accessOrder.push(libraryID);
  while (accessOrder.length > MAX_LIBRARY_SNAPSHOTS) {
    const evicted = accessOrder.shift();
    if (evicted !== undefined) snapshotsByLibrary.delete(evicted);
  }
}

export function citationGraphSnapshotSignature(
  snapshot: LibrarySnapshot,
): string {
  const metricsRevision = getCitationMetricsRevision();
  const cached = signatureBySnapshot.get(snapshot);
  if (cached?.metricsRevision === metricsRevision) return cached.signature;

  let hash = 2166136261;
  const append = (value: unknown): void => {
    const text = String(value ?? "");
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  };
  for (const paper of snapshot.papers) {
    append(paper.itemKey);
    append(paper.title);
    append(paper.year);
    append(paper.metrics.updatedAt);
    append(paper.metrics.citationCount);
    append(paper.metrics.referenceCount);
    append(paper.collectionIDs.join(","));
    append(paper.tags.join(","));
  }
  const signature = `${metricsRevision}:${snapshot.papers.length}:${
    hash >>> 0
  }`;
  signatureBySnapshot.set(snapshot, { metricsRevision, signature });
  return signature;
}

function cloneRelatedWork<T extends { authors?: string[] }>(work: T): T {
  return {
    ...work,
    ...(Array.isArray(work.authors) ? { authors: [...work.authors] } : {}),
  };
}

export function cloneCitationGraphNode(
  node: CitationGraphNode,
): CitationGraphNode {
  return {
    ...node,
    authors: [...node.authors],
    tags: [...node.tags],
    collectionIDs: [...node.collectionIDs],
    // Relationship metadata is treated as immutable graph input. Sharing these
    // potentially large arrays avoids duplicating whole bibliographies for
    // every open view while the node shell itself remains independently mutable.
    references: node.references,
    externalWork: node.externalWork
      ? cloneRelatedWork(node.externalWork)
      : null,
    sourceMetrics: node.sourceMetrics ? { ...node.sourceMetrics } : null,
  };
}

export function cloneCitationGraphModel(
  model: CitationGraphModel,
): CitationGraphModel {
  return {
    nodes: model.nodes.map(cloneCitationGraphNode),
    edges: model.edges.map((edge) => ({ ...edge })),
    statistics: { ...model.statistics },
  };
}

function addIndexEntry<T>(map: Map<string, T[]>, key: string, value: T): void {
  const entries = map.get(key) ?? [];
  entries.push(value);
  map.set(key, entries);
}

export function createCitationGraphIndex(
  model: CitationGraphModel,
): CitationGraphIndex {
  const nodeByKey = new Map<string, CitationGraphNode>();
  const outgoingEdgesByKey = new Map<string, CitationGraphEdge[]>();
  const incomingEdgesByKey = new Map<string, CitationGraphEdge[]>();
  const edgeByPair = new Map<string, CitationGraphEdge>();
  const nodesByAlias = new Map<string, CitationGraphNode[]>();

  for (const node of model.nodes) {
    nodeByKey.set(node.key, node);
    nodeByKey.set(node.itemKey, node);
    for (const alias of graphNodeLookupAliases(node)) {
      addIndexEntry(nodesByAlias, alias, node);
    }
  }
  for (const edge of model.edges) {
    addIndexEntry(outgoingEdgesByKey, edge.source, edge);
    addIndexEntry(incomingEdgesByKey, edge.target, edge);
    edgeByPair.set(`${edge.source}>${edge.target}`, edge);
  }

  return {
    nodeByKey,
    outgoingEdgesByKey,
    incomingEdgesByKey,
    edgeByPair,
    nodesByAlias,
  };
}

export function getCachedCitationGraphSnapshotByLibrary(
  libraryID: number,
): CitationGraphSnapshot | null {
  const cached = snapshotsByLibrary.get(libraryID) ?? null;
  if (cached) touchLibrary(libraryID);
  return cached;
}

export function getCachedCitationGraphSnapshot(
  snapshot: LibrarySnapshot,
): CitationGraphSnapshot | null {
  const cached = snapshotsByLibrary.get(snapshot.libraryID) ?? null;
  if (
    !cached ||
    cached.sourceSignature !== citationGraphSnapshotSignature(snapshot)
  ) {
    return null;
  }
  touchLibrary(snapshot.libraryID);
  return cached;
}

export function storeCitationGraphSnapshot(
  snapshot: LibrarySnapshot,
  model: CitationGraphModel,
): CitationGraphSnapshot {
  const canonicalModel = cloneCitationGraphModel(model);
  const sourceSignature = citationGraphSnapshotSignature(snapshot);
  const stored: CitationGraphSnapshot = {
    libraryID: snapshot.libraryID,
    sourceSignature,
    signature: `${sourceSignature}:g${++snapshotGeneration}`,
    model: canonicalModel,
    index: createCitationGraphIndex(canonicalModel),
    builtAt: Date.now(),
  };
  snapshotsByLibrary.set(snapshot.libraryID, stored);
  touchLibrary(snapshot.libraryID);
  return stored;
}

export function getOrCreateCitationGraphSnapshot(
  snapshot: LibrarySnapshot,
  build: () => CitationGraphModel,
): CitationGraphSnapshot {
  return (
    getCachedCitationGraphSnapshot(snapshot) ??
    storeCitationGraphSnapshot(snapshot, build())
  );
}

export interface CitationGraphDelta {
  updatedNodes?: readonly CitationGraphNode[];
  addedEdges?: readonly CitationGraphEdge[];
  removedEdges?: readonly { source: string; target: string }[];
  removedNodeKeys?: readonly string[];
}

export function applyCitationGraphDelta(
  libraryID: number,
  delta: CitationGraphDelta,
): CitationGraphSnapshot | null {
  const cached = snapshotsByLibrary.get(libraryID);
  if (!cached) return null;

  const removedNodeKeys = new Set(delta.removedNodeKeys ?? []);
  const updatedByKey = new Map(
    (delta.updatedNodes ?? []).map((node) => [node.key, node] as const),
  );
  const nodes = cached.model.nodes
    .filter((node) => !removedNodeKeys.has(node.key))
    .map((node) =>
      updatedByKey.has(node.key)
        ? cloneCitationGraphNode(updatedByKey.get(node.key)!)
        : node,
    );
  for (const [key, node] of updatedByKey) {
    if (!nodes.some((candidate) => candidate.key === key)) {
      nodes.push(cloneCitationGraphNode(node));
    }
  }

  const removedPairs = new Set(
    (delta.removedEdges ?? []).map((edge) => `${edge.source}>${edge.target}`),
  );
  const edgeByPair = new Map<string, CitationGraphEdge>();
  for (const edge of cached.model.edges) {
    const pair = `${edge.source}>${edge.target}`;
    if (
      removedPairs.has(pair) ||
      removedNodeKeys.has(edge.source) ||
      removedNodeKeys.has(edge.target)
    ) {
      continue;
    }
    edgeByPair.set(pair, edge);
  }
  for (const edge of delta.addedEdges ?? []) {
    edgeByPair.set(`${edge.source}>${edge.target}`, { ...edge });
  }
  const edges = [...edgeByPair.values()];
  const connected = new Set<string>();
  for (const edge of edges) {
    connected.add(edge.source);
    connected.add(edge.target);
  }
  const model: CitationGraphModel = {
    nodes,
    edges,
    statistics: {
      nodes: nodes.length,
      resolvedNodes: nodes.filter((node) => node.metricStatus === "success")
        .length,
      edges: edges.length,
      isolatedNodes: nodes.filter((node) => !connected.has(node.key)).length,
    },
  };
  cached.model = model;
  cached.index = createCitationGraphIndex(model);
  cached.signature = `${cached.sourceSignature}:g${++snapshotGeneration}`;
  cached.builtAt = Date.now();
  touchLibrary(libraryID);
  return cached;
}

export function invalidateCitationGraphSnapshot(libraryID: number): void {
  snapshotsByLibrary.delete(libraryID);
  const existing = accessOrder.indexOf(libraryID);
  if (existing >= 0) accessOrder.splice(existing, 1);
}

export function clearCitationGraphSnapshots(): void {
  snapshotsByLibrary.clear();
  accessOrder.splice(0);
}

export function citationGraphSnapshotCount(): number {
  return snapshotsByLibrary.size;
}
