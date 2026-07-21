import type {
  CitationGraphModel,
  CitationGraphNode,
} from "../domain/graphTypes";
import type { LibrarySnapshot } from "../domain/types";
import { getItemCitationAnalytics } from "./citationAnalyticsService";
import {
  computeNetworkAnalytics,
  resolveRecordCitationEdges,
  type LocalCitationRelation,
} from "./citationNetworkAnalytics";
import {
  getCitationMetricRecord,
  getCitationMetricRecords,
  getIgnoredRelations,
  getManualRelations,
} from "./citationMetricsStore";
import {
  getLocalRelationsEnabled,
  getNoteExtractionEnabled,
  getPDFExtractionEnabled,
} from "./citationPreferences";
import { normalizeDOI } from "./citationIdentifiers";

const graphCacheByLibrary = new Map<number, CitationGraphModel>();

export function getCachedCitationGraph(
  libraryID: number,
): CitationGraphModel | null {
  return graphCacheByLibrary.get(libraryID) ?? null;
}

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

function getLocalCitationRelations(
  snapshot: LibrarySnapshot,
): LocalCitationRelation[] {
  const results: LocalCitationRelation[] = [];
  const allowed = new Set(snapshot.papers.map((paper) => paper.itemKey));
  const keyByDOI = new Map(
    snapshot.papers
      .map((paper) => [normalizeDOI(paper.doi), paper.itemKey] as const)
      .filter((entry): entry is [string, string] => Boolean(entry[0])),
  );
  const seen = new Set<string>();
  const add = (
    sourceItemKey: string,
    targetItemKey: string,
    provenance: LocalCitationRelation["provenance"],
  ): void => {
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
    results.push({ sourceItemKey, targetItemKey, provenance });
  };

  for (const paper of snapshot.papers) {
    const item = Zotero.Items.get(paper.itemID) as Zotero.Item | null;
    if (!item) continue;
    if (getLocalRelationsEnabled()) {
      const relations = item.getRelations?.() ?? {};
      for (const [predicate, rawValues] of Object.entries(relations)) {
        const values = Array.isArray(rawValues) ? rawValues : [rawValues];
        for (const value of values) {
          const relatedKey = relationItemKey(value);
          if (!relatedKey) continue;
          if (/iscitedby/i.test(predicate)) {
            add(relatedKey, paper.itemKey, "zotero-relation");
          } else if (/cites|references/i.test(predicate)) {
            add(paper.itemKey, relatedKey, "zotero-relation");
          }
        }
      }
    }
    if (getNoteExtractionEnabled()) {
      for (const noteID of item.getNotes?.() ?? []) {
        const note = Zotero.Items.get(noteID);
        const content = String(note?.getNote?.() ?? "");
        for (const doi of extractDOIs(content)) {
          const target = keyByDOI.get(doi);
          if (target) add(paper.itemKey, target, "note-extraction");
        }
      }
    }
    if (getPDFExtractionEnabled()) {
      for (const attachmentID of item.getAttachments?.() ?? []) {
        try {
          const attachment = Zotero.Items.get(attachmentID);
          const cacheFile = (Zotero.Fulltext as any)?.getItemCacheFile?.(
            attachment,
          );
          const content = cacheFile
            ? String((Zotero.File as any)?.getContents?.(cacheFile) ?? "")
            : "";
          for (const doi of extractDOIs(content)) {
            const target = keyByDOI.get(doi);
            if (target) add(paper.itemKey, target, "pdf-extraction");
          }
        } catch {
          // Full-text cache is optional and may be unavailable for an attachment.
        }
      }
    }
  }
  return results;
}

export function buildCitationGraph(
  snapshot: LibrarySnapshot,
): CitationGraphModel {
  const nodeKeys = snapshot.papers.map((paper) => paper.itemKey);
  const records = getCitationMetricRecords(snapshot.libraryID);
  const edges = resolveRecordCitationEdges(
    records,
    nodeKeys,
    getManualRelations(snapshot.libraryID),
    getIgnoredRelations(snapshot.libraryID),
    getLocalCitationRelations(snapshot),
  );
  const network = computeNetworkAnalytics(nodeKeys, edges);
  const nodes: CitationGraphNode[] = snapshot.papers.map((paper) => {
    const record = getCitationMetricRecord(snapshot.libraryID, paper.itemKey);
    const derived = getItemCitationAnalytics(snapshot.libraryID, paper.itemKey);
    const local = network.get(paper.itemKey) ?? {
      incoming: 0,
      outgoing: 0,
      pageRank: 0,
      betweennessCentrality: 0,
      eigenvectorCentrality: 0,
      componentSize: 1,
      citationChainDepth: 0,
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
    return {
      key: paper.itemKey,
      itemID: paper.itemID,
      itemKey: paper.itemKey,
      title: paper.title,
      abstract: paper.abstract,
      sourceTitle: paper.sourceTitle ?? record?.sourceTitle ?? null,
      authors: paper.authors,
      year: paper.year,
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
      pageRank: local.pageRank,
      betweennessCentrality: local.betweennessCentrality,
      eigenvectorCentrality: local.eigenvectorCentrality,
      componentSize: local.componentSize,
      citationChainDepth: local.citationChainDepth,
      isIsolated: local.isIsolated,
      referenceAgeMean: derived?.referenceAgeMean ?? null,
      referenceAgeSpread: derived?.referenceAgeSpread ?? null,
      selfCitationEstimate: derived?.selfCitationEstimate ?? null,
      futureReferenceCount: derived?.futureReferenceCount ?? null,
      references: record?.references ?? [],
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
  graphCacheByLibrary.set(snapshot.libraryID, model);
  return model;
}
