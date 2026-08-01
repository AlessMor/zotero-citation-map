import type {
  CitationProviderPreference,
  ProviderLookupFailure,
  ProviderLookupResult,
  ProviderLookupSuccess,
  WorkIdentifiers,
} from "../domain/citationTypes";
import { firstPublicationYear } from "../domain/valueNormalization";
import {
  maximumKnownCount,
  richestCountAttribution,
} from "../services/citationCountPolicy";
import {
  getCitationProvider,
  getProviderPlan,
  recordProviderFailure,
  recordProviderSuccess,
} from "./registry";
import type { CitationProvider, ProviderRequestOptions } from "./types";

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

function richerReferences(
  left: ProviderLookupSuccess,
  right: ProviderLookupSuccess,
): ProviderLookupSuccess {
  const leftResolved =
    maximumKnownCount([left.resolvedReferenceCount, left.references.length]) ??
    0;
  const rightResolved =
    maximumKnownCount([
      right.resolvedReferenceCount,
      right.references.length,
    ]) ?? 0;
  const selected = rightResolved > leftResolved ? right : left;
  const leftHasReportedCount = left.referenceCount !== null;
  return {
    ...left,
    referenceCount: leftHasReportedCount
      ? left.referenceCount
      : right.referenceCount,
    referenceCountProvider: leftHasReportedCount
      ? left.referenceCountProvider
      : right.referenceCountProvider,
    resolvedReferenceCount:
      maximumKnownCount([
        selected.resolvedReferenceCount,
        selected.references.length,
      ]) ?? 0,
    references: selected.references,
  };
}

function mergeEnrichment(
  canonical: ProviderLookupSuccess,
  enrichment: ProviderLookupSuccess,
): ProviderLookupSuccess {
  const references = richerReferences(canonical, enrichment);
  const citationCount = richestCountAttribution([
    {
      count: canonical.citationCount,
      provider: canonical.citationCountProvider,
    },
    {
      count: enrichment.citationCount,
      provider: enrichment.citationCountProvider,
    },
  ]);
  const canonicalTitle = String(canonical.title ?? "").trim();
  return {
    ...references,
    doi: canonical.doi ?? enrichment.doi,
    title: canonicalTitle ? canonical.title : enrichment.title,
    year: firstPublicationYear(canonical.year, enrichment.year),
    authors:
      canonical.authors.length > 0 ? canonical.authors : enrichment.authors,
    sourceTitle: canonical.sourceTitle ?? enrichment.sourceTitle,
    abstract: canonical.abstract ?? enrichment.abstract,
    citationCount: citationCount.count,
    citationCountProvider:
      citationCount.provider ?? canonical.citationCountProvider,
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

export async function lookupWithProvider(
  provider: CitationProvider,
  identifiers: WorkIdentifiers,
  allowTitleFallback: boolean,
  forRelationships = false,
  requestOptions?: ProviderRequestOptions,
): Promise<ProviderLookupResult> {
  const lookup =
    forRelationships && provider.lookupForRelations
      ? provider.lookupForRelations
      : provider.lookup;
  if (provider.supports(identifiers))
    return lookup(identifiers, requestOptions);
  if (
    allowTitleFallback &&
    provider.searchExactTitle &&
    identifiers.normalizedTitle
  ) {
    return provider.searchExactTitle(identifiers, requestOptions);
  }
  return {
    status: "no-identifier",
    provider: provider.id,
    message: `${provider.label} cannot resolve the available identifiers.`,
  };
}

async function enrichAutomaticResult(
  canonical: ProviderLookupSuccess,
  identifiers: WorkIdentifiers,
  allowTitleFallback: boolean,
  requestOptions?: ProviderRequestOptions,
): Promise<ProviderLookupSuccess> {
  let result = canonical;
  const plan = getProviderPlan("field-enrichment", "auto");
  const enrichments = await Promise.all(
    plan.providers
      .filter((providerID) => providerID !== canonical.provider)
      .map(async (providerID) => {
        const provider = getCitationProvider(providerID);
        try {
          return {
            provider,
            candidate: await lookupWithProvider(
              provider,
              identifiers,
              allowTitleFallback,
              false,
              requestOptions,
            ),
          };
        } catch (error) {
          Zotero.debug(
            "Citation Map: optional " +
              `${provider.label} enrichment failed: ${String(error)}`,
          );
          return null;
        }
      }),
  );
  // Merge in provider-plan order so concurrent execution remains deterministic.
  for (const enrichment of enrichments) {
    if (!enrichment) continue;
    if (enrichment.candidate.status === "success") {
      recordProviderSuccess(enrichment.provider.id);
      result = mergeEnrichment(result, enrichment.candidate);
    } else {
      recordProviderFailure("auto", enrichment.candidate);
    }
  }
  return result;
}

export async function lookupCitationMetrics(
  preference: CitationProviderPreference,
  identifiers: WorkIdentifiers,
  allowTitleFallback = true,
  includeOptionalEnrichment = false,
  requestOptions?: ProviderRequestOptions,
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
    const provider = getCitationProvider(providerID);
    let result: ProviderLookupResult;
    try {
      result = await lookupWithProvider(
        provider,
        identifiers,
        allowTitleFallback,
        false,
        requestOptions,
      );
    } catch (error) {
      result = {
        status: "provider-error",
        provider: providerID,
        message: `${provider.label} lookup failed: ${String(error)}`,
      };
    }
    if (result.status === "success") {
      recordProviderSuccess(providerID);
      // A concrete provider means exactly that provider. Cross-provider
      // completion is reserved for Automatic mode.
      return preference === "auto" && includeOptionalEnrichment
        ? enrichAutomaticResult(
            result,
            identifiers,
            allowTitleFallback,
            requestOptions,
          )
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
