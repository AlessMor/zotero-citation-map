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
const MIN_USABLE_REFERENCES = 5;
const MIN_REFERENCE_COVERAGE = 0.25;

function ratio(numerator: number, denominator: number | null): number | null {
  if (denominator === null || denominator < 0) return null;
  if (denominator === 0) return numerator === 0 ? 1 : null;
  return numerator / denominator;
}

function sufficientCoverage(record: CitationMetricRecord): boolean {
  const coverage = ratio(record.resolvedReferenceCount, record.referenceCount);
  return coverage !== null && coverage >= MIN_REFERENCE_COVERAGE;
}

function referenceAgeStats(record: CitationMetricRecord): {
  mean: number | null;
  spread: number | null;
} {
  if (record.year === null || !sufficientCoverage(record)) {
    return { mean: null, spread: null };
  }
  const ages = record.references
    .map((reference) =>
      reference.year === null ? null : record.year! - reference.year,
    )
    .filter((age): age is number => age !== null && Number.isFinite(age));
  if (ages.length < MIN_USABLE_REFERENCES) return { mean: null, spread: null };
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

function normalizedAuthorIDs(values: string[] | undefined): Set<string> {
  return new Set(
    (values ?? [])
      .map((value) =>
        value
          .trim()
          .toLocaleLowerCase()
          .replace(/^https?:\/\/(?:orcid\.org|openalex\.org)\//, ""),
      )
      .filter(Boolean),
  );
}

export function calculateSelfCitationEstimate(
  record: CitationMetricRecord,
): number | null {
  if (!sufficientCoverage(record)) return null;
  const sourceNames = surnameKeys(record.authors);
  const sourceIDs = new Set<string>();
  let comparable = 0;
  let shared = 0;
  for (const reference of record.references) {
    const targetNames = surnameKeys(reference.authors);
    const targetIDs = normalizedAuthorIDs(reference.authorIDs);
    if (!targetNames.size && !targetIDs.size) continue;
    comparable += 1;
    const idMatch = [...targetIDs].some((id) => sourceIDs.has(id));
    const surnameMatch = [...targetNames].some((author) =>
      sourceNames.has(author),
    );
    if (idMatch || surnameMatch) shared += 1;
  }
  return comparable >= MIN_USABLE_REFERENCES ? shared / comparable : null;
}

export function calculateFutureReferenceCount(
  _record: CitationMetricRecord,
): number | null {
  return null;
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
      futureReferenceCount: null,
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
