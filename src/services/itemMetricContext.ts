import type { CitationGraphNode } from "../domain/graphTypes";
import { getItemCitationAnalytics } from "./citationAnalyticsService";
import {
  getCitationMetricRecord,
  getItemCitationMetrics,
} from "./citationMetricsStore";
import { calculateItemMetadataCompleteness } from "./zoteroLibraryService";

function getYear(item: Zotero.Item): number | null {
  const match = String(item.getField?.("date") ?? "").match(
    /\b(1[5-9]\d{2}|20\d{2}|21\d{2})\b/,
  );
  return match ? Number(match[0]) : null;
}

function getAuthors(item: Zotero.Item): string[] {
  return (item.getCreators?.() ?? [])
    .map((creator: any) =>
      String(
        creator.name ??
          [creator.firstName, creator.lastName].filter(Boolean).join(" "),
      ).trim(),
    )
    .filter(Boolean);
}

export function createMetricNodeForItem(item: Zotero.Item): CitationGraphNode {
  const libraryID = Number(item.libraryID);
  const itemKey = String(item.key);
  const metrics = getItemCitationMetrics(libraryID, itemKey);
  const record = getCitationMetricRecord(libraryID, itemKey);
  const analytics = getItemCitationAnalytics(libraryID, itemKey);
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
    key: itemKey,
    itemID: Number(item.id),
    itemKey,
    title: String(
      item.getDisplayTitle?.() ?? item.getField?.("title") ?? "Untitled",
    ),
    abstract: String(item.getField?.("abstractNote") ?? "").trim() || null,
    sourceTitle:
      String(
        item.getField?.("publicationTitle") ??
          item.getField?.("conferenceName") ??
          item.getField?.("publisher") ??
          "",
      ).trim() || null,
    authors: getAuthors(item),
    year: getYear(item),
    doi: record?.doi ?? null,
    tags: (item.getTags?.() ?? [])
      .map((entry: any) => String(entry?.tag ?? entry ?? "").trim())
      .filter(Boolean),
    collectionIDs: (item.getCollections?.() ?? [])
      .map(Number)
      .filter(Number.isFinite),
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
    metadataCompleteness: calculateItemMetadataCompleteness(item),
    incomingLibraryCitations: analytics?.incoming ?? 0,
    outgoingLibraryReferences: analytics?.outgoing ?? 0,
    libraryCoverage: analytics?.libraryCoverage ?? null,
    localGlobalImpactRatio: analytics?.localGlobalImpactRatio ?? null,
    pageRank: analytics?.pageRank ?? 0,
    betweennessCentrality: analytics?.betweennessCentrality ?? 0,
    eigenvectorCentrality: analytics?.eigenvectorCentrality ?? 0,
    componentSize: analytics?.componentSize ?? 1,
    citationChainDepth: analytics?.citationChainDepth ?? 0,
    isIsolated: analytics?.isIsolated ?? true,
    referenceAgeMean: analytics?.referenceAgeMean ?? null,
    referenceAgeSpread: analytics?.referenceAgeSpread ?? null,
    selfCitationEstimate: analytics?.selfCitationEstimate ?? null,
    futureReferenceCount: analytics?.futureReferenceCount ?? null,
    references: record?.references ?? [],
  };
}
