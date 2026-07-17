import { config } from "../../package.json";
import type {
  CitationProviderID,
  CitationProviderPreference,
} from "../domain/citationTypes";

const PROVIDER_PREF = `${config.prefsPrefix}.provider`;
const AUTOMATIC_PREF = `${config.prefsPrefix}.automaticUpdates`;
const CACHE_DAYS_PREF = `${config.prefsPrefix}.cacheDays`;

const PROVIDER_LABELS: Record<CitationProviderPreference, string> = {
  auto: "Automatic (recommended)",
  openalex: "OpenAlex",
  "semantic-scholar": "Semantic Scholar",
  crossref: "Crossref",
  opencitations: "OpenCitations",
  inspire: "INSPIRE-HEP",
};

const CONCRETE_PROVIDERS = new Set<CitationProviderID>([
  "openalex",
  "semantic-scholar",
  "crossref",
  "opencitations",
  "inspire",
]);

export function getProviderLabel(provider: CitationProviderPreference): string {
  return PROVIDER_LABELS[provider];
}

export function getProviderPreference(): CitationProviderPreference {
  const value = String(Zotero.Prefs.get(PROVIDER_PREF, true) ?? "auto");

  if (value === "auto" || CONCRETE_PROVIDERS.has(value as CitationProviderID)) {
    return value as CitationProviderPreference;
  }

  return "auto";
}

export function setProviderPreference(
  provider: CitationProviderPreference,
): void {
  Zotero.Prefs.set(PROVIDER_PREF, provider, true);
}

export function getAutomaticUpdatesEnabled(): boolean {
  const value = Zotero.Prefs.get(AUTOMATIC_PREF, true);
  return value === undefined || value === null ? true : Boolean(value);
}

export function setAutomaticUpdatesEnabled(enabled: boolean): void {
  Zotero.Prefs.set(AUTOMATIC_PREF, enabled, true);
}

export function getCacheDays(): number {
  const raw = Number(Zotero.Prefs.get(CACHE_DAYS_PREF, true));

  if (!Number.isFinite(raw) || raw < 1) {
    return 30;
  }

  return Math.min(Math.floor(raw), 3650);
}
