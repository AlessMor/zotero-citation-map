import { config } from "../../package.json";
import type {
  CitationProviderID,
  CitationProviderPreference,
} from "../domain/citationTypes";
import type { GraphLayoutOptions } from "../domain/graphTypes";
import { citationDataSourceLabel } from "./providerPresentation";

const key = (name: string): string => `${config.prefsPrefix}.${name}`;
const PROVIDER_LABELS: Pick<
  Record<CitationProviderPreference, string>,
  "auto"
> = {
  auto: "Automatic — combine selected providers",
};
export const CITATION_PROVIDER_IDS: readonly CitationProviderID[] = [
  "crossref",
  "semantic-scholar",
  "opencitations",
  "inspire",
  "openalex",
];
const PROVIDER_SELECTION_VERSION = 5;
const PROVIDER_PREF_NAMES: Record<CitationProviderID, string> = {
  crossref: "providerCrossrefEnabled",
  "semantic-scholar": "providerSemanticScholarEnabled",
  opencitations: "providerOpenCitationsEnabled",
  inspire: "providerInspireEnabled",
  openalex: "providerOpenAlexEnabled",
};

function boolPref(name: string, fallback: boolean): boolean {
  const value = Zotero.Prefs.get(key(name), true);
  return value === undefined || value === null ? fallback : Boolean(value);
}

function migrateProviderSelection(): void {
  const version = Number(
    Zotero.Prefs.get(key("providerSelectionVersion"), true) ?? 0,
  );
  if (version >= PROVIDER_SELECTION_VERSION) return;

  // Version 5 activates an explicit Automatic mode. Reset earlier development
  // states once so existing profiles start from the intended all-provider
  // default instead of retaining an inconsistent partial selection.
  Zotero.Prefs.set(key("providerAutomatic"), true, true);
  for (const provider of CITATION_PROVIDER_IDS) {
    Zotero.Prefs.set(key(PROVIDER_PREF_NAMES[provider]), true, true);
  }
  Zotero.Prefs.set(key("provider"), "auto", true);
  Zotero.Prefs.set(
    key("providerSelectionVersion"),
    PROVIDER_SELECTION_VERSION,
    true,
  );
}

export function getProviderAutomaticEnabled(): boolean {
  migrateProviderSelection();
  return boolPref("providerAutomatic", true);
}

export function setProviderAutomaticEnabled(enabled: boolean): void {
  migrateProviderSelection();
  Zotero.Prefs.set(key("providerAutomatic"), enabled, true);
  if (!enabled) return;
  for (const provider of CITATION_PROVIDER_IDS) {
    Zotero.Prefs.set(key(PROVIDER_PREF_NAMES[provider]), true, true);
  }
}

export function getProviderLabel(provider: CitationProviderPreference): string {
  if (provider !== "auto") return citationDataSourceLabel(provider);
  const selected = getEnabledProviders();
  if (selected.length === 1) return citationDataSourceLabel(selected[0]);
  return selected.length === CITATION_PROVIDER_IDS.length
    ? PROVIDER_LABELS.auto
    : `${selected.length} selected providers`;
}

/**
 * Provider combinations are represented by individual boolean preferences.
 * The legacy single-provider preference is retained only for migration and API
 * compatibility; normal lookups always use automatic capability routing.
 */
export function getProviderPreference(): CitationProviderPreference {
  migrateProviderSelection();
  return "auto";
}

export function setProviderPreference(
  provider: CitationProviderPreference,
): void {
  migrateProviderSelection();
  const automatic = provider === "auto";
  Zotero.Prefs.set(key("providerAutomatic"), automatic, true);
  for (const candidate of CITATION_PROVIDER_IDS) {
    Zotero.Prefs.set(
      key(PROVIDER_PREF_NAMES[candidate]),
      automatic || provider === candidate,
      true,
    );
  }
  Zotero.Prefs.set(key("provider"), "auto", true);
}

export function getEnabledProviders(): CitationProviderID[] {
  migrateProviderSelection();
  if (getProviderAutomaticEnabled()) {
    for (const provider of CITATION_PROVIDER_IDS) {
      Zotero.Prefs.set(key(PROVIDER_PREF_NAMES[provider]), true, true);
    }
    return [...CITATION_PROVIDER_IDS];
  }

  const selected = CITATION_PROVIDER_IDS.filter((provider) =>
    boolPref(PROVIDER_PREF_NAMES[provider], true),
  );
  if (selected.length) return selected;

  // A provider-less dispatcher cannot perform any update. Recover corrupted
  // custom settings to Automatic rather than silently returning no results.
  setProviderAutomaticEnabled(true);
  return [...CITATION_PROVIDER_IDS];
}

export function isProviderEnabled(provider: CitationProviderID): boolean {
  return getEnabledProviders().includes(provider);
}

export function setProviderEnabled(
  provider: CitationProviderID,
  enabled: boolean,
): void {
  migrateProviderSelection();
  if (!enabled) Zotero.Prefs.set(key("providerAutomatic"), false, true);
  Zotero.Prefs.set(key(PROVIDER_PREF_NAMES[provider]), enabled, true);
}

export function getOpenAlexAPIKey(): string {
  return String(Zotero.Prefs.get(key("openAlexAPIKey"), true) ?? "").trim();
}
export function setOpenAlexAPIKey(apiKey: string): void {
  Zotero.Prefs.set(key("openAlexAPIKey"), apiKey.trim(), true);
}

export function getSemanticScholarAPIKey(): string {
  return String(
    Zotero.Prefs.get(key("semanticScholarAPIKey"), true) ?? "",
  ).trim();
}
export function setSemanticScholarAPIKey(apiKey: string): void {
  Zotero.Prefs.set(key("semanticScholarAPIKey"), apiKey.trim(), true);
}

export function getShowMetricTooltipsEnabled(): boolean {
  return boolPref("showMetricTooltips", true);
}

function getAutomaticUpdateModeEnabled(): boolean {
  return boolPref("automaticUpdates", true);
}

export function getAutomaticUpdatesEnabled(): boolean {
  return (
    getAutomaticUpdateModeEnabled() ||
    boolPref("updateNewItems", true) ||
    boolPref("updateModifiedItems", true) ||
    boolPref("checkStaleOnStartup", true)
  );
}
export function setAutomaticUpdatesEnabled(enabled: boolean): void {
  Zotero.Prefs.set(key("automaticUpdates"), enabled, true);
  if (!enabled) return;
  Zotero.Prefs.set(key("updateNewItems"), true, true);
  Zotero.Prefs.set(key("updateModifiedItems"), true, true);
  Zotero.Prefs.set(key("checkStaleOnStartup"), true, true);
}

export function getUpdateNewItemsEnabled(): boolean {
  return getAutomaticUpdateModeEnabled() || boolPref("updateNewItems", true);
}
export function setUpdateNewItemsEnabled(enabled: boolean): void {
  Zotero.Prefs.set(key("updateNewItems"), enabled, true);
}

export function getUpdateModifiedItemsEnabled(): boolean {
  return (
    getAutomaticUpdateModeEnabled() || boolPref("updateModifiedItems", true)
  );
}

export function getCheckStaleOnStartupEnabled(): boolean {
  return (
    getAutomaticUpdateModeEnabled() || boolPref("checkStaleOnStartup", true)
  );
}

export function getCacheDays(): number {
  const value = Number(Zotero.Prefs.get(key("cacheDays"), true));
  return Number.isFinite(value) && value >= 1
    ? Math.min(3650, Math.floor(value))
    : 30;
}
export function setCacheDays(days: number): void {
  Zotero.Prefs.set(key("cacheDays"), Math.max(1, Math.floor(days)), true);
}

export function getExactTitleFallbackEnabled(): boolean {
  return boolPref("exactTitleFallback", true);
}
export function setExactTitleFallbackEnabled(enabled: boolean): void {
  Zotero.Prefs.set(key("exactTitleFallback"), enabled, true);
}

// These are core Citation Map data sources rather than optional features.
// Keep the legacy preferences readable for profile compatibility, but do not
// allow them to disable relationship construction.
export function getLocalRelationsEnabled(): boolean {
  return true;
}
export function getNoteExtractionEnabled(): boolean {
  return true;
}
export function getPDFExtractionEnabled(): boolean {
  return true;
}
export function getDebugLoggingEnabled(): boolean {
  return boolPref("debugLogging", false);
}

export function getDetailPanelWidth(): number {
  const value = Number(Zotero.Prefs.get(key("detailPanelWidth"), true));
  return Number.isFinite(value) && value >= 260 ? value : 360;
}
export function setDetailPanelWidth(width: number): void {
  Zotero.Prefs.set(
    key("detailPanelWidth"),
    Math.max(260, Math.round(width)),
    true,
  );
}
export function getDetailPanelCollapsed(): boolean {
  return boolPref("detailPanelCollapsed", false);
}
export function setDetailPanelCollapsed(collapsed: boolean): void {
  Zotero.Prefs.set(key("detailPanelCollapsed"), collapsed, true);
}

const GRAPH_APPEARANCE_SCHEMA_VERSION = 4;

const PREVIOUS_DEFAULT_GRAPH_LAYOUT: GraphLayoutOptions = {
  xMetric: "year",
  xScale: "linear",
  yMetric: "citations",
  yScale: "linear",
  nodeSizeMetric: "citations",
  nodeColorMetric: "collection",
  nodeLabelMode: "title",
};

const DEFAULT_GRAPH_LAYOUT: GraphLayoutOptions = {
  ...PREVIOUS_DEFAULT_GRAPH_LAYOUT,
  nodeLabelMode: "author-year",
};

function sameGraphLayout(
  left: GraphLayoutOptions,
  right: GraphLayoutOptions,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function getGraphAppearance(): GraphLayoutOptions {
  const storedVersion = Number(
    Zotero.Prefs.get(key("graphAppearanceVersion"), true),
  );
  const raw = String(Zotero.Prefs.get(key("graphAppearance"), true) ?? "");
  let parsed: Partial<GraphLayoutOptions> = {};
  try {
    parsed = JSON.parse(raw) as Partial<GraphLayoutOptions>;
  } catch {
    // Invalid or absent preferences fall back to the current defaults.
  }

  if (storedVersion === 3) {
    const previous = { ...PREVIOUS_DEFAULT_GRAPH_LAYOUT, ...parsed };
    const migrated = sameGraphLayout(previous, PREVIOUS_DEFAULT_GRAPH_LAYOUT)
      ? { ...DEFAULT_GRAPH_LAYOUT }
      : { ...DEFAULT_GRAPH_LAYOUT, ...parsed };
    setGraphAppearance(migrated);
    return migrated;
  }

  if (storedVersion !== GRAPH_APPEARANCE_SCHEMA_VERSION) {
    setGraphAppearance(DEFAULT_GRAPH_LAYOUT);
    return { ...DEFAULT_GRAPH_LAYOUT };
  }

  return { ...DEFAULT_GRAPH_LAYOUT, ...parsed };
}
export function setGraphAppearance(options: GraphLayoutOptions): void {
  Zotero.Prefs.set(key("graphAppearance"), JSON.stringify(options), true);
  Zotero.Prefs.set(
    key("graphAppearanceVersion"),
    GRAPH_APPEARANCE_SCHEMA_VERSION,
    true,
  );
}
export function resetGraphAppearance(): GraphLayoutOptions {
  setGraphAppearance(DEFAULT_GRAPH_LAYOUT);
  return { ...DEFAULT_GRAPH_LAYOUT };
}
