import type {
  CitationMetricRecord,
  CitationProviderID,
  IgnoredProviderRelation,
  ManualCitationRelation,
  RelatedWorkMetadata,
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

export interface LocalWorkIdentity {
  itemKey: string;
  doi: string | null;
  title: string | null;
  year: number | null;
  provider: CitationProviderID | null;
  providerWorkID: string | null;
}

export interface CitationReferenceSources {
  localWorks?: readonly LocalWorkIdentity[];
  storedReferencesBySource?: ReadonlyMap<
    string,
    readonly RelatedWorkMetadata[]
  >;
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

function normalizeItemKey(value: unknown): string | null {
  const key = String(value ?? "").trim();
  return key ? key.toLocaleUpperCase() : null;
}

function explicitLocalTarget(
  reference: RelatedWorkMetadata,
  allowed: Set<string>,
): string | null {
  const extended = reference as RelatedWorkMetadata & {
    inLibraryItemKey?: string | null;
  };
  const key = normalizeItemKey(
    extended.inLibraryItemKey ?? reference.zoteroItemKey,
  );
  return key && allowed.has(key) ? key : null;
}

function compatibleTitleTarget(
  reference: RelatedWorkMetadata,
  candidates: readonly LocalWorkIdentity[],
): string | null {
  const compatible = candidates.filter(
    (candidate) =>
      reference.year === null ||
      reference.year === undefined ||
      candidate.year === null ||
      Math.abs(reference.year - candidate.year) <= 1,
  );
  if (compatible.length === 1) return compatible[0].itemKey;
  if (reference.year !== null && reference.year !== undefined) {
    const exactYear = compatible.filter(
      (candidate) => candidate.year === reference.year,
    );
    if (exactYear.length === 1) return exactYear[0].itemKey;
  }
  return null;
}

function mergeLocalIdentity(
  current: LocalWorkIdentity | undefined,
  incoming: LocalWorkIdentity,
): LocalWorkIdentity {
  if (!current) return incoming;
  return {
    itemKey: current.itemKey,
    doi: current.doi ?? incoming.doi,
    title: current.title?.trim() ? current.title : incoming.title,
    year: current.year ?? incoming.year,
    provider: current.provider ?? incoming.provider,
    providerWorkID: current.providerWorkID ?? incoming.providerWorkID,
  };
}

export function resolveRecordCitationEdges(
  records: CitationMetricRecord[],
  nodeKeys: string[],
  manualRelations: ManualCitationRelation[] = [],
  ignoredRelations: IgnoredProviderRelation[] = [],
  localRelations: LocalCitationRelation[] = [],
  referenceSources: CitationReferenceSources = {},
): CitationGraphEdge[] {
  const allowed = new Set(nodeKeys.map((key) => key.toLocaleUpperCase()));
  const recordByItemKey = new Map(
    records
      .filter((record) => allowed.has(record.itemKey.toLocaleUpperCase()))
      .map((record) => [record.itemKey.toLocaleUpperCase(), record]),
  );
  const localByItemKey = new Map<string, LocalWorkIdentity>();

  const addLocalIdentity = (work: LocalWorkIdentity): void => {
    const itemKey = work.itemKey.toLocaleUpperCase();
    if (!allowed.has(itemKey)) return;
    localByItemKey.set(
      itemKey,
      mergeLocalIdentity(localByItemKey.get(itemKey), {
        ...work,
        itemKey,
      }),
    );
  };

  for (const work of referenceSources.localWorks ?? []) addLocalIdentity(work);
  for (const record of records) {
    addLocalIdentity({
      itemKey: record.itemKey,
      doi: record.doi,
      title: record.title,
      year: record.year,
      provider: record.provider,
      providerWorkID: record.providerWorkID,
    });
  }

  const keyByDOI = new Map<string, string>();
  const keyByIdentity = new Map<string, string>();
  const worksByTitle = new Map<string, LocalWorkIdentity[]>();
  for (const work of localByItemKey.values()) {
    const doi = normalizeDOI(work.doi);
    if (doi && !keyByDOI.has(doi)) keyByDOI.set(doi, work.itemKey);
    if (work.provider) {
      const identity = identityKey(work.provider, work.providerWorkID);
      if (identity && !keyByIdentity.has(identity)) {
        keyByIdentity.set(identity, work.itemKey);
      }
    }
    const title = normalizeExactTitle(work.title);
    if (title) {
      const entries = worksByTitle.get(title) ?? [];
      if (!entries.some((entry) => entry.itemKey === work.itemKey)) {
        entries.push(work);
      }
      worksByTitle.set(title, entries);
    }
  }

  const ignoredBySubject = new Map<string, Set<string>>();
  for (const relation of ignoredRelations) {
    const subjectKey = relation.subjectItemKey.toLocaleUpperCase();
    const set = ignoredBySubject.get(subjectKey) ?? new Set<string>();
    set.add(ignoredKey(relation));
    ignoredBySubject.set(subjectKey, set);
  }

  const edges: CitationGraphEdge[] = [];
  const seen = new Set<string>();
  const add = (
    source: string,
    target: string,
    provenance: string,
    manual: boolean,
  ): void => {
    const normalizedSource = source.toLocaleUpperCase();
    const normalizedTarget = target.toLocaleUpperCase();
    if (
      !allowed.has(normalizedSource) ||
      !allowed.has(normalizedTarget) ||
      normalizedSource === normalizedTarget
    ) {
      return;
    }
    const key = `${normalizedSource}>${normalizedTarget}`;
    if (seen.has(key)) return;
    seen.add(key);
    edges.push({
      key,
      source: normalizedSource,
      target: normalizedTarget,
      provenance,
      manual,
    });
  };

  for (const rawSourceKey of nodeKeys) {
    const sourceItemKey = rawSourceKey.toLocaleUpperCase();
    const sourceRecord = recordByItemKey.get(sourceItemKey);
    const storedReferences =
      referenceSources.storedReferencesBySource?.get(sourceItemKey) ??
      referenceSources.storedReferencesBySource?.get(rawSourceKey) ??
      [];
    const references = [
      ...(sourceRecord?.references ?? []),
      ...storedReferences,
    ];
    const ignored = ignoredBySubject.get(sourceItemKey) ?? new Set<string>();

    for (const reference of references) {
      const referenceKey = ignoredKey({
        provider: reference.provider,
        providerWorkID: reference.providerWorkID,
        doi: reference.doi,
        normalizedTitle: normalizeExactTitle(reference.title),
      });
      if (ignored.has(referenceKey)) continue;

      let target = explicitLocalTarget(reference, allowed);
      const doi = normalizeDOI(reference.doi);
      if (!target && doi) target = keyByDOI.get(doi) ?? null;
      if (!target) {
        const identity = identityKey(
          reference.provider,
          reference.providerWorkID,
        );
        if (identity) target = keyByIdentity.get(identity) ?? null;
      }
      if (!target) {
        const title = normalizeExactTitle(reference.title);
        const candidates = title ? worksByTitle.get(title) : undefined;
        if (candidates?.length) {
          target = compatibleTitleTarget(reference, candidates);
        }
      }
      if (target) add(sourceItemKey, target, reference.provider, false);
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
