import type {
  CitationMetricRecord,
  CitationProviderID,
  IgnoredProviderRelation,
  ManualCitationRelation,
} from "../domain/citationTypes";
import type { CitationGraphEdge } from "../domain/graphTypes";
import { normalizeDOI, normalizeExactTitle } from "./citationIdentifiers";

export interface NetworkMetricValues {
  incoming: number;
  outgoing: number;
  pageRank: number;
  betweennessCentrality: number;
  eigenvectorCentrality: number;
  componentSize: number;
  citationChainDepth: number;
  isIsolated: boolean;
}

function normalizeProviderWorkID(
  provider: CitationProviderID | "manual" | "zotero",
  value: string | null | undefined,
): string | null {
  let normalized = String(value ?? "").trim();
  if (!normalized) return null;
  if (provider === "openalex") {
    normalized = normalized.replace(/^https?:\/\/openalex\.org\//i, "");
  } else if (provider === "semantic-scholar") {
    normalized = normalized.replace(
      /^https?:\/\/(?:www\.)?semanticscholar\.org\/paper\//i,
      "",
    );
  }
  return normalized.toLocaleLowerCase();
}

function identityKey(
  provider: CitationProviderID | "manual" | "zotero",
  value: string | null | undefined,
): string | null {
  const normalized = normalizeProviderWorkID(provider, value);
  return normalized ? `${provider}:${normalized}` : null;
}

function ignoredKey(relation: {
  provider: string;
  providerWorkID?: string | null;
  doi?: string | null;
  normalizedTitle?: string | null;
}): string {
  return [
    relation.provider,
    normalizeProviderWorkID(
      relation.provider as CitationProviderID,
      relation.providerWorkID,
    ),
    normalizeDOI(relation.doi),
    relation.normalizedTitle ?? "",
  ].join("|");
}

export interface LocalCitationRelation {
  sourceItemKey: string;
  targetItemKey: string;
  provenance: "zotero-relation" | "note-extraction" | "pdf-extraction";
}

export function resolveRecordCitationEdges(
  records: CitationMetricRecord[],
  nodeKeys: string[],
  manualRelations: ManualCitationRelation[] = [],
  ignoredRelations: IgnoredProviderRelation[] = [],
  localRelations: LocalCitationRelation[] = [],
): CitationGraphEdge[] {
  const allowed = new Set(nodeKeys);
  const keyByDOI = new Map<string, string>();
  const keyByIdentity = new Map<string, string>();
  const keyByTitle = new Map<string, Set<string>>();
  for (const record of records) {
    if (!allowed.has(record.itemKey)) continue;
    const doi = normalizeDOI(record.doi);
    if (doi && !keyByDOI.has(doi)) keyByDOI.set(doi, record.itemKey);
    const identity = identityKey(record.provider, record.providerWorkID);
    if (identity && !keyByIdentity.has(identity)) {
      keyByIdentity.set(identity, record.itemKey);
    }
    const title = normalizeExactTitle(record.title);
    if (title) {
      const entries = keyByTitle.get(title) ?? new Set<string>();
      entries.add(record.itemKey);
      keyByTitle.set(title, entries);
    }
  }
  const ignoredBySubject = new Map<string, Set<string>>();
  for (const relation of ignoredRelations) {
    const set =
      ignoredBySubject.get(relation.subjectItemKey) ?? new Set<string>();
    set.add(ignoredKey(relation));
    ignoredBySubject.set(relation.subjectItemKey, set);
  }
  const edges: CitationGraphEdge[] = [];
  const seen = new Set<string>();
  const add = (
    source: string,
    target: string,
    provenance: string,
    manual: boolean,
  ): void => {
    if (!allowed.has(source) || !allowed.has(target) || source === target)
      return;
    const key = `${source}>${target}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({ key, source, target, provenance, manual });
  };

  for (const source of records) {
    if (!allowed.has(source.itemKey)) continue;
    const ignored = ignoredBySubject.get(source.itemKey) ?? new Set<string>();
    for (const reference of source.references) {
      const referenceKey = ignoredKey({
        provider: reference.provider,
        providerWorkID: reference.providerWorkID,
        doi: reference.doi,
        normalizedTitle: normalizeExactTitle(reference.title),
      });
      if (ignored.has(referenceKey)) continue;
      let target: string | null = null;
      const doi = normalizeDOI(reference.doi);
      if (doi) target = keyByDOI.get(doi) ?? null;
      if (!target) {
        const identity = identityKey(
          reference.provider,
          reference.providerWorkID,
        );
        if (identity) target = keyByIdentity.get(identity) ?? null;
      }
      if (!target) {
        const title = normalizeExactTitle(reference.title);
        const matches = title ? keyByTitle.get(title) : undefined;
        if (matches?.size === 1) target = [...matches][0];
      }
      if (target) add(source.itemKey, target, reference.provider, false);
    }
  }

  for (const relation of manualRelations) {
    if (relation.direction === "reference") {
      add(relation.subjectItemKey, relation.relatedItemKey, "manual", true);
    } else {
      add(relation.relatedItemKey, relation.subjectItemKey, "manual", true);
    }
  }
  for (const relation of localRelations) {
    add(
      relation.sourceItemKey,
      relation.targetItemKey,
      relation.provenance,
      false,
    );
  }
  return edges;
}

function adjacency(nodeKeys: string[], edges: CitationGraphEdge[]) {
  const index = new Map(nodeKeys.map((key, i) => [key, i]));
  const outgoingSets = nodeKeys.map(() => new Set<number>());
  const incomingSets = nodeKeys.map(() => new Set<number>());
  const undirectedSets = nodeKeys.map(() => new Set<number>());
  for (const edge of edges) {
    const source = index.get(edge.source);
    const target = index.get(edge.target);
    if (source === undefined || target === undefined || source === target)
      continue;
    outgoingSets[source].add(target);
    incomingSets[target].add(source);
    undirectedSets[source].add(target);
    undirectedSets[target].add(source);
  }
  return {
    outgoing: outgoingSets.map((value) => [...value]),
    incoming: incomingSets.map((value) => [...value]),
    undirected: undirectedSets.map((value) => [...value]),
  };
}

function pageRank(outgoing: number[][], incoming: number[][]): number[] {
  const n = outgoing.length;
  if (!n) return [];
  const damping = 0.85;
  let rank = Array.from({ length: n }, () => 1 / n);
  for (let iteration = 0; iteration < 60; iteration += 1) {
    const dangling = rank.reduce(
      (sum, value, i) => sum + (outgoing[i].length ? 0 : value),
      0,
    );
    const next = Array.from(
      { length: n },
      () => (1 - damping) / n + (damping * dangling) / n,
    );
    for (let target = 0; target < n; target += 1) {
      for (const source of incoming[target]) {
        if (outgoing[source].length) {
          next[target] += (damping * rank[source]) / outgoing[source].length;
        }
      }
    }
    const delta = next.reduce(
      (sum, value, i) => sum + Math.abs(value - rank[i]),
      0,
    );
    rank = next;
    if (delta < 1e-10) break;
  }
  const max = Math.max(...rank, 0);
  return max ? rank.map((value) => value / max) : rank;
}

function eigenvector(undirected: number[][]): number[] {
  const n = undirected.length;
  if (!n) return [];
  let vector = Array.from({ length: n }, () => 1 / Math.sqrt(n));
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const next = undirected.map((neighbors) =>
      neighbors.reduce((sum, neighbor) => sum + vector[neighbor], 0),
    );
    const norm = Math.sqrt(next.reduce((sum, value) => sum + value * value, 0));
    if (!norm) return Array.from({ length: n }, () => 0);
    for (let i = 0; i < n; i += 1) next[i] /= norm;
    const delta = next.reduce(
      (sum, value, i) => sum + Math.abs(value - vector[i]),
      0,
    );
    vector = next;
    if (delta < 1e-10) break;
  }
  const max = Math.max(...vector, 0);
  return max ? vector.map((value) => value / max) : vector;
}

function componentSizes(undirected: number[][]): number[] {
  const sizes = Array.from({ length: undirected.length }, () => 1);
  const visited = new Set<number>();
  for (let start = 0; start < undirected.length; start += 1) {
    if (visited.has(start)) continue;
    const component: number[] = [];
    const queue = [start];
    visited.add(start);
    while (queue.length) {
      const node = queue.shift()!;
      component.push(node);
      for (const neighbor of undirected[node]) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    for (const node of component) sizes[node] = component.length;
  }
  return sizes;
}

function chainDepth(outgoing: number[][]): number[] {
  const memo = new Map<number, number>();
  const visiting = new Set<number>();
  const visit = (node: number): number => {
    const cached = memo.get(node);
    if (cached !== undefined) return cached;
    if (visiting.has(node)) return 0;
    visiting.add(node);
    let depth = 0;
    for (const target of outgoing[node])
      depth = Math.max(depth, 1 + visit(target));
    visiting.delete(node);
    memo.set(node, depth);
    return depth;
  };
  return outgoing.map((_entry, index) => visit(index));
}

function betweenness(outgoing: number[][]): number[] {
  const n = outgoing.length;
  const centrality = Array.from({ length: n }, () => 0);
  const sourceCount = Math.min(n, 256);
  const sources = Array.from({ length: sourceCount }, (_entry, index) =>
    Math.floor((index * n) / Math.max(1, sourceCount)),
  );
  for (const source of sources) {
    const stack: number[] = [];
    const predecessors = Array.from({ length: n }, () => [] as number[]);
    const paths = Array.from({ length: n }, () => 0);
    const distance = Array.from({ length: n }, () => -1);
    paths[source] = 1;
    distance[source] = 0;
    const queue = [source];
    while (queue.length) {
      const node = queue.shift()!;
      stack.push(node);
      for (const target of outgoing[node]) {
        if (distance[target] < 0) {
          distance[target] = distance[node] + 1;
          queue.push(target);
        }
        if (distance[target] === distance[node] + 1) {
          paths[target] += paths[node];
          predecessors[target].push(node);
        }
      }
    }
    const dependency = Array.from({ length: n }, () => 0);
    while (stack.length) {
      const node = stack.pop()!;
      for (const predecessor of predecessors[node]) {
        if (paths[node]) {
          dependency[predecessor] +=
            (paths[predecessor] / paths[node]) * (1 + dependency[node]);
        }
      }
      if (node !== source) centrality[node] += dependency[node];
    }
  }
  const sampleFactor = sources.length ? n / sources.length : 1;
  const normalization = Math.max(1, (n - 1) * (n - 2));
  return centrality.map((value) =>
    Math.max(0, Math.min(1, (value * sampleFactor) / normalization)),
  );
}

export function computeNetworkAnalytics(
  nodeKeys: string[],
  edges: CitationGraphEdge[],
): Map<string, NetworkMetricValues> {
  const { outgoing, incoming, undirected } = adjacency(nodeKeys, edges);
  const ranks = pageRank(outgoing, incoming);
  const eigen = eigenvector(undirected);
  const components = componentSizes(undirected);
  const depths = chainDepth(outgoing);
  const between = betweenness(outgoing);
  const result = new Map<string, NetworkMetricValues>();
  for (let i = 0; i < nodeKeys.length; i += 1) {
    const incomingCount = incoming[i].length;
    const outgoingCount = outgoing[i].length;
    result.set(nodeKeys[i], {
      incoming: incomingCount,
      outgoing: outgoingCount,
      pageRank: ranks[i] ?? 0,
      betweennessCentrality: between[i] ?? 0,
      eigenvectorCentrality: eigen[i] ?? 0,
      componentSize: components[i] ?? 1,
      citationChainDepth: depths[i] ?? 0,
      isIsolated: incomingCount + outgoingCount === 0,
    });
  }
  return result;
}
