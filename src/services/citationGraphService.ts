import type {
  CitationGraphModel,
  CitationGraphNode,
} from "../domain/graphTypes";
import type { LibrarySnapshot, ZoteroPaper } from "../domain/types";
import { getItemCitationAnalytics } from "./citationAnalyticsService";
import {
  computeNetworkAnalytics,
  resolveRecordCitationEdges,
  type LocalCitationRelation,
  type LocalWorkIdentity,
} from "./citationNetworkAnalytics";
import {
  getCitationMetricRecord,
  getCitationMetricRecords,
  getIgnoredRelations,
  getManualRelations,
} from "./citationMetricsStore";
import { normalizeDOI } from "../domain/workIdentity";
import {
  getStoredRelationshipWorks,
  mergeRelatedWorkLists,
  type RelationshipStoreSubject,
} from "./relationshipStoreService";
import { assignGraphCitationSequence } from "./citationSequenceService";
import { forEachCooperatively } from "./backgroundTaskService";
import {
  cloneCitationGraphModel,
  getCachedCitationGraphSnapshot,
  getCachedCitationGraphSnapshotByLibrary,
  getOrCreateCitationGraphSnapshot,
  type CitationGraphSnapshot,
} from "./graphSnapshotStore";

function relationItemKey(value: unknown): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const match = text.match(/\/items\/([A-Z0-9]{8})(?:$|[?#])/i);
  return match ? match[1].toUpperCase() : null;
}

function extractDOIs(value: string): string[] {
  const matches = value.match(/10\.\d{4,9}\/[-._;()/:A-Z0-9]+/gi) ?? [];
  return [
    ...new Set(
      matches
        .map((entry) => normalizeDOI(entry))
        .filter((entry): entry is string => Boolean(entry)),
    ),
  ];
}

interface ExtractedLocalCitationCache {
  itemSignature: string;
  relations: LocalCitationRelation[];
  scannedSourceKeys: Set<string>;
}

const extractedLocalCitationCache = new Map<
  number,
  ExtractedLocalCitationCache
>();
const localCitationExtractionInFlight = new Map<number, Promise<boolean>>();
const localCitationExtractionGeneration = new Map<number, number>();

function libraryItemSignature(snapshot: LibrarySnapshot): string {
  let hash = 2166136261;
  for (const paper of snapshot.papers) {
    const value = `${paper.itemID}:${paper.itemKey};`;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  }
  return `${snapshot.papers.length}:${hash >>> 0}`;
}

function appendLocalCitationRelation(
  output: LocalCitationRelation[],
  seen: Set<string>,
  allowed: Set<string>,
  sourceItemKey: string,
  targetItemKey: string,
  provenance: LocalCitationRelation["provenance"],
): void {
  if (
    sourceItemKey === targetItemKey ||
    !allowed.has(sourceItemKey) ||
    !allowed.has(targetItemKey)
  ) {
    return;
  }
  const identity = `${sourceItemKey}>${targetItemKey}:${provenance}`;
  if (seen.has(identity)) return;
  seen.add(identity);
  output.push({ sourceItemKey, targetItemKey, provenance });
}

function getExplicitLocalCitationRelations(
  snapshot: LibrarySnapshot,
): LocalCitationRelation[] {
  const results: LocalCitationRelation[] = [];
  const allowed = new Set(snapshot.papers.map((paper) => paper.itemKey));
  const seen = new Set<string>();

  for (const paper of snapshot.papers) {
    const item = Zotero.Items.get(paper.itemID) as Zotero.Item | null;
    if (!item) continue;
    const relations = item.getRelations?.() ?? {};
    for (const [predicate, rawValues] of Object.entries(relations)) {
      const values = Array.isArray(rawValues) ? rawValues : [rawValues];
      for (const value of values) {
        const relatedKey = relationItemKey(value);
        if (!relatedKey) continue;
        if (/iscitedby/i.test(predicate)) {
          appendLocalCitationRelation(
            results,
            seen,
            allowed,
            relatedKey,
            paper.itemKey,
            "zotero-relation",
          );
        } else if (/cites|references/i.test(predicate)) {
          appendLocalCitationRelation(
            results,
            seen,
            allowed,
            paper.itemKey,
            relatedKey,
            "zotero-relation",
          );
        }
      }
    }
  }
  return results;
}

async function readFulltextCache(attachment: Zotero.Item): Promise<string> {
  const cacheFile = (Zotero.Fulltext as any)?.getItemCacheFile?.(attachment);
  if (!cacheFile) return "";
  const fileAPI = Zotero.File as any;
  if (typeof fileAPI?.getContentsAsync === "function") {
    return String((await fileAPI.getContentsAsync(cacheFile)) ?? "");
  }
  return String(fileAPI?.getContents?.(cacheFile) ?? "");
}

async function extractEmbeddedLocalCitationRelations(
  snapshot: LibrarySnapshot,
  sourcePapers: readonly ZoteroPaper[],
): Promise<LocalCitationRelation[]> {
  const results: LocalCitationRelation[] = [];
  const allowed = new Set(snapshot.papers.map((paper) => paper.itemKey));
  const keyByDOI = new Map(
    snapshot.papers
      .map((paper) => [normalizeDOI(paper.doi), paper.itemKey] as const)
      .filter((entry): entry is [string, string] => Boolean(entry[0])),
  );
  const seen = new Set<string>();
  const addDOIRelations = (
    sourceItemKey: string,
    content: string,
    provenance: LocalCitationRelation["provenance"],
  ): void => {
    for (const doi of extractDOIs(content)) {
      const target = keyByDOI.get(doi);
      if (!target) continue;
      appendLocalCitationRelation(
        results,
        seen,
        allowed,
        sourceItemKey,
        target,
        provenance,
      );
    }
  };

  await forEachCooperatively(
    sourcePapers,
    async (paper) => {
      const item = Zotero.Items.get(paper.itemID) as Zotero.Item | null;
      if (!item) return;
      for (const noteID of item.getNotes?.() ?? []) {
        const note = Zotero.Items.get(noteID);
        addDOIRelations(
          paper.itemKey,
          String(note?.getNote?.() ?? ""),
          "note-extraction",
        );
      }
      for (const attachmentID of item.getAttachments?.() ?? []) {
        try {
          const attachment = Zotero.Items.get(
            attachmentID,
          ) as Zotero.Item | null;
          if (!attachment) continue;
          addDOIRelations(
            paper.itemKey,
            await readFulltextCache(attachment),
            "pdf-extraction",
          );
        } catch {
          // Full-text cache is optional and may be unavailable for an attachment.
        }
      }
    },
    { budgetMs: 6, forceEvery: 1 },
  );
  return results;
}

function getLocalCitationRelations(
  snapshot: LibrarySnapshot,
): LocalCitationRelation[] {
  const explicit = getExplicitLocalCitationRelations(snapshot);
  const cached = extractedLocalCitationCache.get(snapshot.libraryID);
  if (!cached || cached.itemSignature !== libraryItemSignature(snapshot)) {
    return explicit;
  }
  const seen = new Set(
    explicit.map(
      (relation) =>
        `${relation.sourceItemKey}>${relation.targetItemKey}:${relation.provenance}`,
    ),
  );
  const results = [...explicit];
  for (const relation of cached.relations) {
    const identity = `${relation.sourceItemKey}>${relation.targetItemKey}:${relation.provenance}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    results.push(relation);
  }
  return results;
}

export function warmLocalCitationRelations(
  snapshot: LibrarySnapshot,
  sourceItemIDs?: readonly number[],
): Promise<boolean> {
  const itemSignature = libraryItemSignature(snapshot);
  const existingCache = extractedLocalCitationCache.get(snapshot.libraryID);
  const cache =
    existingCache?.itemSignature === itemSignature
      ? existingCache
      : {
          itemSignature,
          relations: [],
          scannedSourceKeys: new Set<string>(),
        };
  const requestedItemIDs = sourceItemIDs?.length
    ? new Set(sourceItemIDs.map(Number).filter(Number.isFinite))
    : null;
  const sourcePapers = snapshot.papers.filter(
    (paper) =>
      (!requestedItemIDs || requestedItemIDs.has(paper.itemID)) &&
      !cache.scannedSourceKeys.has(paper.itemKey),
  );
  if (!sourcePapers.length) {
    if (existingCache !== cache) {
      extractedLocalCitationCache.set(snapshot.libraryID, cache);
    }
    return Promise.resolve(false);
  }

  const existing = localCitationExtractionInFlight.get(snapshot.libraryID);
  if (existing) {
    return existing.then(() =>
      warmLocalCitationRelations(snapshot, sourceItemIDs),
    );
  }
  const generation =
    localCitationExtractionGeneration.get(snapshot.libraryID) ?? 0;
  const sourceKeys = new Set(sourcePapers.map((paper) => paper.itemKey));

  const pending = extractEmbeddedLocalCitationRelations(snapshot, sourcePapers)
    .then((relations) => {
      if (
        (localCitationExtractionGeneration.get(snapshot.libraryID) ?? 0) !==
        generation
      ) {
        return false;
      }
      const current = extractedLocalCitationCache.get(snapshot.libraryID);
      const target =
        current?.itemSignature === itemSignature
          ? current
          : {
              itemSignature,
              relations: [],
              scannedSourceKeys: new Set<string>(),
            };
      const previousKeys = new Set(
        target.relations.map(
          (relation) =>
            `${relation.sourceItemKey}>${relation.targetItemKey}:${relation.provenance}`,
        ),
      );
      target.relations = [
        ...target.relations.filter(
          (relation) => !sourceKeys.has(relation.sourceItemKey),
        ),
        ...relations,
      ];
      for (const key of sourceKeys) target.scannedSourceKeys.add(key);
      extractedLocalCitationCache.set(snapshot.libraryID, target);
      const nextKeys = new Set(
        target.relations.map(
          (relation) =>
            `${relation.sourceItemKey}>${relation.targetItemKey}:${relation.provenance}`,
        ),
      );
      if (previousKeys.size !== nextKeys.size) return true;
      for (const key of nextKeys) {
        if (!previousKeys.has(key)) return true;
      }
      return false;
    })
    .finally(() => {
      if (localCitationExtractionInFlight.get(snapshot.libraryID) === pending) {
        localCitationExtractionInFlight.delete(snapshot.libraryID);
      }
    });
  localCitationExtractionInFlight.set(snapshot.libraryID, pending);
  return pending;
}

export function invalidateLocalCitationExtractionCache(
  libraryID?: number,
): void {
  if (typeof libraryID === "number" && Number.isFinite(libraryID)) {
    localCitationExtractionGeneration.set(
      libraryID,
      (localCitationExtractionGeneration.get(libraryID) ?? 0) + 1,
    );
    extractedLocalCitationCache.delete(libraryID);
    localCitationExtractionInFlight.delete(libraryID);
    return;
  }
  for (const cachedLibraryID of new Set([
    ...extractedLocalCitationCache.keys(),
    ...localCitationExtractionInFlight.keys(),
  ])) {
    localCitationExtractionGeneration.set(
      cachedLibraryID,
      (localCitationExtractionGeneration.get(cachedLibraryID) ?? 0) + 1,
    );
  }
  extractedLocalCitationCache.clear();
  localCitationExtractionInFlight.clear();
}

export function clearLocalCitationExtractionCache(): void {
  invalidateLocalCitationExtractionCache();
}

function relationshipSubjectForPaper(
  paper: ZoteroPaper,
): RelationshipStoreSubject {
  const record = getCitationMetricRecord(paper.libraryID, paper.itemKey);
  return {
    itemID: paper.itemID,
    itemKey: paper.itemKey,
    doi: record?.doi ?? paper.doi,
    provider: record?.provider ?? paper.metrics.provider,
    providerWorkID: record?.providerWorkID ?? null,
    title: record?.title?.trim() || paper.title,
    year: record?.year ?? paper.year,
  };
}

function buildCitationGraphModel(
  snapshot: LibrarySnapshot,
): CitationGraphModel {
  const startedAt = globalThis.performance?.now?.() ?? Date.now();
  const nodeKeys = snapshot.papers.map((paper) => paper.itemKey);
  const records = getCitationMetricRecords(snapshot.libraryID);
  const recordByItemKey = new Map(
    records.map((record) => [record.itemKey, record]),
  );
  const relationshipSubjects = new Map(
    snapshot.papers.map((paper) => [
      paper.itemKey,
      relationshipSubjectForPaper(paper),
    ]),
  );
  const storedReferencesBySource = new Map(
    snapshot.papers.map((paper) => {
      const subject = relationshipSubjects.get(paper.itemKey)!;
      return [
        paper.itemKey.toLocaleUpperCase(),
        getStoredRelationshipWorks(subject, "references"),
      ] as const;
    }),
  );
  const localWorks: LocalWorkIdentity[] = snapshot.papers.map((paper) => {
    const record = recordByItemKey.get(paper.itemKey);
    return {
      itemKey: paper.itemKey,
      doi: record?.doi ?? paper.doi,
      title: record?.title?.trim() || paper.title,
      year: record?.year ?? paper.year,
      authors: record?.authors.length ? record.authors : paper.authors,
      provider: record?.provider ?? paper.metrics.provider,
      providerWorkID: record?.providerWorkID ?? null,
    };
  });
  const edges = resolveRecordCitationEdges(
    records,
    nodeKeys,
    getManualRelations(snapshot.libraryID),
    getIgnoredRelations(snapshot.libraryID),
    getLocalCitationRelations(snapshot),
    { localWorks, storedReferencesBySource },
  );
  const network = computeNetworkAnalytics(nodeKeys, edges);
  const nodes: CitationGraphNode[] = snapshot.papers.map((paper) => {
    const record = recordByItemKey.get(paper.itemKey);
    const derived = getItemCitationAnalytics(snapshot.libraryID, paper.itemKey);
    const local = network.get(paper.itemKey) ?? {
      incoming: 0,
      outgoing: 0,
      isIsolated: true,
    };
    const metrics = paper.metrics;
    const referenceCount = metrics.referenceCount;
    const referenceCoverage =
      referenceCount === null
        ? null
        : referenceCount === 0
          ? metrics.resolvedReferenceCount === 0
            ? 1
            : null
          : metrics.resolvedReferenceCount / referenceCount;
    const storedReferences =
      storedReferencesBySource.get(paper.itemKey.toLocaleUpperCase()) ?? [];
    const references = mergeRelatedWorkLists(
      record?.references ?? [],
      storedReferences,
    );
    return {
      key: paper.itemKey,
      itemID: paper.itemID,
      itemKey: paper.itemKey,
      kind: "local",
      focusRole: null,
      externalWork: null,
      title: paper.title,
      abstract: paper.abstract,
      sourceTitle: paper.sourceTitle ?? record?.sourceTitle ?? null,
      authors: paper.authors,
      year: paper.year,
      publicationDate: paper.publicationDate,
      citationSequence: null,
      doi: record?.doi ?? paper.doi,
      tags: paper.tags,
      collectionIDs: paper.collectionIDs,
      citationCount: metrics.citationCount,
      referenceCount,
      resolvedReferenceCount: metrics.resolvedReferenceCount,
      referenceCoverage,
      metricsUpdatedAt: metrics.updatedAt,
      dataAgeDays: metrics.dataAgeDays,
      provider: metrics.provider,
      citationCountProvider: metrics.citationCountProvider,
      referenceCountProvider: metrics.referenceCountProvider,
      providerWorkID: record?.providerWorkID ?? null,
      matchedBy: metrics.matchedBy,
      matchConfidence: metrics.matchConfidence,
      matchConfirmed: metrics.matchConfirmed,
      metricStatus: metrics.status,
      fwci: metrics.fwci,
      citationPercentile: metrics.citationPercentile,
      isTop1Percent: metrics.isTop1Percent,
      isTop10Percent: metrics.isTop10Percent,
      citationsLastYear: metrics.citationsLastYear,
      citationVelocity: metrics.citationVelocity,
      citationAcceleration: metrics.citationAcceleration,
      influentialCitationCount: metrics.influentialCitationCount,
      isRetracted: metrics.isRetracted,
      openAccessStatus: metrics.openAccessStatus,
      isOpenAccess: metrics.isOpenAccess,
      publicationType: metrics.publicationType,
      sourceMetrics: metrics.sourceMetrics,
      metadataCompleteness: paper.metadataCompleteness,
      incomingLibraryCitations: local.incoming,
      outgoingLibraryReferences: local.outgoing,
      libraryCoverage:
        referenceCount === null
          ? null
          : referenceCount === 0
            ? local.outgoing === 0
              ? 1
              : null
            : local.outgoing / referenceCount,
      localGlobalImpactRatio:
        metrics.citationCount && metrics.citationCount > 0
          ? local.incoming / metrics.citationCount
          : local.incoming === 0 && metrics.citationCount === 0
            ? 1
            : null,
      isIsolated: local.isIsolated,
      referenceAgeMean: derived?.referenceAgeMean ?? null,
      referenceAgeSpread: derived?.referenceAgeSpread ?? null,
      selfCitationEstimate: derived?.selfCitationEstimate ?? null,
      futureReferenceCount: derived?.futureReferenceCount ?? null,
      references,
    };
  });
  const model: CitationGraphModel = {
    nodes,
    edges,
    statistics: {
      nodes: nodes.length,
      resolvedNodes: nodes.filter((node) => node.metricStatus === "success")
        .length,
      edges: edges.length,
      isolatedNodes: nodes.filter((node) => node.isIsolated).length,
    },
  };
  assignGraphCitationSequence(model.nodes);
  const elapsed = (globalThis.performance?.now?.() ?? Date.now()) - startedAt;
  if (elapsed >= 500) {
    Zotero.debug(
      `Citation Map: built ${model.nodes.length} nodes and ${model.edges.length} edges in ${Math.round(elapsed)} ms`,
    );
  }
  return model;
}

export function getCitationGraphSnapshot(
  snapshot: LibrarySnapshot,
): CitationGraphSnapshot {
  return getOrCreateCitationGraphSnapshot(snapshot, () =>
    buildCitationGraphModel(snapshot),
  );
}

export function getCachedCitationGraph(
  libraryID: number,
): CitationGraphModel | null {
  const cached = getCachedCitationGraphSnapshotByLibrary(libraryID);
  return cached?.model ?? null;
}

export function getCachedCitationGraphForSnapshot(
  snapshot: LibrarySnapshot,
): CitationGraphModel | null {
  return getCachedCitationGraphSnapshot(snapshot)?.model ?? null;
}

/**
 * Kept for compatibility with the Phase 13 transfer path. Graph snapshots are
 * now shared and non-destructive, so taking a snapshot returns an isolated
 * mutable clone without evicting the canonical cache.
 */
export function takeCachedCitationGraphForSnapshot(
  snapshot: LibrarySnapshot,
): CitationGraphModel | null {
  const cached = getCachedCitationGraphSnapshot(snapshot);
  return cached ? cloneCitationGraphModel(cached.model) : null;
}

export function buildCitationGraph(
  snapshot: LibrarySnapshot,
): CitationGraphModel {
  return cloneCitationGraphModel(getCitationGraphSnapshot(snapshot).model);
}
