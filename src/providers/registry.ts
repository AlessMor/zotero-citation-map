import type {
  CitationProviderID,
  CitationProviderPreference,
  ProviderLookupFailure,
  ProviderLookupResult,
  ProviderLookupSuccess,
  RelatedWorkMetadata,
  WorkIdentifiers,
} from "../domain/citationTypes";
import {
  metadataIsNonContradictory,
  normalizeDOI,
  normalizeExactTitle,
} from "../services/citationIdentifiers";
import { getOpenAlexAPIKey } from "../services/citationPreferences";
import { fetchCrossrefRelatedWorks } from "./crossrefDiscovery";
import { crossrefProvider } from "./crossrefProvider";
import { inspireProvider } from "./inspireProvider";
import {
  fetchOpenAlexRelatedWorks,
  fetchOpenAlexWorksBatch,
  openAlexProvider,
} from "./openAlexProvider";
import { openCitationsProvider } from "./openCitationsProvider";
import {
  fetchSemanticScholarPapersBatch,
  fetchSemanticScholarRecommendations,
  SEMANTIC_SCHOLAR_BATCH_LIMIT,
  semanticScholarProvider,
} from "./semanticScholarProvider";
import type { CitationProvider } from "./types";

const PROVIDERS: Record<CitationProviderID, CitationProvider> = {
  crossref: crossrefProvider,
  "semantic-scholar": semanticScholarProvider,
  opencitations: openCitationsProvider,
  inspire: inspireProvider,
  openalex: openAlexProvider,
};

export type ProviderOperation =
  | "work-lookup"
  | "field-enrichment"
  | "metadata-resolution"
  | "references"
  | "citations"
  | "similar"
  | "advanced-metrics"
  | "source-metrics";

export interface ProviderPlan {
  operation: ProviderOperation;
  mode: "automatic" | "single";
  providers: CitationProviderID[];
  mergeResults: boolean;
  stopAfterSuccess: boolean;
}

interface ProviderPlanOptions {
  /** Relationship pages after the first require a true paginated endpoint. */
  offset?: number;
}

const AUTOMATIC_PROVIDER_ORDERS: Record<
  ProviderOperation,
  readonly CitationProviderID[]
> = {
  "work-lookup": [
    "crossref",
    "semantic-scholar",
    "opencitations",
    "inspire",
    "openalex",
  ],
  "field-enrichment": [
    "semantic-scholar",
    "opencitations",
    "inspire",
    "openalex",
    "crossref",
  ],
  "metadata-resolution": [
    "semantic-scholar",
    "crossref",
    "inspire",
    "openalex",
  ],
  references: [
    "semantic-scholar",
    "crossref",
    "inspire",
    "opencitations",
    "openalex",
  ],
  citations: [
    "semantic-scholar",
    "opencitations",
    "inspire",
    "openalex",
    "crossref",
  ],
  similar: [
    "semantic-scholar",
    "opencitations",
    "inspire",
    "crossref",
    "openalex",
  ],
  "advanced-metrics": ["openalex"],
  "source-metrics": ["openalex"],
};

const sessionUnavailableProviders = new Set<CitationProviderID>();
const SEMANTIC_SCHOLAR_RESOLUTION_BATCH_SIZE = Math.min(
  100,
  SEMANTIC_SCHOLAR_BATCH_LIMIT,
);
const METADATA_RESOLUTION_CONCURRENCY = 2;

export function getCitationProvider(
  providerID: CitationProviderID,
): CitationProvider {
  return PROVIDERS[providerID];
}

export function getAllCitationProviders(): CitationProvider[] {
  return AUTOMATIC_PROVIDER_ORDERS["work-lookup"].map(
    (providerID) => PROVIDERS[providerID],
  );
}

export function getAutomaticProviderLabel(): string {
  return "Automatic — combine available providers";
}

export function resetCitationProviderSessionState(): void {
  sessionUnavailableProviders.clear();
}

function automaticProviderIsConfigured(
  providerID: CitationProviderID,
): boolean {
  return providerID !== "openalex" || Boolean(getOpenAlexAPIKey());
}

function providerSupportsOperation(
  provider: CitationProvider,
  operation: ProviderOperation,
  offset: number,
): boolean {
  switch (operation) {
    case "references":
      return offset === 0 || Boolean(provider.fetchReferencedWorks);
    case "citations":
      return Boolean(provider.fetchCitingWorks);
    case "similar":
      return Boolean(
        provider.fetchReferencedWorks || provider.fetchCitingWorks,
      );
    case "source-metrics":
      return provider.capabilities.sourceMetrics;
    case "advanced-metrics":
      return provider.id === "openalex";
    default:
      return true;
  }
}

/**
 * Return the single central provider policy used by field updates,
 * relationship discovery, Similar, and incomplete-metadata resolution.
 * Concrete preferences never fall through to another provider. Automatic mode
 * excludes OpenAlex unless an API key is configured.
 */
export function getProviderPlan(
  operation: ProviderOperation,
  preference: CitationProviderPreference,
  options: ProviderPlanOptions = {},
): ProviderPlan {
  const offset = Math.max(0, options.offset ?? 0);
  if (preference !== "auto") {
    const provider = PROVIDERS[preference];
    return {
      operation,
      mode: "single",
      providers: providerSupportsOperation(provider, operation, offset)
        ? [preference]
        : [],
      mergeResults: false,
      stopAfterSuccess: true,
    };
  }

  const providers = AUTOMATIC_PROVIDER_ORDERS[operation].filter(
    (providerID) =>
      !sessionUnavailableProviders.has(providerID) &&
      automaticProviderIsConfigured(providerID) &&
      providerSupportsOperation(PROVIDERS[providerID], operation, offset),
  );
  return {
    operation,
    mode: "automatic",
    providers,
    mergeResults: operation !== "work-lookup",
    stopAfterSuccess: operation === "work-lookup",
  };
}

export function providerResultAllowed(
  provider: RelatedWorkMetadata["provider"],
  preference: CitationProviderPreference,
): boolean {
  return (
    preference === "auto" ||
    provider === "manual" ||
    provider === "zotero" ||
    provider === preference
  );
}

function chooseFailure(
  failures: ProviderLookupFailure[],
): ProviderLookupFailure {
  const priorities: ProviderLookupFailure["status"][] = [
    "ambiguous-match",
    "rate-limited",
    "network-error",
    "provider-error",
    "not-found",
    "no-identifier",
  ];
  for (const status of priorities) {
    const match = failures.find((failure) => failure.status === status);
    if (match) return match;
  }
  return {
    status: "not-found",
    provider: "crossref",
    message: "No citation provider returned a matching work.",
  };
}

function shouldDisableForSession(failure: ProviderLookupFailure): boolean {
  return (
    failure.status === "rate-limited" || failure.status === "provider-error"
  );
}

function recordProviderFailure(
  preference: CitationProviderPreference,
  failure: ProviderLookupFailure,
): void {
  if (preference === "auto" && shouldDisableForSession(failure)) {
    sessionUnavailableProviders.add(failure.provider);
  }
}

function referenceIdentity(work: RelatedWorkMetadata): string {
  const doi = normalizeDOI(work.doi);
  if (doi) return `doi:${doi}`;
  const title = normalizeExactTitle(work.title);
  if (title) return `title:${title}:year:${work.year ?? "unknown"}`;
  const providerWorkID = String(work.providerWorkID ?? "").trim();
  if (providerWorkID) {
    return `${work.provider}:${providerWorkID.toLocaleLowerCase()}`;
  }
  return `${work.provider}:unknown:${JSON.stringify([
    work.authors.slice(0, 2),
    work.year,
    work.sourceTitle ?? null,
  ])}`;
}

function mergeReferenceLists(
  ...groups: RelatedWorkMetadata[][]
): RelatedWorkMetadata[] {
  const merged = new Map<string, RelatedWorkMetadata>();
  for (const group of groups) {
    for (const work of group) {
      const key = referenceIdentity(work);
      const previous = merged.get(key);
      merged.set(
        key,
        previous ? mergeRelatedWorkMetadata(previous, work) : { ...work },
      );
    }
  }
  return [...merged.values()];
}

function richerReferences(
  left: ProviderLookupSuccess,
  right: ProviderLookupSuccess,
): ProviderLookupSuccess {
  const references = mergeReferenceLists(left.references, right.references);
  const leftCount = left.referenceCount ?? left.resolvedReferenceCount;
  const rightCount = right.referenceCount ?? right.resolvedReferenceCount;
  const rightReportedMore = rightCount > leftCount;
  return {
    ...left,
    referenceCount: Math.max(leftCount, rightCount, references.length),
    referenceCountProvider: rightReportedMore
      ? right.referenceCountProvider
      : left.referenceCountProvider,
    resolvedReferenceCount: Math.max(
      left.resolvedReferenceCount,
      right.resolvedReferenceCount,
      references.length,
    ),
    references,
  };
}

function mergeEnrichment(
  canonical: ProviderLookupSuccess,
  enrichment: ProviderLookupSuccess,
): ProviderLookupSuccess {
  // OpenAlex reference arrays are often ID-only. They may enrich scalar fields,
  // but should not replace a richer structured bibliography.
  const references =
    enrichment.provider === "openalex"
      ? canonical
      : richerReferences(canonical, enrichment);
  const canonicalTitle = String(canonical.title ?? "").trim();
  return {
    ...references,
    doi: canonical.doi ?? enrichment.doi,
    title: canonicalTitle ? canonical.title : enrichment.title,
    year: canonical.year ?? enrichment.year,
    authors:
      canonical.authors.length > 0 ? canonical.authors : enrichment.authors,
    sourceTitle: canonical.sourceTitle ?? enrichment.sourceTitle,
    abstract: canonical.abstract ?? enrichment.abstract,
    citationCount: canonical.citationCount ?? enrichment.citationCount,
    citationCountProvider:
      canonical.citationCount !== null
        ? canonical.citationCountProvider
        : enrichment.citationCountProvider,
    fwci: canonical.fwci ?? enrichment.fwci ?? null,
    citationPercentile:
      canonical.citationPercentile ?? enrichment.citationPercentile ?? null,
    isTop1Percent: canonical.isTop1Percent ?? enrichment.isTop1Percent ?? null,
    isTop10Percent:
      canonical.isTop10Percent ?? enrichment.isTop10Percent ?? null,
    citationCountsByYear: canonical.citationCountsByYear?.length
      ? canonical.citationCountsByYear
      : (enrichment.citationCountsByYear ?? []),
    citationsLastYear:
      canonical.citationsLastYear ?? enrichment.citationsLastYear ?? null,
    citationVelocity:
      canonical.citationVelocity ?? enrichment.citationVelocity ?? null,
    citationAcceleration:
      canonical.citationAcceleration ?? enrichment.citationAcceleration ?? null,
    influentialCitationCount:
      canonical.influentialCitationCount ??
      enrichment.influentialCitationCount ??
      null,
    isRetracted: canonical.isRetracted ?? enrichment.isRetracted ?? null,
    openAccessStatus:
      canonical.openAccessStatus ?? enrichment.openAccessStatus ?? null,
    isOpenAccess: canonical.isOpenAccess ?? enrichment.isOpenAccess ?? null,
    publicationType:
      canonical.publicationType ?? enrichment.publicationType ?? null,
    sourceMetrics: canonical.sourceMetrics ?? enrichment.sourceMetrics ?? null,
  };
}

async function providerLookup(
  provider: CitationProvider,
  identifiers: WorkIdentifiers,
  allowTitleFallback: boolean,
  forRelationships = false,
): Promise<ProviderLookupResult> {
  const lookup =
    forRelationships && provider.lookupForRelations
      ? provider.lookupForRelations
      : provider.lookup;
  if (provider.supports(identifiers)) return lookup(identifiers);
  if (
    allowTitleFallback &&
    provider.searchExactTitle &&
    identifiers.normalizedTitle
  ) {
    return provider.searchExactTitle(identifiers);
  }
  return {
    status: "no-identifier",
    provider: provider.id,
    message: `${provider.label} cannot resolve the available identifiers.`,
  };
}

function resultNeedsProviderEnrichment(
  result: ProviderLookupSuccess,
  provider: CitationProvider,
): boolean {
  if (!String(result.title ?? "").trim()) return true;
  if (result.year === null || result.authors.length === 0) return true;
  if (!String(result.sourceTitle ?? "").trim()) return true;
  if (provider.capabilities.abstract && !result.abstract) return true;
  if (provider.capabilities.citationCount && result.citationCount === null) {
    return true;
  }
  if (provider.capabilities.referenceCount && result.referenceCount === null) {
    return true;
  }
  if (provider.capabilities.referencedWorks) {
    const resolved = Math.max(
      result.resolvedReferenceCount,
      result.references.length,
    );
    const referencesIncomplete =
      result.referenceCount === null
        ? resolved === 0
        : resolved < result.referenceCount;
    if (referencesIncomplete) return true;
  }
  if (provider.capabilities.openAccess && result.isOpenAccess == null) {
    return true;
  }
  if (provider.capabilities.retraction && result.isRetracted == null) {
    return true;
  }
  if (provider.capabilities.sourceMetrics && !result.sourceMetrics) return true;
  if (provider.id === "semantic-scholar") {
    return result.influentialCitationCount == null || !result.publicationType;
  }
  if (provider.id === "openalex") {
    return (
      result.fwci == null ||
      result.citationPercentile == null ||
      !result.citationCountsByYear?.length
    );
  }
  return false;
}

async function enrichAutomaticResult(
  canonical: ProviderLookupSuccess,
  identifiers: WorkIdentifiers,
  allowTitleFallback: boolean,
): Promise<ProviderLookupSuccess> {
  let result = canonical;
  const plan = getProviderPlan("field-enrichment", "auto");
  for (const providerID of plan.providers) {
    if (providerID === canonical.provider) continue;
    const provider = PROVIDERS[providerID];
    if (!resultNeedsProviderEnrichment(result, provider)) continue;
    try {
      const candidate = await providerLookup(
        provider,
        identifiers,
        allowTitleFallback,
      );
      if (candidate.status === "success") {
        result = mergeEnrichment(result, candidate);
      } else {
        recordProviderFailure("auto", candidate);
      }
    } catch (error) {
      Zotero.debug(
        "Citation Map: optional " +
          `${provider.label} enrichment failed: ${String(error)}`,
      );
    }
  }
  return result;
}

export async function lookupCitationMetrics(
  preference: CitationProviderPreference,
  identifiers: WorkIdentifiers,
  allowTitleFallback = true,
  includeOptionalEnrichment = false,
): Promise<ProviderLookupResult> {
  const plan = getProviderPlan("work-lookup", preference);
  if (!plan.providers.length) {
    const selected =
      preference === "auto" ? "configured providers" : preference;
    return {
      status: "no-identifier",
      provider: preference === "auto" ? "crossref" : preference,
      message: `No ${selected} can perform this lookup.`,
    };
  }

  const failures: ProviderLookupFailure[] = [];
  for (const providerID of plan.providers) {
    const provider = PROVIDERS[providerID];
    let result: ProviderLookupResult;
    try {
      result = await providerLookup(provider, identifiers, allowTitleFallback);
    } catch (error) {
      result = {
        status: "provider-error",
        provider: providerID,
        message: `${provider.label} lookup failed: ${String(error)}`,
      };
    }
    if (result.status === "success") {
      // A concrete provider means exactly that provider. Cross-provider
      // completion is reserved for Automatic mode.
      return preference === "auto" && includeOptionalEnrichment
        ? enrichAutomaticResult(result, identifiers, allowTitleFallback)
        : result;
    }
    failures.push(result);
    recordProviderFailure(preference, result);
    if (result.status === "ambiguous-match") return result;
  }

  return failures.length
    ? chooseFailure(failures)
    : {
        status: "no-identifier",
        provider: preference === "auto" ? "crossref" : preference,
        message:
          "No supported DOI, PMID, arXiv ID, ISBN, or exact normalized " +
          "title was found.",
      };
}

function relatedWorkNeedsMetadata(work: RelatedWorkMetadata): boolean {
  return (
    !String(work.title ?? "").trim() ||
    work.year === null ||
    work.authors.length === 0 ||
    !String(work.sourceTitle ?? "").trim()
  );
}

function identifiersForRelatedWork(work: RelatedWorkMetadata): WorkIdentifiers {
  return {
    doi: normalizeDOI(work.doi),
    pmid: String(work.pmid ?? "").trim() || null,
    arxiv: String(work.arxiv ?? "").trim() || null,
    isbn: String(work.isbn ?? "").trim() || null,
    title: String(work.title ?? "").trim(),
    normalizedTitle: normalizeExactTitle(work.title),
    year: work.year,
    authors: work.authors,
    sourceTitle: work.sourceTitle ?? null,
  };
}

function relatedFromLookup(result: ProviderLookupSuccess): RelatedWorkMetadata {
  return {
    provider: result.provider,
    providerWorkID: result.providerWorkID,
    doi: result.doi,
    title: result.title,
    year: result.year,
    authors: result.authors,
    sourceTitle: result.sourceTitle,
    abstract: result.abstract,
    citationCount: result.citationCount,
    referenceCount: result.referenceCount,
    isOpenAccess: result.isOpenAccess ?? null,
    openAccessStatus: result.openAccessStatus ?? null,
    isRetracted: result.isRetracted ?? null,
    dataSources: [result.provider],
    updatedAt: new Date().toISOString(),
  };
}

export function mergeRelatedWorkMetadata<T extends RelatedWorkMetadata>(
  work: T,
  metadata: RelatedWorkMetadata | null,
): T {
  if (!metadata) return work;
  const metadataMatches = metadataIsNonContradictory(
    identifiersForRelatedWork(work),
    metadata,
  );
  if (!metadataMatches && (work.title || work.year || work.authors.length)) {
    return work;
  }
  const sources = new Set<CitationProviderID>(work.dataSources ?? []);
  if (work.provider !== "manual" && work.provider !== "zotero") {
    sources.add(work.provider);
  }
  for (const source of metadata.dataSources ?? []) sources.add(source);
  if (metadata.provider !== "manual" && metadata.provider !== "zotero") {
    sources.add(metadata.provider);
  }
  const timestamps = [work.updatedAt, metadata.updatedAt]
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => Date.parse(left) - Date.parse(right));
  return {
    ...work,
    doi: work.doi ?? metadata.doi,
    pmid: work.pmid ?? metadata.pmid,
    arxiv: work.arxiv ?? metadata.arxiv,
    isbn: work.isbn ?? metadata.isbn,
    title: String(work.title ?? "").trim() ? work.title : metadata.title,
    year: work.year ?? metadata.year,
    authors: work.authors.length ? work.authors : metadata.authors,
    sourceTitle: work.sourceTitle ?? metadata.sourceTitle,
    abstract: work.abstract ?? metadata.abstract,
    citationCount: work.citationCount ?? metadata.citationCount,
    referenceCount: work.referenceCount ?? metadata.referenceCount,
    isOpenAccess: work.isOpenAccess ?? metadata.isOpenAccess,
    openAccessStatus: work.openAccessStatus ?? metadata.openAccessStatus,
    isRetracted: work.isRetracted ?? metadata.isRetracted,
    dataSources: [...sources],
    updatedAt: timestamps.at(-1) ?? new Date().toISOString(),
  };
}

function semanticScholarIdentifier(work: RelatedWorkMetadata): string | null {
  if (work.provider === "semantic-scholar" && work.providerWorkID?.trim()) {
    return work.providerWorkID.trim();
  }
  const doi = normalizeDOI(work.doi);
  if (doi) return `DOI:${doi}`;
  if (work.pmid?.trim()) return `PMID:${work.pmid.trim()}`;
  if (work.arxiv?.trim()) return `ARXIV:${work.arxiv.trim()}`;
  if (work.isbn?.trim()) return `ISBN:${work.isbn.trim()}`;
  return null;
}

function openAlexIdentifier(work: RelatedWorkMetadata): string | null {
  return work.provider === "openalex" && work.providerWorkID?.trim()
    ? work.providerWorkID.trim()
    : null;
}

async function runBounded<T>(
  items: T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await task(items[index], index);
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), items.length) },
      () => worker(),
    ),
  );
}

async function applySemanticScholarBatch(
  works: RelatedWorkMetadata[],
): Promise<boolean[]> {
  const resolved = works.map(() => false);
  const candidates = works
    .map((work, index) => ({
      index,
      identifier: semanticScholarIdentifier(work),
    }))
    .filter((candidate): candidate is { index: number; identifier: string } =>
      Boolean(candidate.identifier),
    );
  for (
    let start = 0;
    start < candidates.length;
    start += SEMANTIC_SCHOLAR_RESOLUTION_BATCH_SIZE
  ) {
    const batch = candidates.slice(
      start,
      start + SEMANTIC_SCHOLAR_RESOLUTION_BATCH_SIZE,
    );
    const metadata = await fetchSemanticScholarPapersBatch(
      batch.map((candidate) => candidate.identifier),
    );
    for (const [batchIndex, candidate] of batch.entries()) {
      const entry = metadata[batchIndex];
      if (!entry) continue;
      works[candidate.index] = mergeRelatedWorkMetadata(
        works[candidate.index],
        entry,
      );
      resolved[candidate.index] = true;
    }
  }
  return resolved;
}

async function applyOpenAlexBatch(
  works: RelatedWorkMetadata[],
): Promise<boolean[]> {
  const resolved = works.map(() => false);
  const candidates = works
    .map((work, index) => ({ index, identifier: openAlexIdentifier(work) }))
    .filter((candidate): candidate is { index: number; identifier: string } =>
      Boolean(candidate.identifier),
    );
  for (let start = 0; start < candidates.length; start += 100) {
    const batch = candidates.slice(start, start + 100);
    const metadata = await fetchOpenAlexWorksBatch(
      batch.map((candidate) => candidate.identifier),
    );
    for (const [batchIndex, candidate] of batch.entries()) {
      const entry = metadata[batchIndex];
      if (!entry) continue;
      works[candidate.index] = mergeRelatedWorkMetadata(
        works[candidate.index],
        entry,
      );
      resolved[candidate.index] = true;
    }
  }
  return resolved;
}

/** Resolve incomplete external-paper records through the same user-selected
 * provider policy used by updates and relationship discovery. */
export async function resolveRelatedWorksMetadata(
  input: RelatedWorkMetadata[],
  preference: CitationProviderPreference,
): Promise<RelatedWorkMetadata[]> {
  const works = input.map((work) => ({ ...work, authors: [...work.authors] }));
  const plan = getProviderPlan("metadata-resolution", preference);

  for (const providerID of plan.providers) {
    const unresolvedIndexes = works
      .map((work, index) => ({ work, index }))
      .filter(({ work }) => relatedWorkNeedsMetadata(work))
      .map(({ index }) => index);
    if (!unresolvedIndexes.length) break;

    const subset = unresolvedIndexes.map((index) => works[index]);
    let batchResolved = subset.map(() => false);
    try {
      if (providerID === "semantic-scholar") {
        batchResolved = await applySemanticScholarBatch(subset);
      } else if (providerID === "openalex") {
        batchResolved = await applyOpenAlexBatch(subset);
      }
    } catch (error) {
      Zotero.debug(
        "Citation Map: " +
          `${PROVIDERS[providerID].label} batch metadata resolution failed: ` +
          String(error),
      );
    }
    for (const [subsetIndex, originalIndex] of unresolvedIndexes.entries()) {
      works[originalIndex] = subset[subsetIndex];
    }

    const provider = PROVIDERS[providerID];
    const genericCandidates = unresolvedIndexes.filter(
      (_, subsetIndex) =>
        !batchResolved[subsetIndex] &&
        relatedWorkNeedsMetadata(works[unresolvedIndexes[subsetIndex]]),
    );
    await runBounded(
      genericCandidates,
      METADATA_RESOLUTION_CONCURRENCY,
      async (workIndex) => {
        const identifiers = identifiersForRelatedWork(works[workIndex]);
        try {
          const result = await providerLookup(
            provider,
            identifiers,
            true,
            true,
          );
          if (result.status === "success") {
            works[workIndex] = mergeRelatedWorkMetadata(
              works[workIndex],
              relatedFromLookup(result),
            );
          } else {
            recordProviderFailure(preference, result);
          }
        } catch (error) {
          Zotero.debug(
            "Citation Map: " +
              `${provider.label} metadata resolution failed: ${String(error)}`,
          );
        }
      },
    );
  }

  return works;
}

export interface SimilarWorkResult extends RelatedWorkMetadata {
  recommendationScore: number;
  recommendationSources: CitationProviderID[];
}

function recommendationIdentity(work: RelatedWorkMetadata): string | null {
  const doi = normalizeDOI(work.doi);
  if (doi) return `doi:${doi}`;
  const title = normalizeExactTitle(work.title);
  if (title) return `title:${title}:year:${work.year ?? "unknown"}`;
  if (work.providerWorkID?.trim()) {
    return `${work.provider}:${work.providerWorkID.trim().toLocaleLowerCase()}`;
  }
  return null;
}

/** Discover genuinely recommended/related papers through provider-native
 * recommendation systems. Citation-neighbour fallbacks remain outside this
 * function and are used only when the selected providers return no actual
 * recommendations. */
export async function discoverSimilarWorks(
  seeds: WorkIdentifiers[],
  preference: CitationProviderPreference,
  maximum = 100,
): Promise<SimilarWorkResult[]> {
  const plan = getProviderPlan("similar", preference);
  const candidates = new Map<
    string,
    {
      work: RelatedWorkMetadata;
      score: number;
      sources: Set<CitationProviderID>;
    }
  >();
  const requested = Math.min(500, Math.max(1, maximum));

  for (const providerID of plan.providers) {
    let works: RelatedWorkMetadata[];
    try {
      if (providerID === "semantic-scholar") {
        works = await fetchSemanticScholarRecommendations(seeds, requested);
      } else if (providerID === "crossref") {
        works = await fetchCrossrefRelatedWorks(seeds, requested);
      } else if (providerID === "openalex") {
        works = await fetchOpenAlexRelatedWorks(seeds, requested);
      } else {
        continue;
      }
    } catch (error) {
      Zotero.debug(
        `Citation Map: ${PROVIDERS[providerID].label} similar-paper discovery failed: ${String(error)}`,
      );
      continue;
    }

    for (const [rank, work] of works.entries()) {
      const identity = recommendationIdentity(work);
      if (!identity) continue;
      const current = candidates.get(identity) ?? {
        work,
        score: 0,
        sources: new Set<CitationProviderID>(),
      };
      current.work = mergeRelatedWorkMetadata(current.work, work);
      // Reciprocal-rank fusion combines recommendation lists without assuming
      // that provider-specific scores use compatible scales.
      current.score += 1 / (60 + rank + 1);
      current.sources.add(providerID);
      candidates.set(identity, current);
    }
  }

  return [...candidates.values()]
    .map((candidate) => ({
      ...candidate.work,
      recommendationScore: candidate.score,
      recommendationSources: [...candidate.sources],
    }))
    .sort(
      (left, right) =>
        right.recommendationScore - left.recommendationScore ||
        (right.citationCount ?? -1) - (left.citationCount ?? -1) ||
        (right.year ?? -1) - (left.year ?? -1) ||
        String(left.title ?? "").localeCompare(String(right.title ?? "")),
    )
    .slice(0, requested);
}
