import type { RelatedWorkMetadata } from "../domain/citationTypes";
import type {
  CitationGraphEdge,
  CitationGraphFocusRole,
  CitationGraphModel,
  CitationGraphNode,
} from "../domain/graphTypes";
import {
  bibliographicWorkAliases,
  externalWorkLookupIdentity,
  graphNodeLookupAliases,
  matchRelatedWorkToGraphNode,
  normalizeDOI,
  relationshipStableAliases,
  stableExternalWorkIdentity,
} from "../domain/workIdentity";
import { assignFocusCitationSequence } from "./citationSequenceService";

export type GraphFocusDirection = "both" | "references" | "cited-by";
export type GraphFocusLocality = "all" | "local";
export type GraphFocusRanking =
  "relevance" | "most-cited" | "most-recent" | "local-first";

export interface GraphFocusState {
  /** Ordered seed keys. The first entry is the primary seed used for labels. */
  seedKeys: string[];
  direction: GraphFocusDirection;
  locality: GraphFocusLocality;
  ranking: GraphFocusRanking;
  /** Maximum neighbours selected for each seed in each enabled direction. */
  maxPerDirection: number;
}

export interface GraphFocusSeedRelationships {
  references: RelatedWorkMetadata[];
  citedBy: RelatedWorkMetadata[];
}

export interface GraphFocusInput {
  graph: CitationGraphModel;
  state: GraphFocusState;
  /** Seed nodes may be local or temporary external nodes. */
  seeds: CitationGraphNode[];
  /** Relationship membership is kept per seed so multi-seed unions are reproducible. */
  relationships: ReadonlyMap<string, GraphFocusSeedRelationships>;
}

export interface GraphFocusProjection {
  state: GraphFocusState;
  seeds: CitationGraphNode[];
  nodes: CitationGraphNode[];
  edges: CitationGraphEdge[];
  seedKeys: Set<string>;
  externalKeys: Set<string>;
  hidden: { references: number; citedBy: number };
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function dataAgeDays(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? Math.max(0, (Date.now() - timestamp) / 86400000)
    : null;
}

function completeness(work: RelatedWorkMetadata): number {
  const fields = [
    Boolean(work.title?.trim()),
    work.year !== null,
    work.authors.length > 0,
    Boolean(normalizeDOI(work.doi)),
    Boolean(work.sourceTitle?.trim()),
    Boolean(work.abstract?.trim()),
    work.citationCount != null,
    work.referenceCount != null,
  ];
  return fields.filter(Boolean).length / fields.length;
}

function providerForNode(
  provider: RelatedWorkMetadata["provider"],
): CitationGraphNode["provider"] {
  return provider === "manual" || provider === "zotero" ? null : provider;
}

function externalNodeKey(work: RelatedWorkMetadata): string {
  return `focus:${externalWorkLookupIdentity(work)}`;
}

export function externalWorkToFocusNode(
  work: RelatedWorkMetadata,
  role: CitationGraphFocusRole,
): CitationGraphNode {
  const key = externalNodeKey(work);
  const provider = providerForNode(work.provider);
  const referenceCount = finite(work.referenceCount);
  const resolvedReferenceCount = Math.max(
    0,
    Math.floor(
      finite(work.resolvedReferenceCount) ?? work.references?.length ?? 0,
    ),
  );
  const referenceCoverage =
    referenceCount === null
      ? null
      : referenceCount === 0
        ? resolvedReferenceCount === 0
          ? 1
          : null
        : resolvedReferenceCount / referenceCount;
  return {
    key,
    itemID: 0,
    itemKey: key,
    kind: "external",
    focusRole: role,
    externalWork: { ...work, authors: [...work.authors] },
    title: work.title?.trim() || "Title unavailable",
    abstract: work.abstract ?? null,
    sourceTitle: work.sourceTitle ?? null,
    authors: [...work.authors],
    year: work.year,
    publicationDate: work.publicationDate ?? null,
    citationSequence: null,
    doi: normalizeDOI(work.doi),
    tags: [],
    collectionIDs: [],
    citationCount: finite(work.citationCount),
    referenceCount,
    resolvedReferenceCount,
    referenceCoverage,
    metricsUpdatedAt: work.updatedAt ?? null,
    dataAgeDays: dataAgeDays(work.updatedAt),
    provider,
    citationCountProvider: work.citationCount == null ? null : provider,
    referenceCountProvider: work.referenceCount == null ? null : provider,
    providerWorkID: work.providerWorkID,
    matchedBy: null,
    matchConfidence: null,
    matchConfirmed: true,
    metricStatus: provider ? "success" : null,
    fwci: finite(work.fwci),
    citationPercentile: finite(work.citationPercentile),
    isTop1Percent: work.isTop1Percent ?? null,
    isTop10Percent: work.isTop10Percent ?? null,
    citationsLastYear: finite(work.citationsLastYear),
    citationVelocity: finite(work.citationVelocity),
    citationAcceleration: finite(work.citationAcceleration),
    influentialCitationCount: finite(work.influentialCitationCount),
    isRetracted: work.isRetracted ?? null,
    openAccessStatus: work.openAccessStatus ?? null,
    isOpenAccess: work.isOpenAccess ?? null,
    publicationType: work.publicationType ?? null,
    sourceMetrics: work.sourceMetrics ?? null,
    metadataCompleteness:
      finite(work.metadataCompleteness) ?? completeness(work),
    incomingLibraryCitations: 0,
    outgoingLibraryReferences: 0,
    libraryCoverage: null,
    localGlobalImpactRatio: null,
    isIsolated: false,
    referenceAgeMean: finite(work.referenceAgeMean),
    referenceAgeSpread: finite(work.referenceAgeSpread),
    selfCitationEstimate: finite(work.selfCitationEstimate),
    futureReferenceCount: finite(work.futureReferenceCount),
    references: [...(work.references ?? [])],
  };
}

/**
 * Enrich an existing external Focus seed in place without changing its graph
 * key. Focus history and selection use `key`, while relationship persistence
 * may safely promote a provisional candidate `itemKey` to a stable external
 * identity once one becomes available.
 */
export function synchronizeExternalFocusNode(
  node: CitationGraphNode,
  work: RelatedWorkMetadata,
): boolean {
  if (node.itemID > 0) return true;
  const role = node.focusRole ?? "seed";
  const previousKey = node.key;
  const previousItemKey = node.itemKey;
  const previousSequence = node.citationSequence;
  const refreshed = externalWorkToFocusNode(work, role);
  const stableIdentity = stableExternalWorkIdentity(work);

  Object.assign(node, refreshed);
  node.key = previousKey;
  node.itemKey =
    stableIdentity && previousItemKey.startsWith("focus:candidate:")
      ? refreshed.itemKey
      : previousItemKey;
  node.focusRole = role;
  node.citationSequence = previousSequence;
  return Boolean(stableIdentity);
}

function localIndexes(nodes: CitationGraphNode[]) {
  const byKey = new Map<string, CitationGraphNode>();
  const byAlias = new Map<string, CitationGraphNode[]>();
  for (const node of nodes) {
    byKey.set(node.itemKey.toLocaleUpperCase(), node);
    byKey.set(node.key.toLocaleUpperCase(), node);
    for (const alias of graphNodeLookupAliases(node)) {
      const group = byAlias.get(alias) ?? [];
      group.push(node);
      byAlias.set(alias, group);
    }
  }
  return { byKey, byAlias };
}

function localNodeForWork(
  work: RelatedWorkMetadata,
  indexes: ReturnType<typeof localIndexes>,
): CitationGraphNode | null {
  const explicit = work.inLibraryItemKey ?? work.zoteroItemKey;
  if (explicit) {
    const local = indexes.byKey.get(explicit.toLocaleUpperCase());
    if (local) return local;
  }
  const stableAliases = relationshipStableAliases(work);
  const aliases = stableAliases.length
    ? stableAliases
    : bibliographicWorkAliases(work);
  const candidates = new Set<CitationGraphNode>();
  for (const alias of aliases) {
    for (const candidate of indexes.byAlias.get(alias) ?? []) {
      candidates.add(candidate);
    }
  }
  const matching = [...candidates].filter(
    (candidate) =>
      matchRelatedWorkToGraphNode(work, candidate).decision === "same-work",
  );
  return matching.length === 1 ? matching[0] : null;
}

interface RankedNode {
  node: CitationGraphNode;
  work: RelatedWorkMetadata | null;
  local: boolean;
}

interface AggregatedNode extends RankedNode {
  seedKeys: Set<string>;
  provenances: Set<string>;
}

function compareRanked(
  left: AggregatedNode,
  right: AggregatedNode,
  ranking: GraphFocusRanking,
): number {
  const connectionOrder = right.seedKeys.size - left.seedKeys.size;
  const localOrder = Number(right.local) - Number(left.local);
  if (ranking === "local-first") {
    return localOrder || connectionOrder || compareImpact(left, right);
  }
  const leftCites = left.node.citationCount ?? -1;
  const rightCites = right.node.citationCount ?? -1;
  const leftYear = left.node.year ?? -Infinity;
  const rightYear = right.node.year ?? -Infinity;
  if (ranking === "most-recent") {
    return rightYear - leftYear || connectionOrder || rightCites - leftCites;
  }
  if (ranking === "most-cited") {
    return rightCites - leftCites || connectionOrder || rightYear - leftYear;
  }
  // In multi-seed mode shared neighbours are the strongest relevance signal.
  return connectionOrder || compareImpact(left, right) || localOrder;
}

function compareImpact(left: RankedNode, right: RankedNode): number {
  const currentYear = new Date().getFullYear();
  const score = (entry: RankedNode): number => {
    const cites = Math.log1p(Math.max(0, entry.node.citationCount ?? 0));
    const recency =
      entry.node.year === null
        ? 0
        : Math.max(0, 1 - (currentYear - entry.node.year) / 40);
    return cites * 0.65 + recency * 0.35;
  };
  return score(right) - score(left);
}

function mergeRole(
  current: CitationGraphFocusRole | null | undefined,
  incoming: Exclude<CitationGraphFocusRole, "seed" | "both">,
): CitationGraphFocusRole {
  if (!current || current === incoming) return incoming;
  if (current === "seed") return current;
  return "both";
}

function edge(
  source: string,
  target: string,
  provenance: string,
): CitationGraphEdge {
  return {
    key: `${source}>${target}:focus`,
    source,
    target,
    provenance,
    manual: false,
  };
}

function directionEntries(
  seed: CitationGraphNode,
  graph: CitationGraphModel,
  works: RelatedWorkMetadata[],
  direction: "references" | "cited-by",
  indexes: ReturnType<typeof localIndexes>,
): RankedNode[] {
  const localKeys = new Set<string>();
  for (const relation of graph.edges) {
    if (direction === "references" && relation.source === seed.key) {
      localKeys.add(relation.target);
    } else if (direction === "cited-by" && relation.target === seed.key) {
      localKeys.add(relation.source);
    }
  }
  const result = new Map<string, RankedNode>();
  for (const key of localKeys) {
    const node = graph.nodes.find((candidate) => candidate.key === key);
    if (node) result.set(node.key, { node, work: null, local: true });
  }
  for (const work of works) {
    const local = localNodeForWork(work, indexes);
    const node =
      local ??
      externalWorkToFocusNode(
        work,
        direction === "references" ? "reference" : "cited-by",
      );
    const existing = result.get(node.key);
    if (!existing || (!existing.work && work)) {
      result.set(node.key, { node, work, local: Boolean(local) });
    }
  }
  result.delete(seed.key);
  return [...result.values()];
}

function cloneSeedNode(node: CitationGraphNode): CitationGraphNode {
  return {
    ...node,
    kind: node.kind ?? "local",
    focusRole: "seed",
    authors: [...node.authors],
    tags: [...node.tags],
    collectionIDs: [...node.collectionIDs],
    references: [...node.references],
    externalWork: node.externalWork
      ? { ...node.externalWork, authors: [...node.externalWork.authors] }
      : null,
  };
}

function aggregateDirection(
  seeds: CitationGraphNode[],
  graph: CitationGraphModel,
  relationships: ReadonlyMap<string, GraphFocusSeedRelationships>,
  direction: "references" | "cited-by",
  indexes: ReturnType<typeof localIndexes>,
): Map<string, AggregatedNode> {
  const aggregate = new Map<string, AggregatedNode>();
  for (const seed of seeds) {
    const works =
      direction === "references"
        ? (relationships.get(seed.key)?.references ?? [])
        : (relationships.get(seed.key)?.citedBy ?? []);
    for (const entry of directionEntries(
      seed,
      graph,
      works,
      direction,
      indexes,
    )) {
      const current = aggregate.get(entry.node.key);
      if (current) {
        current.seedKeys.add(seed.key);
        if (entry.work?.provider) current.provenances.add(entry.work.provider);
        if (!current.work && entry.work) current.work = entry.work;
        current.local ||= entry.local;
      } else {
        aggregate.set(entry.node.key, {
          ...entry,
          seedKeys: new Set([seed.key]),
          provenances: new Set(
            entry.work?.provider ? [entry.work.provider] : ["focus"],
          ),
        });
      }
    }
  }
  return aggregate;
}

export function buildGraphFocusProjection(
  input: GraphFocusInput,
): GraphFocusProjection | null {
  const { graph, state } = input;
  const requestedKeys = [...new Set(state.seedKeys.filter(Boolean))];
  const suppliedByKey = new Map(input.seeds.map((seed) => [seed.key, seed]));
  const graphByKey = new Map(graph.nodes.map((node) => [node.key, node]));
  const seeds = requestedKeys
    .map((key) => suppliedByKey.get(key) ?? graphByKey.get(key) ?? null)
    .filter((seed): seed is CitationGraphNode => Boolean(seed))
    .map(cloneSeedNode);
  if (!seeds.length) return null;

  const seedKeys = new Set(seeds.map((seed) => seed.key));
  const indexes = localIndexes([
    ...graph.nodes.filter((node) => node.kind !== "external"),
    ...seeds,
  ]);
  const includeReferences = state.direction !== "cited-by";
  const includeCitedBy = state.direction !== "references";
  const refs = includeReferences
    ? aggregateDirection(
        seeds,
        graph,
        input.relationships,
        "references",
        indexes,
      )
    : new Map<string, AggregatedNode>();
  const cites = includeCitedBy
    ? aggregateDirection(seeds, graph, input.relationships, "cited-by", indexes)
    : new Map<string, AggregatedNode>();

  const filterSeedCandidates = (entries: Map<string, AggregatedNode>) => {
    for (const key of seedKeys) entries.delete(key);
  };
  filterSeedCandidates(refs);
  filterSeedCandidates(cites);

  const filterLocal = (entry: AggregatedNode): boolean =>
    state.locality === "all" || entry.local;

  const selectPerSeed = (
    entries: Map<string, AggregatedNode>,
  ): { selected: AggregatedNode[]; hidden: number } => {
    const selected = new Map<string, AggregatedNode>();
    let hidden = 0;
    for (const seed of seeds) {
      const ranked = [...entries.values()]
        .filter((entry) => filterLocal(entry) && entry.seedKeys.has(seed.key))
        .sort((a, b) => compareRanked(a, b, state.ranking));
      const selectedForSeed = ranked.slice(0, state.maxPerDirection);
      hidden += Math.max(0, ranked.length - selectedForSeed.length);
      for (const entry of selectedForSeed) {
        const current = selected.get(entry.node.key);
        if (current) {
          current.seedKeys.add(seed.key);
          for (const provenance of entry.provenances) {
            current.provenances.add(provenance);
          }
          current.local ||= entry.local;
          if (!current.work && entry.work) current.work = entry.work;
          continue;
        }
        selected.set(entry.node.key, {
          ...entry,
          seedKeys: new Set([seed.key]),
          provenances: new Set(entry.provenances),
        });
      }
    }
    return { selected: [...selected.values()], hidden };
  };

  const selectedReferenceResult = selectPerSeed(refs);
  const selectedCitedByResult = selectPerSeed(cites);
  const selectedRefs = selectedReferenceResult.selected;
  const selectedCites = selectedCitedByResult.selected;

  const nodes = new Map<string, CitationGraphNode>();
  for (const seed of seeds) nodes.set(seed.key, seed);
  const edges = new Map<string, CitationGraphEdge>();

  // Preserve direct seed-to-seed relations already known in the library graph.
  for (const relation of graph.edges) {
    if (seedKeys.has(relation.source) && seedKeys.has(relation.target)) {
      edges.set(`${relation.source}>${relation.target}`, { ...relation });
    }
  }
  // External seeds may not exist in the library graph. Detect their mutual
  // citation links from each seed's cached relationship membership as well.
  for (const seed of seeds) {
    const membership = input.relationships.get(seed.key);
    for (const work of membership?.references ?? []) {
      const target = localNodeForWork(work, indexes);
      if (target && seedKeys.has(target.key) && target.key !== seed.key) {
        const relation = edge(seed.key, target.key, work.provider);
        edges.set(`${relation.source}>${relation.target}`, relation);
      }
    }
    for (const work of membership?.citedBy ?? []) {
      const source = localNodeForWork(work, indexes);
      if (source && seedKeys.has(source.key) && source.key !== seed.key) {
        const relation = edge(source.key, seed.key, work.provider);
        edges.set(`${relation.source}>${relation.target}`, relation);
      }
    }
  }

  const add = (entry: AggregatedNode, role: "reference" | "cited-by"): void => {
    const existing = nodes.get(entry.node.key);
    const focusRole = mergeRole(existing?.focusRole, role);
    const node = existing
      ? { ...existing, focusRole }
      : { ...entry.node, kind: entry.node.kind ?? "local", focusRole };
    nodes.set(node.key, node);
    for (const seedKey of entry.seedKeys) {
      const relation =
        role === "reference"
          ? edge(seedKey, node.key, [...entry.provenances][0] ?? "focus")
          : edge(node.key, seedKey, [...entry.provenances][0] ?? "focus");
      edges.set(`${relation.source}>${relation.target}`, relation);
    }
  };
  for (const entry of selectedRefs) add(entry, "reference");
  for (const entry of selectedCites) add(entry, "cited-by");

  const projectedSeeds = seeds.map((seed) => nodes.get(seed.key) ?? seed);
  const projectedNodes = [...nodes.values()];
  const projectedEdges = [...edges.values()];
  assignFocusCitationSequence(
    projectedNodes,
    projectedEdges,
    projectedSeeds[0].key,
  );
  return {
    state: { ...state, seedKeys: [...seedKeys] },
    seeds: projectedSeeds,
    nodes: projectedNodes,
    edges: projectedEdges,
    seedKeys,
    externalKeys: new Set(
      [...nodes.values()]
        .filter((node) => node.kind === "external")
        .map((node) => node.key),
    ),
    hidden: {
      references: selectedReferenceResult.hidden,
      citedBy: selectedCitedByResult.hidden,
    },
  };
}
