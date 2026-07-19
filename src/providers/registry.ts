import type {
  CitationProviderID,
  CitationProviderPreference,
  ProviderLookupFailure,
  ProviderLookupResult,
  ProviderLookupSuccess,
  WorkIdentifiers,
} from "../domain/citationTypes";
import { crossrefProvider } from "./crossrefProvider";
import { inspireProvider } from "./inspireProvider";
import { openAlexProvider } from "./openAlexProvider";
import { openCitationsProvider } from "./openCitationsProvider";
import { semanticScholarProvider } from "./semanticScholarProvider";
import type { CitationProvider } from "./types";

const PROVIDERS: Record<CitationProviderID, CitationProvider> = {
  crossref: crossrefProvider,
  "semantic-scholar": semanticScholarProvider,
  opencitations: openCitationsProvider,
  inspire: inspireProvider,
  openalex: openAlexProvider,
};

// Crossref is the default public, no-key provider. Other providers enrich
// relationship lists and metrics when their anonymous public endpoints allow it.
const AUTO_PROVIDER_ORDER: CitationProviderID[] = [
  "crossref",
  "semantic-scholar",
  "opencitations",
  "inspire",
  "openalex",
];
const TITLE_SEARCH_ORDER: CitationProviderID[] = [
  "crossref",
  "semantic-scholar",
  "openalex",
];
const sessionUnavailableProviders = new Set<CitationProviderID>();

export function getCitationProvider(
  providerID: CitationProviderID,
): CitationProvider {
  return PROVIDERS[providerID];
}

export function getAllCitationProviders(): CitationProvider[] {
  return AUTO_PROVIDER_ORDER.map((providerID) => PROVIDERS[providerID]);
}

export function getAutomaticProviderLabel(): string {
  return "Automatic — Crossref preferred";
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

function richerReferences(
  left: ProviderLookupSuccess,
  right: ProviderLookupSuccess,
): ProviderLookupSuccess {
  if (right.resolvedReferenceCount <= left.resolvedReferenceCount) return left;
  return {
    ...left,
    referenceCount:
      right.referenceCount !== null &&
      (left.referenceCount === null ||
        right.referenceCount > left.referenceCount)
        ? right.referenceCount
        : left.referenceCount,
    referenceCountProvider:
      right.referenceCount !== null &&
      (left.referenceCount === null ||
        right.referenceCount > left.referenceCount)
        ? right.referenceCountProvider
        : left.referenceCountProvider,
    resolvedReferenceCount: right.resolvedReferenceCount,
    references: right.references,
  };
}

function mergeEnrichment(
  canonical: ProviderLookupSuccess,
  enrichment: ProviderLookupSuccess,
): ProviderLookupSuccess {
  // OpenAlex background records may contain relationship identifiers without
  // full title/DOI metadata. Use them for OpenAlex-canonical graphs, but do not
  // replace richer Crossref/Semantic Scholar reference records during
  // optional enrichment.
  const references =
    enrichment.provider === "openalex"
      ? canonical
      : richerReferences(canonical, enrichment);
  return {
    ...references,
    doi: canonical.doi ?? enrichment.doi,
    title: canonical.title ?? enrichment.title,
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

async function enrichAutomaticResult(
  canonical: ProviderLookupSuccess,
  identifiers: WorkIdentifiers,
): Promise<ProviderLookupSuccess> {
  let result = canonical;
  for (const providerID of [
    "semantic-scholar",
    "openalex",
  ] as CitationProviderID[]) {
    if (
      providerID === canonical.provider ||
      sessionUnavailableProviders.has(providerID)
    ) {
      continue;
    }
    const provider = PROVIDERS[providerID];
    if (!provider.supports(identifiers)) continue;
    try {
      const candidate = await provider.lookup(identifiers);
      if (candidate.status === "success") {
        result = mergeEnrichment(result, candidate);
      } else if (shouldDisableForSession(candidate)) {
        sessionUnavailableProviders.add(providerID);
      }
    } catch (error) {
      Zotero.debug(
        `Citation Map: optional ${provider.label} enrichment failed: ${String(error)}`,
      );
    }
  }
  return result;
}

async function searchExactTitle(
  identifiers: WorkIdentifiers,
  includeOptionalEnrichment: boolean,
): Promise<ProviderLookupResult> {
  const failures: ProviderLookupFailure[] = [];
  for (const providerID of TITLE_SEARCH_ORDER) {
    if (sessionUnavailableProviders.has(providerID)) continue;
    const provider = PROVIDERS[providerID];
    if (!provider.searchExactTitle) continue;
    const result = await provider.searchExactTitle(identifiers);
    if (result.status === "success") {
      return includeOptionalEnrichment
        ? enrichAutomaticResult(result, identifiers)
        : result;
    }
    failures.push(result);
    if (result.status === "ambiguous-match") return result;
    if (shouldDisableForSession(result))
      sessionUnavailableProviders.add(providerID);
  }
  return chooseFailure(failures);
}

export async function lookupCitationMetrics(
  preference: CitationProviderPreference,
  identifiers: WorkIdentifiers,
  allowTitleFallback = true,
  includeOptionalEnrichment = false,
): Promise<ProviderLookupResult> {
  if (preference !== "auto") {
    const provider = getCitationProvider(preference);
    if (provider.supports(identifiers)) return provider.lookup(identifiers);
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
      message: `${provider.label} cannot resolve the identifiers available on this Zotero item.`,
    };
  }

  const failures: ProviderLookupFailure[] = [];
  for (const providerID of AUTO_PROVIDER_ORDER) {
    if (sessionUnavailableProviders.has(providerID)) continue;
    const provider = PROVIDERS[providerID];
    if (!provider.supports(identifiers)) continue;
    const result = await provider.lookup(identifiers);
    if (result.status === "success") {
      return includeOptionalEnrichment
        ? enrichAutomaticResult(result, identifiers)
        : result;
    }
    failures.push(result);
    if (result.status === "ambiguous-match") return result;
    if (shouldDisableForSession(result))
      sessionUnavailableProviders.add(providerID);
  }

  if (allowTitleFallback && identifiers.normalizedTitle) {
    const titleResult = await searchExactTitle(
      identifiers,
      includeOptionalEnrichment,
    );
    if (
      titleResult.status === "success" ||
      titleResult.status === "ambiguous-match"
    ) {
      return titleResult;
    }
    failures.push(titleResult);
  }

  return failures.length
    ? chooseFailure(failures)
    : {
        status: "no-identifier",
        provider: "crossref",
        message:
          "No supported DOI, PMID, arXiv ID, ISBN, or exact normalized title was found.",
      };
}
