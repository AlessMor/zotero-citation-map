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
  openalex: openAlexProvider,
  "semantic-scholar": semanticScholarProvider,
  crossref: crossrefProvider,
  opencitations: openCitationsProvider,
  inspire: inspireProvider,
};

// OpenAlex remains the preferred canonical graph provider because it returns
// stable outgoing work IDs. Automatic mode can refine the bibliography total
// with Crossref without replacing those graph identities.
const sessionUnavailableProviders = new Set<CitationProviderID>();

const AUTO_PROVIDER_ORDER: CitationProviderID[] = [
  "openalex",
  "semantic-scholar",
  "inspire",
  "crossref",
  "opencitations",
];

export function getCitationProvider(
  providerID: CitationProviderID,
): CitationProvider {
  return PROVIDERS[providerID];
}

export function getAllCitationProviders(): CitationProvider[] {
  return AUTO_PROVIDER_ORDER.map((providerID) => PROVIDERS[providerID]);
}

function chooseFailure(
  failures: ProviderLookupFailure[],
): ProviderLookupFailure {
  const priorities: ProviderLookupFailure["status"][] = [
    "rate-limited",
    "network-error",
    "provider-error",
    "not-found",
    "no-identifier",
  ];

  for (const status of priorities) {
    const match = failures.find((failure) => failure.status === status);
    if (match) {
      return match;
    }
  }

  return {
    status: "not-found",
    provider: "openalex",
    message: "No citation provider returned a matching work.",
  };
}

function shouldDisableProviderForSession(
  providerID: CitationProviderID,
  failure: ProviderLookupFailure,
): boolean {
  return (
    providerID === "openalex" &&
    (failure.status === "rate-limited" ||
      (failure.status === "provider-error" &&
        failure.message.includes("Anonymous OpenAlex access")))
  );
}

function chooseLargerReferenceCount(
  canonical: ProviderLookupSuccess,
  candidate: ProviderLookupSuccess,
): ProviderLookupSuccess {
  const canonicalCount = canonical.referenceCount;
  const candidateCount = candidate.referenceCount;

  if (
    candidateCount === null ||
    (canonicalCount !== null && candidateCount <= canonicalCount)
  ) {
    return canonical;
  }

  return {
    ...canonical,
    referenceCount: candidateCount,
    referenceCountProvider: candidate.referenceCountProvider,
  };
}

/**
 * Crossref's `reference-count` usually reflects the number deposited by the
 * publisher, while OpenAlex/Semantic Scholar can expose only the subset they
 * resolved into indexed works. In automatic mode we preserve the canonical
 * provider's outgoing reference identities for graph construction, but use a
 * larger Crossref-declared bibliography total when available.
 */
async function refineDeclaredReferenceCount(
  canonical: ProviderLookupSuccess,
  identifiers: WorkIdentifiers,
): Promise<ProviderLookupSuccess> {
  if (
    canonical.provider === "crossref" ||
    !identifiers.doi ||
    sessionUnavailableProviders.has("crossref")
  ) {
    return canonical;
  }

  try {
    const crossref = await crossrefProvider.lookup(identifiers);
    if (crossref.status !== "success") {
      return canonical;
    }
    return chooseLargerReferenceCount(canonical, crossref);
  } catch (error) {
    Zotero.debug(
      `Citation Map: Crossref reference-count refinement failed: ${String(error)}`,
    );
    return canonical;
  }
}

export async function lookupCitationMetrics(
  preference: CitationProviderPreference,
  identifiers: WorkIdentifiers,
): Promise<ProviderLookupResult> {
  if (preference !== "auto") {
    const provider = getCitationProvider(preference);

    if (!provider.supports(identifiers)) {
      return {
        status: "no-identifier",
        provider: provider.id,
        message: `${provider.label} cannot resolve the identifiers available on this Zotero item.`,
      };
    }

    return provider.lookup(identifiers);
  }

  const failures: ProviderLookupFailure[] = [];

  for (const providerID of AUTO_PROVIDER_ORDER) {
    const provider = PROVIDERS[providerID];

    if (sessionUnavailableProviders.has(providerID)) {
      continue;
    }

    if (!provider.supports(identifiers)) {
      continue;
    }

    const result = await provider.lookup(identifiers);

    if (result.status === "success") {
      return refineDeclaredReferenceCount(result, identifiers);
    }

    failures.push(result);

    if (shouldDisableProviderForSession(providerID, result)) {
      sessionUnavailableProviders.add(providerID);
    }
  }

  if (failures.length === 0) {
    return {
      status: "no-identifier",
      provider: "openalex",
      message:
        "No supported DOI, PMID, arXiv ID, or ISBN was found on this Zotero item.",
    };
  }

  return chooseFailure(failures);
}
