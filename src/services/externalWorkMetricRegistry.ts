import type {
  CitationProviderID,
  RelatedWorkMetadata,
} from "../domain/citationTypes";
import type { GraphNodeLabelMode } from "../domain/graphTypes";
import {
  mergeRelatedWorkMetadata,
  resolveRelatedWorksMetadata,
} from "../providers/registry";
import { normalizeDOI, normalizeExactTitle } from "./citationIdentifiers";
import { getProviderPreference } from "./citationPreferences";

export type ExternalMetricValueMap = Record<string, number | null | undefined>;

const valuesByAlias = new Map<string, ExternalMetricValueMap>();
const workByAlias = new Map<string, RelatedWorkMetadata>();
const hydrationByAlias = new Map<string, Promise<void>>();
const hydrationAttempted = new Set<string>();

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizedAliases(value: string | null | undefined): string[] {
  const raw = String(value ?? "").trim();
  if (!raw) return [];
  const lower = raw.toLocaleLowerCase();
  return lower === raw ? [raw] : [raw, lower];
}

function aliasesForWork(work: RelatedWorkMetadata): string[] {
  const aliases = new Set<string>();
  for (const alias of normalizedAliases(work.providerWorkID))
    aliases.add(alias);
  for (const alias of normalizedAliases(work.zoteroItemKey)) aliases.add(alias);
  for (const alias of normalizedAliases(work.inLibraryItemKey))
    aliases.add(alias);

  const rawDOI = String(work.doi ?? "").trim();
  for (const alias of normalizedAliases(rawDOI)) aliases.add(alias);
  const doi = normalizeDOI(work.doi);
  if (doi) {
    aliases.add(doi);
    aliases.add(`doi:${doi}`);
  }

  const rawTitle = String(work.title ?? "").trim();
  for (const alias of normalizedAliases(rawTitle)) aliases.add(alias);
  const title = normalizeExactTitle(work.title);
  if (title) {
    aliases.add(title);
    aliases.add(`title:${title}`);
  }
  return [...aliases];
}

function aliasesForKey(key: string): string[] {
  const aliases = new Set(normalizedAliases(key));
  const doi = normalizeDOI(key);
  if (doi) {
    aliases.add(doi);
    aliases.add(`doi:${doi}`);
  }
  const title = normalizeExactTitle(key);
  if (title) {
    aliases.add(title);
    aliases.add(`title:${title}`);
  }
  return [...aliases];
}

function dataAgeDays(updatedAt: string | null | undefined): number | null {
  if (!updatedAt) return null;
  const timestamp = Date.parse(updatedAt);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, (Date.now() - timestamp) / 86400000);
}

function surname(value: string): string {
  const compact = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .trim();
  return compact.split(/\s+/).filter(Boolean).at(-1) ?? compact;
}

function derivedReferenceMetrics(work: RelatedWorkMetadata): {
  referenceAgeMean: number | null;
  referenceAgeSpread: number | null;
  selfCitationEstimate: number | null;
  futureReferenceCount: number | null;
} {
  const references = work.references ?? [];
  const referenceCount = finite(work.referenceCount);
  const resolved = Math.max(
    references.length,
    finite(work.resolvedReferenceCount) ?? 0,
  );
  const coverage =
    referenceCount === null
      ? null
      : referenceCount === 0
        ? resolved === 0
          ? 1
          : null
        : resolved / referenceCount;
  if (references.length < 5 || coverage === null || coverage < 0.25) {
    return {
      referenceAgeMean: null,
      referenceAgeSpread: null,
      selfCitationEstimate: null,
      futureReferenceCount: null,
    };
  }

  const ages =
    work.year === null
      ? []
      : references
          .map((reference) =>
            reference.year === null ? null : work.year! - reference.year,
          )
          .filter((value): value is number => Number.isFinite(value));
  const referenceAgeMean = ages.length
    ? ages.reduce((sum, value) => sum + value, 0) / ages.length
    : null;
  const referenceAgeSpread =
    ages.length >= 2 && referenceAgeMean !== null
      ? Math.sqrt(
          ages.reduce(
            (sum, value) => sum + (value - referenceAgeMean) ** 2,
            0,
          ) / ages.length,
        )
      : null;
  const futureReferenceCount = ages.length
    ? ages.filter((age) => age < 0).length
    : null;

  const authorIDs = new Set(
    (work.authorIDs ?? [])
      .map((value) => value.trim().toLocaleLowerCase())
      .filter(Boolean),
  );
  const surnames = new Set(work.authors.map(surname).filter(Boolean));
  let comparable = 0;
  let shared = 0;
  for (const reference of references) {
    const referenceIDs = (reference.authorIDs ?? [])
      .map((value) => value.trim().toLocaleLowerCase())
      .filter(Boolean);
    const referenceSurnames = reference.authors.map(surname).filter(Boolean);
    if (!referenceIDs.length && !referenceSurnames.length) continue;
    comparable += 1;
    const sharesID = referenceIDs.some((value) => authorIDs.has(value));
    const sharesSurname =
      !sharesID && referenceSurnames.some((value) => surnames.has(value));
    if (sharesID || sharesSurname) shared += 1;
  }
  const selfCitationEstimate = comparable >= 5 ? shared / comparable : null;

  return {
    referenceAgeMean,
    referenceAgeSpread,
    selfCitationEstimate,
    futureReferenceCount,
  };
}

function metadataCompleteness(work: RelatedWorkMetadata): number {
  const fields = [
    Boolean(String(work.title ?? "").trim()),
    work.year !== null,
    work.authors.length > 0,
    Boolean(normalizeDOI(work.doi)),
    Boolean(String(work.sourceTitle ?? "").trim()),
    Boolean(String(work.abstract ?? "").trim()),
    work.citationCount != null,
    work.referenceCount != null,
  ];
  return fields.filter(Boolean).length / fields.length;
}

function metricValuesForWork(
  work: RelatedWorkMetadata,
): ExternalMetricValueMap {
  const resolvedReferenceCount = finite(work.resolvedReferenceCount);
  const referenceCount = finite(work.referenceCount);
  const referenceCoverage =
    referenceCount === null
      ? null
      : referenceCount === 0
        ? resolvedReferenceCount === 0
          ? 1
          : null
        : resolvedReferenceCount === null
          ? null
          : resolvedReferenceCount / referenceCount;
  const derived = derivedReferenceMetrics(work);

  return {
    year: finite(work.year),
    citations: finite(work.citationCount),
    references: referenceCount,
    "citations-last-year": finite(work.citationsLastYear),
    "citation-rate": finite(work.citationVelocity),
    "citation-acceleration": finite(work.citationAcceleration),
    fwci: finite(work.fwci),
    "citation-percentile": finite(work.citationPercentile),
    "influential-citations": finite(work.influentialCitationCount),
    "two-year-mean-citedness": finite(work.sourceMetrics?.twoYearMeanCitedness),
    "journal-h-index": finite(work.sourceMetrics?.hIndex),
    "journal-i10-index": finite(work.sourceMetrics?.i10Index),
    "reference-coverage": referenceCoverage,
    "reference-age-mean":
      finite(work.referenceAgeMean) ?? derived.referenceAgeMean,
    "reference-age-spread":
      finite(work.referenceAgeSpread) ?? derived.referenceAgeSpread,
    "self-citation-estimate":
      finite(work.selfCitationEstimate) ?? derived.selfCitationEstimate,
    "future-references":
      finite(work.futureReferenceCount) ?? derived.futureReferenceCount,
    "data-age": dataAgeDays(work.updatedAt),
    "metadata-completeness":
      finite(work.metadataCompleteness) ?? metadataCompleteness(work),
  };
}

function mergeWork(
  existing: RelatedWorkMetadata | undefined,
  incoming: RelatedWorkMetadata,
): RelatedWorkMetadata {
  if (!existing) return { ...incoming, authors: [...incoming.authors] };
  return mergeRelatedWorkMetadata(existing, incoming);
}

export function registerExternalWorkMetrics(work: RelatedWorkMetadata): void {
  const aliases = aliasesForWork(work);
  let mergedWork = work;
  for (const alias of aliases) {
    mergedWork = mergeWork(workByAlias.get(alias), mergedWork);
  }
  const incoming = metricValuesForWork(mergedWork);
  for (const alias of aliasesForWork(mergedWork)) {
    const previous = valuesByAlias.get(alias) ?? {};
    const mergedValues: ExternalMetricValueMap = { ...previous };
    for (const [metric, value] of Object.entries(incoming)) {
      if (value !== null && value !== undefined && Number.isFinite(value)) {
        mergedValues[metric] = value;
      } else if (!(metric in mergedValues)) {
        mergedValues[metric] = null;
      }
    }
    valuesByAlias.set(alias, mergedValues);
    workByAlias.set(alias, mergedWork);
  }
}

export function registerExternalWorkMetricBatch(
  works: RelatedWorkMetadata[],
): void {
  for (const work of works) registerExternalWorkMetrics(work);
}

export function getExternalWorkMetricValue(
  key: string,
  metric: string,
): number | null {
  for (const alias of aliasesForKey(key)) {
    const value = valuesByAlias.get(alias)?.[metric];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

export function getExternalWorkMetadata(
  key: string,
): RelatedWorkMetadata | null {
  for (const alias of aliasesForKey(key)) {
    const work = workByAlias.get(alias);
    if (work) return work;
  }
  return null;
}

export function getExternalWorkNodeLabel(
  key: string,
  mode: GraphNodeLabelMode,
  fallbackTitle: string,
  fallbackYear: number | null,
): string {
  if (mode === "none") return "";
  const work = getExternalWorkMetadata(key);
  if (mode === "title") {
    return String(work?.title ?? fallbackTitle).trim() || fallbackTitle;
  }
  const firstAuthor = work?.authors[0];
  const name = firstAuthor?.trim().split(/\s+/).at(-1) ?? "Unknown";
  const year = work?.year ?? fallbackYear;
  return `${name}${year ? ` (${year})` : ""}`;
}

export function getExternalWorkProvider(
  key: string,
): CitationProviderID | null {
  const provider = getExternalWorkMetadata(key)?.provider;
  return provider && provider !== "manual" && provider !== "zotero"
    ? provider
    : null;
}

export async function ensureExternalWorkMetrics(key: string): Promise<void> {
  const aliases = aliasesForKey(key);
  const primary = aliases.find((alias) => workByAlias.has(alias));
  if (!primary || hydrationAttempted.has(primary)) return;
  const existing = hydrationByAlias.get(primary);
  if (existing) return existing;
  const work = workByAlias.get(primary);
  if (!work) return;

  hydrationAttempted.add(primary);
  const operation = (async () => {
    try {
      const [resolved] = await resolveRelatedWorksMetadata(
        [work],
        getProviderPreference(),
        true,
      );
      if (resolved) registerExternalWorkMetrics(resolved);
    } catch (error) {
      Zotero.debug(
        `Citation Map: ghost metric hydration failed for ${key}: ${String(error)}`,
      );
    }
  })().finally(() => hydrationByAlias.delete(primary));
  hydrationByAlias.set(primary, operation);
  return operation;
}

export function clearExternalWorkMetricRegistry(): void {
  valuesByAlias.clear();
  workByAlias.clear();
  hydrationByAlias.clear();
  hydrationAttempted.clear();
}
