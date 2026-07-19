import type { CitationMetricRecord } from "../domain/citationTypes";
import {
  computeNetworkAnalytics,
  resolveRecordCitationEdges,
  type NetworkMetricValues,
} from "./citationNetworkAnalytics";
import {
  getCitationMetricRecords,
  getCitationMetricsRevision,
  getIgnoredRelations,
  getManualRelations,
} from "./citationMetricsStore";

export interface CitationDerivedAnalytics extends NetworkMetricValues {
  referenceCoverage: number | null;
  libraryCoverage: number | null;
  localGlobalImpactRatio: number | null;
  referenceAgeMean: number | null;
  referenceAgeSpread: number | null;
  selfCitationEstimate: number | null;
  futureReferenceCount: number | null;
}

interface CacheEntry {
  revision: number;
  values: Map<string, CitationDerivedAnalytics>;
}
const cache = new Map<number, CacheEntry>();

function ratio(numerator: number, denominator: number | null): number | null {
  if (denominator === null || denominator < 0) return null;
  if (denominator === 0) return numerator === 0 ? 1 : null;
  return numerator / denominator;
}

function referenceAgeStats(record: CitationMetricRecord): {
  mean: number | null;
  spread: number | null;
} {
  if (record.year === null) return { mean: null, spread: null };
  const ages = record.references
    .map((reference) =>
      reference.year === null ? null : record.year! - reference.year,
    )
    .filter((age): age is number => age !== null && Number.isFinite(age));
  if (!ages.length) return { mean: null, spread: null };
  const mean = ages.reduce((sum, age) => sum + age, 0) / ages.length;
  const variance =
    ages.reduce((sum, age) => sum + (age - mean) ** 2, 0) / ages.length;
  return { mean, spread: Math.sqrt(variance) };
}

function surnameKeys(authors: string[]): Set<string> {
  return new Set(
    authors
      .map((author) =>
        author
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLocaleLowerCase()
          .replace(/[^a-z0-9 ]+/g, " ")
          .trim()
          .split(/\s+/)
          .at(-1),
      )
      .filter((value): value is string => Boolean(value)),
  );
}

export function calculateSelfCitationEstimate(
  record: CitationMetricRecord,
): number | null {
  const source = surnameKeys(record.authors);
  if (!source.size) return null;
  let comparable = 0;
  let shared = 0;
  for (const reference of record.references) {
    const target = surnameKeys(reference.authors);
    if (!target.size) continue;
    comparable += 1;
    if ([...target].some((author) => source.has(author))) shared += 1;
  }
  return comparable ? shared / comparable : null;
}

export function calculateFutureReferenceCount(
  record: CitationMetricRecord,
): number | null {
  if (record.year === null) return null;
  return record.references.filter(
    (reference) => reference.year !== null && reference.year > record.year!,
  ).length;
}

function build(libraryID: number): Map<string, CitationDerivedAnalytics> {
  const records = getCitationMetricRecords(libraryID);
  const keys = records.map((record) => record.itemKey);
  const edges = resolveRecordCitationEdges(
    records,
    keys,
    getManualRelations(libraryID),
    getIgnoredRelations(libraryID),
  );
  const network = computeNetworkAnalytics(keys, edges);
  const result = new Map<string, CitationDerivedAnalytics>();
  for (const record of records) {
    const metrics = network.get(record.itemKey) ?? {
      incoming: 0,
      outgoing: 0,
      pageRank: 0,
      betweennessCentrality: 0,
      eigenvectorCentrality: 0,
      componentSize: 1,
      citationChainDepth: 0,
      isIsolated: true,
    };
    const age = referenceAgeStats(record);
    result.set(record.itemKey, {
      ...metrics,
      referenceCoverage: ratio(
        record.resolvedReferenceCount,
        record.referenceCount,
      ),
      libraryCoverage: ratio(metrics.outgoing, record.referenceCount),
      localGlobalImpactRatio: ratio(metrics.incoming, record.citationCount),
      referenceAgeMean: age.mean,
      referenceAgeSpread: age.spread,
      selfCitationEstimate: calculateSelfCitationEstimate(record),
      futureReferenceCount: calculateFutureReferenceCount(record),
    });
  }
  return result;
}

export function getLibraryCitationAnalytics(
  libraryID: number,
): Map<string, CitationDerivedAnalytics> {
  const revision = getCitationMetricsRevision();
  const existing = cache.get(libraryID);
  if (existing?.revision === revision) return existing.values;
  const values = build(libraryID);
  cache.set(libraryID, { revision, values });
  return values;
}

export function getItemCitationAnalytics(
  libraryID: number,
  itemKey: string,
): CitationDerivedAnalytics | null {
  return getLibraryCitationAnalytics(libraryID).get(itemKey) ?? null;
}
