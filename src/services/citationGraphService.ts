import type {
  CitationGraphEdge,
  CitationGraphModel,
  CitationGraphNode,
} from "../domain/graphTypes";
import type { LibrarySnapshot } from "../domain/types";
import type {
  CitationMetricRecord,
  CitationProviderID,
} from "../domain/citationTypes";
import { getCitationMetricRecord } from "./citationMetricsStore";

function normalizeDOI(value: string | null | undefined): string | null {
  const normalized = String(value ?? "")
    .trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "")
    .replace(/^doi:\s*/i, "")
    .replace(/[\s.,;]+$/g, "")
    .toLocaleLowerCase();

  return normalized || null;
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

function createNode(
  snapshot: LibrarySnapshot,
  paperIndex: number,
  record: CitationMetricRecord | null,
): CitationGraphNode {
  const paper = snapshot.papers[paperIndex];

  return {
    key: paper.itemKey,
    itemID: paper.itemID,
    itemKey: paper.itemKey,
    title: paper.title,
    authors: [...paper.authors],
    year: paper.year,
    doi: normalizeDOI(paper.doi ?? record?.doi),
    tags: [...paper.tags],
    collectionIDs: [...paper.collectionIDs],
    citationCount: paper.citationCount,
    referenceCount: paper.referenceCount,
    metricsUpdatedAt: paper.metricsUpdatedAt,
    provider: record?.provider ?? null,
    providerWorkID: record?.providerWorkID ?? null,
    metricStatus: record?.status ?? null,
    resolvedReferenceCount: record?.resolvedReferenceCount ?? 0,
    incomingLibraryCitations: 0,
    outgoingLibraryReferences: 0,
  };
}

export function buildCitationGraph(
  snapshot: LibrarySnapshot,
): CitationGraphModel {
  const records = new Map<string, CitationMetricRecord | null>();
  const nodes = snapshot.papers.map((paper, index) => {
    const record = getCitationMetricRecord(paper.libraryID, paper.itemKey);
    records.set(paper.itemKey, record);
    return createNode(snapshot, index, record);
  });

  const nodeByKey = new Map(nodes.map((node) => [node.key, node]));
  const keyByDOI = new Map<string, string>();
  const keyByProviderIdentity = new Map<string, string>();
  const genericProviderIDs = new Map<string, Set<string>>();

  for (const node of nodes) {
    if (node.doi && !keyByDOI.has(node.doi)) {
      keyByDOI.set(node.doi, node.key);
    }

    if (node.provider && node.providerWorkID) {
      const identity = providerIdentityKey(node.provider, node.providerWorkID);
      if (identity && !keyByProviderIdentity.has(identity)) {
        keyByProviderIdentity.set(identity, node.key);
      }

      const generic = normalizeProviderWorkID(
        node.provider,
        node.providerWorkID,
      );
      if (generic) {
        const keys = genericProviderIDs.get(generic) ?? new Set<string>();
        keys.add(node.key);
        genericProviderIDs.set(generic, keys);
      }
    }
  }

  const edgeKeys = new Set<string>();
  const edges: CitationGraphEdge[] = [];

  for (const sourceNode of nodes) {
    const record = records.get(sourceNode.key);
    if (!record || record.status !== "success") {
      continue;
    }

    for (const reference of record.references) {
      let targetKey: string | null = null;
      const referenceDOI = normalizeDOI(reference.doi);

      if (referenceDOI) {
        targetKey = keyByDOI.get(referenceDOI) ?? null;
      }

      if (!targetKey && reference.providerWorkID) {
        const identity = providerIdentityKey(
          record.provider,
          reference.providerWorkID,
        );
        if (identity) {
          targetKey = keyByProviderIdentity.get(identity) ?? null;
        }
      }

      if (!targetKey && reference.providerWorkID) {
        const generic = normalizeProviderWorkID(
          record.provider,
          reference.providerWorkID,
        );
        const candidates = generic
          ? genericProviderIDs.get(generic)
          : undefined;

        if (candidates?.size === 1) {
          targetKey = [...candidates][0];
        }
      }

      if (!targetKey || targetKey === sourceNode.key) {
        continue;
      }

      const edgeKey = `${sourceNode.key}>${targetKey}`;
      if (edgeKeys.has(edgeKey)) {
        continue;
      }

      const targetNode = nodeByKey.get(targetKey);
      if (!targetNode) {
        continue;
      }

      edgeKeys.add(edgeKey);
      edges.push({
        key: edgeKey,
        source: sourceNode.key,
        target: targetKey,
      });

      sourceNode.outgoingLibraryReferences += 1;
      targetNode.incomingLibraryCitations += 1;
    }
  }

  return {
    nodes,
    edges,
    statistics: {
      nodes: nodes.length,
      resolvedNodes: nodes.filter((node) => node.metricStatus === "success")
        .length,
      edges: edges.length,
      isolatedNodes: nodes.filter(
        (node) =>
          node.incomingLibraryCitations === 0 &&
          node.outgoingLibraryReferences === 0,
      ).length,
    },
  };
}
