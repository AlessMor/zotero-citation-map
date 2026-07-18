import type {
  CitationMetricRecord,
  CitationProviderID,
} from "../domain/citationTypes";
import type { CitationGraphEdge } from "../domain/graphTypes";
import { normalizeDOI } from "./citationIdentifiers";

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
  provider: CitationProviderID,
  value: string | null | undefined,
): string | null {
  let normalized = String(value ?? "").trim();

  if (!normalized) {
    return null;
  }

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

function providerIdentityKey(
  provider: CitationProviderID,
  providerWorkID: string | null | undefined,
): string | null {
  const normalized = normalizeProviderWorkID(provider, providerWorkID);
  return normalized ? `${provider}:${normalized}` : null;
}

export function resolveRecordCitationEdges(
  records: CitationMetricRecord[],
): CitationGraphEdge[] {
  const usable = records.filter((record) =>
    Boolean(record.doi || record.providerWorkID || record.references.length),
  );
  const keyByDOI = new Map<string, string>();
  const keyByProviderIdentity = new Map<string, string>();
  const genericProviderIDs = new Map<string, Set<string>>();

  for (const record of usable) {
    const doi = normalizeDOI(record.doi);
    if (doi && !keyByDOI.has(doi)) {
      keyByDOI.set(doi, record.itemKey);
    }

    if (record.providerWorkID) {
      const identity = providerIdentityKey(
        record.provider,
        record.providerWorkID,
      );
      if (identity && !keyByProviderIdentity.has(identity)) {
        keyByProviderIdentity.set(identity, record.itemKey);
      }

      const generic = normalizeProviderWorkID(
        record.provider,
        record.providerWorkID,
      );
      if (generic) {
        const keys = genericProviderIDs.get(generic) ?? new Set<string>();
        keys.add(record.itemKey);
        genericProviderIDs.set(generic, keys);
      }
    }
  }

  const allowedKeys = new Set(usable.map((record) => record.itemKey));
  const seen = new Set<string>();
  const edges: CitationGraphEdge[] = [];

  for (const source of usable) {
    for (const reference of source.references) {
      let targetKey: string | null = null;
      const doi = normalizeDOI(reference.doi);

      if (doi) {
        targetKey = keyByDOI.get(doi) ?? null;
      }

      if (!targetKey && reference.providerWorkID) {
        const identity = providerIdentityKey(
          source.provider,
          reference.providerWorkID,
        );
        if (identity) {
          targetKey = keyByProviderIdentity.get(identity) ?? null;
        }
      }

      if (!targetKey && reference.providerWorkID) {
        const generic = normalizeProviderWorkID(
          source.provider,
          reference.providerWorkID,
        );
        const candidates = generic
          ? genericProviderIDs.get(generic)
          : undefined;
        if (candidates?.size === 1) {
          targetKey = [...candidates][0];
        }
      }

      if (
        !targetKey ||
        targetKey === source.itemKey ||
        !allowedKeys.has(targetKey)
      ) {
        continue;
      }

      const key = `${source.itemKey}>${targetKey}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      edges.push({ key, source: source.itemKey, target: targetKey });
    }
  }

  return edges;
}

function createAdjacency(
  nodeKeys: string[],
  edges: CitationGraphEdge[],
): {
  indexByKey: Map<string, number>;
  outgoing: number[][];
  incoming: number[][];
  undirected: number[][];
} {
  const indexByKey = new Map(nodeKeys.map((key, index) => [key, index]));
  const outgoingSets = nodeKeys.map(() => new Set<number>());
  const incomingSets = nodeKeys.map(() => new Set<number>());
  const undirectedSets = nodeKeys.map(() => new Set<number>());

  for (const edge of edges) {
    const source = indexByKey.get(edge.source);
    const target = indexByKey.get(edge.target);
    if (source === undefined || target === undefined || source === target) {
      continue;
    }
    outgoingSets[source].add(target);
    incomingSets[target].add(source);
    undirectedSets[source].add(target);
    undirectedSets[target].add(source);
  }

  return {
    indexByKey,
    outgoing: outgoingSets.map((set) => [...set]),
    incoming: incomingSets.map((set) => [...set]),
    undirected: undirectedSets.map((set) => [...set]),
  };
}

function computePageRank(outgoing: number[][], incoming: number[][]): number[] {
  const count = outgoing.length;
  if (count === 0) {
    return [];
  }

  const damping = 0.85;
  let rank = Array.from({ length: count }, () => 1 / count);

  for (let iteration = 0; iteration < 60; iteration += 1) {
    const dangling = rank.reduce(
      (sum, value, index) => sum + (outgoing[index].length === 0 ? value : 0),
      0,
    );
    const base = (1 - damping) / count + (damping * dangling) / count;
    const next = Array.from({ length: count }, () => base);

    for (let target = 0; target < count; target += 1) {
      for (const source of incoming[target]) {
        const degree = outgoing[source].length;
        if (degree > 0) {
          next[target] += (damping * rank[source]) / degree;
        }
      }
    }

    const delta = next.reduce(
      (sum, value, index) => sum + Math.abs(value - rank[index]),
      0,
    );
    rank = next;
    if (delta < 1e-10) {
      break;
    }
  }

  const maximum = Math.max(...rank, 0);
  return maximum > 0 ? rank.map((value) => value / maximum) : rank;
}

function computeEigenvector(undirected: number[][]): number[] {
  const count = undirected.length;
  if (count === 0) {
    return [];
  }

  let vector = Array.from({ length: count }, () => 1 / Math.sqrt(count));

  for (let iteration = 0; iteration < 80; iteration += 1) {
    const next = undirected.map((neighbors) =>
      neighbors.reduce((sum, neighbor) => sum + vector[neighbor], 0),
    );
    const norm = Math.sqrt(next.reduce((sum, value) => sum + value * value, 0));
    if (norm === 0) {
      return Array.from({ length: count }, () => 0);
    }
    for (let index = 0; index < count; index += 1) {
      next[index] /= norm;
    }
    const delta = next.reduce(
      (sum, value, index) => sum + Math.abs(value - vector[index]),
      0,
    );
    vector = next;
    if (delta < 1e-10) {
      break;
    }
  }

  const maximum = Math.max(...vector, 0);
  return maximum > 0 ? vector.map((value) => value / maximum) : vector;
}

function computeComponentSizes(undirected: number[][]): number[] {
  const sizes = Array.from({ length: undirected.length }, () => 1);
  const visited = new Set<number>();

  for (let start = 0; start < undirected.length; start += 1) {
    if (visited.has(start)) {
      continue;
    }

    const component: number[] = [];
    const queue = [start];
    visited.add(start);

    while (queue.length > 0) {
      const node = queue.shift();
      if (node === undefined) {
        break;
      }
      component.push(node);
      for (const neighbor of undirected[node]) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }

    for (const node of component) {
      sizes[node] = component.length;
    }
  }

  return sizes;
}

function computeChainDepth(outgoing: number[][]): number[] {
  const memo = new Map<number, number>();
  const visiting = new Set<number>();

  const visit = (node: number): number => {
    const cached = memo.get(node);
    if (cached !== undefined) {
      return cached;
    }
    if (visiting.has(node)) {
      return 0;
    }

    visiting.add(node);
    let depth = 0;
    for (const target of outgoing[node]) {
      depth = Math.max(depth, 1 + visit(target));
    }
    visiting.delete(node);
    memo.set(node, depth);
    return depth;
  };

  return outgoing.map((_neighbors, index) => visit(index));
}

function sampleSourceIndices(count: number): number[] {
  const maximumSources = 256;
  if (count <= maximumSources) {
    return Array.from({ length: count }, (_value, index) => index);
  }

  return Array.from({ length: maximumSources }, (_value, index) =>
    Math.floor((index * count) / maximumSources),
  );
}

function computeBetweenness(outgoing: number[][]): number[] {
  const count = outgoing.length;
  const centrality = Array.from({ length: count }, () => 0);
  if (count < 3) {
    return centrality;
  }

  const sources = sampleSourceIndices(count);

  for (const source of sources) {
    const stack: number[] = [];
    const predecessors = Array.from({ length: count }, () => [] as number[]);
    const paths = Array.from({ length: count }, () => 0);
    const distance = Array.from({ length: count }, () => -1);
    paths[source] = 1;
    distance[source] = 0;
    const queue = [source];

    while (queue.length > 0) {
      const node = queue.shift();
      if (node === undefined) {
        break;
      }
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

    const dependency = Array.from({ length: count }, () => 0);
    while (stack.length > 0) {
      const node = stack.pop();
      if (node === undefined) {
        break;
      }
      for (const predecessor of predecessors[node]) {
        if (paths[node] > 0) {
          dependency[predecessor] +=
            (paths[predecessor] / paths[node]) * (1 + dependency[node]);
        }
      }
      if (node !== source) {
        centrality[node] += dependency[node];
      }
    }
  }

  const sampleFactor = count / sources.length;
  const normalization = (count - 1) * (count - 2);
  return centrality.map((value) =>
    Math.max(0, Math.min(1, (value * sampleFactor) / normalization)),
  );
}

export function computeNetworkAnalytics(
  nodeKeys: string[],
  edges: CitationGraphEdge[],
): Map<string, NetworkMetricValues> {
  const { outgoing, incoming, undirected } = createAdjacency(nodeKeys, edges);
  const pageRank = computePageRank(outgoing, incoming);
  const eigenvector = computeEigenvector(undirected);
  const componentSizes = computeComponentSizes(undirected);
  const chainDepth = computeChainDepth(outgoing);
  const betweenness = computeBetweenness(outgoing);

  const result = new Map<string, NetworkMetricValues>();
  for (let index = 0; index < nodeKeys.length; index += 1) {
    const incomingCount = incoming[index].length;
    const outgoingCount = outgoing[index].length;
    result.set(nodeKeys[index], {
      incoming: incomingCount,
      outgoing: outgoingCount,
      pageRank: pageRank[index] ?? 0,
      betweennessCentrality: betweenness[index] ?? 0,
      eigenvectorCentrality: eigenvector[index] ?? 0,
      componentSize: componentSizes[index] ?? 1,
      citationChainDepth: chainDepth[index] ?? 0,
      isIsolated: incomingCount === 0 && outgoingCount === 0,
    });
  }

  return result;
}
