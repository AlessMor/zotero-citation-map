import type {
  CitationProviderID,
  CitationProviderPreference,
  ProviderLookupFailure,
} from "../domain/citationTypes";
import { getNASAADSAPIKey } from "../services/citationPreferences";
import { crossrefProvider } from "./crossrefProvider";
import { inspireProvider } from "./inspireProvider";
import { nasaADSProvider } from "./nasaADSProvider";
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
  ads: nasaADSProvider,
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
    "ads",
    "semantic-scholar",
    "opencitations",
    "inspire",
    "openalex",
  ],
  "field-enrichment": [
    "ads",
    "semantic-scholar",
    "opencitations",
    "inspire",
    "openalex",
    "crossref",
  ],
  "metadata-resolution": [
    "ads",
    "semantic-scholar",
    "openalex",
    "crossref",
    "inspire",
  ],
  references: [
    "ads",
    "semantic-scholar",
    "crossref",
    "inspire",
    "opencitations",
    "openalex",
  ],
  citations: [
    "ads",
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

interface ProviderHealthState {
  consecutiveProviderErrors: number;
  unavailableUntil: number;
}

const providerHealth = new Map<CitationProviderID, ProviderHealthState>();
const RATE_LIMIT_COOLDOWN_MS = 60_000;
const PROVIDER_ERROR_THRESHOLD = 3;
const PROVIDER_ERROR_COOLDOWN_MS = 5 * 60_000;

export function getCitationProvider(
  providerID: CitationProviderID,
): CitationProvider {
  return PROVIDERS[providerID];
}

export function resetCitationProviderSessionState(): void {
  providerHealth.clear();
}

function automaticProviderIsAvailable(providerID: CitationProviderID): boolean {
  if (providerID === "ads" && !getNASAADSAPIKey()) return false;
  const state = providerHealth.get(providerID);
  if (!state) return true;
  if (state.unavailableUntil <= Date.now()) {
    providerHealth.delete(providerID);
    return true;
  }
  return false;
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
 * Return the central provider policy used by field updates, relationship
 * discovery, Similar, and incomplete-metadata resolution. Concrete
 * preferences never fall through to another provider. Automatic mode returns
 * the available capability order; the request layer and relationship caller
 * apply the provider selection stored in Settings.
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
      automaticProviderIsAvailable(providerID) &&
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

export function recordProviderFailure(
  preference: CitationProviderPreference,
  failure: ProviderLookupFailure,
): void {
  if (preference !== "auto") return;
  const previous = providerHealth.get(failure.provider) ?? {
    consecutiveProviderErrors: 0,
    unavailableUntil: 0,
  };
  if (failure.status === "rate-limited") {
    providerHealth.set(failure.provider, {
      consecutiveProviderErrors: previous.consecutiveProviderErrors,
      unavailableUntil: Date.now() + RATE_LIMIT_COOLDOWN_MS,
    });
    return;
  }
  if (failure.status !== "provider-error") return;
  const consecutiveProviderErrors = previous.consecutiveProviderErrors + 1;
  providerHealth.set(failure.provider, {
    consecutiveProviderErrors,
    unavailableUntil:
      consecutiveProviderErrors >= PROVIDER_ERROR_THRESHOLD
        ? Date.now() + PROVIDER_ERROR_COOLDOWN_MS
        : previous.unavailableUntil,
  });
}

export function recordProviderSuccess(providerID: CitationProviderID): void {
  providerHealth.delete(providerID);
}
