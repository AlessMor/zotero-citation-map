import type {
  CitationMetricRecord,
  CitationProviderID,
  IgnoredProviderRelation,
  ManualCitationRelation,
} from "../domain/citationTypes";
import type { CitationGraphEdge } from "../domain/graphTypes";
import { normalizeDOI, normalizeExactTitle } from "./citationIdentifiers";

/**
 * Only transparent local connection counts are retained. Legacy fields remain
 * temporarily in the interface so old caches and downstream object shapes can
 * be read without a destructive migration; they are no longer calculated or
 * exposed as properties.
 */
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
    if (!allowed.has(source) || !allowed.has(target) || source === target) {
      return;
    }
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

export function computeNetworkAnalytics(
  nodeKeys: string[],
  edges: CitationGraphEdge[],
): Map<string, NetworkMetricValues> {
  const allowed = new Set(nodeKeys);
  const incoming = new Map(nodeKeys.map((key) => [key, new Set<string>()]));
  const outgoing = new Map(nodeKeys.map((key) => [key, new Set<string>()]));
  for (const edge of edges) {
    if (!allowed.has(edge.source) || !allowed.has(edge.target)) continue;
    outgoing.get(edge.source)?.add(edge.target);
    incoming.get(edge.target)?.add(edge.source);
  }
  return new Map(
    nodeKeys.map((key) => {
      const incomingCount = incoming.get(key)?.size ?? 0;
      const outgoingCount = outgoing.get(key)?.size ?? 0;
      return [
        key,
        {
          incoming: incomingCount,
          outgoing: outgoingCount,
          pageRank: 0,
          betweennessCentrality: 0,
          eigenvectorCentrality: 0,
          componentSize: 0,
          citationChainDepth: 0,
          isIsolated: incomingCount + outgoingCount === 0,
        },
      ];
    }),
  );
}
