import { config } from "../../package.json";
import {
  CITATION_PROVIDER_IDS,
  type CitationProviderID,
  type CitationProviderPreference,
} from "../domain/citationTypes";
import type { GraphLayoutOptions } from "../domain/graphTypes";
import { uniquePositiveIntegers } from "../domain/valueNormalization";
import { citationDataSourceLabel } from "./providerPresentation";

const key = (name: string): string => `${config.prefsPrefix}.${name}`;
const PROVIDER_LABELS: Pick<
  Record<CitationProviderPreference, string>,
  "auto"
> = {
  auto: "Automatic — combine selected providers",
};
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

function setBoolPref(name: string, value: boolean): void {
  Zotero.Prefs.set(key(name), value, true);
}

function positiveLibraryIDs(values: unknown[]): number[] {
  return uniquePositiveIntegers(values).sort((left, right) => left - right);
}

function parseLibraryIDs(value: unknown): number[] | null {
  try {
    const parsed = JSON.parse(String(value ?? "")) as unknown;
    return Array.isArray(parsed) ? positiveLibraryIDs(parsed) : null;
  } catch {
    return null;
  }
}

export function getProviderAutomaticEnabled(): boolean {
  return boolPref("providerAutomatic", true);
}

export function getProviderLabel(provider: CitationProviderPreference): string {
  if (provider !== "auto") return citationDataSourceLabel(provider);
  const selected = getEnabledProviders();
  if (selected.length === 1) return citationDataSourceLabel(selected[0]);
  return selected.length === CITATION_PROVIDER_IDS.length
    ? PROVIDER_LABELS.auto
    : `${selected.length} selected providers`;
}

export function getEnabledProviders(): CitationProviderID[] {
  if (getProviderAutomaticEnabled()) {
    return [...CITATION_PROVIDER_IDS];
  }

  const selected = CITATION_PROVIDER_IDS.filter((provider) =>
    boolPref(PROVIDER_PREF_NAMES[provider], true),
  );
  if (selected.length) return selected;

  // Older or externally edited preferences can leave custom mode with no
  // provider selected. Recover to the documented safe default instead of
  // aborting startup before the preference pane can be opened.
  setBoolPref("providerAutomatic", true);
  for (const name of Object.values(PROVIDER_PREF_NAMES))
    setBoolPref(name, true);
  Zotero.debug(
    "Citation Map: repaired an invalid empty provider selection by enabling automatic mode.",
  );
  return [...CITATION_PROVIDER_IDS];
}

export function normalizeCitationPreferences(): void {
  getEnabledProviders();
  getUpdateLibraryIDs();
}

export function isProviderEnabled(provider: CitationProviderID): boolean {
  return getEnabledProviders().includes(provider);
}

export function getOpenAlexAPIKey(): string {
  return String(Zotero.Prefs.get(key("openAlexAPIKey"), true) ?? "").trim();
}

export function getSemanticScholarAPIKey(): string {
  return String(
    Zotero.Prefs.get(key("semanticScholarAPIKey"), true) ?? "",
  ).trim();
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

export function getUpdateNewItemsEnabled(): boolean {
  return getAutomaticUpdateModeEnabled() || boolPref("updateNewItems", true);
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

export function getUpdateLibraryIDs(): number[] {
  const parsed = parseLibraryIDs(
    Zotero.Prefs.get(key("updateLibraryIDs"), true),
  );
  if (parsed) return parsed;

  const userLibraryID = Number(Zotero.Libraries.userLibraryID);
  const fallback =
    Number.isInteger(userLibraryID) && userLibraryID > 0 ? [userLibraryID] : [];
  setUpdateLibraryIDs(fallback);
  return fallback;
}

export function setUpdateLibraryIDs(libraryIDs: number[]): void {
  const normalized = positiveLibraryIDs(libraryIDs);
  Zotero.Prefs.set(key("updateLibraryIDs"), JSON.stringify(normalized), true);
}

export function getCacheDays(): number {
  const value = Number(Zotero.Prefs.get(key("cacheDays"), true));
  return Number.isFinite(value) && value >= 1
    ? Math.min(3650, Math.floor(value))
    : 30;
}

export function getExactTitleFallbackEnabled(): boolean {
  return boolPref("exactTitleFallback", true);
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
const FOCUS_GRAPH_APPEARANCE_SCHEMA_VERSION = 1;

const DEFAULT_GRAPH_LAYOUT: GraphLayoutOptions = {
  xMetric: "year",
  xScale: "linear",
  yMetric: "citations",
  yScale: "linear",
  nodeSizeMetric: "citations",
  nodeColorMetric: "collection",
  nodeLabelMode: "author-year",
};

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

function defaultFocusGraphAppearance(
  base: GraphLayoutOptions,
): GraphLayoutOptions {
  return {
    ...base,
    xMetric: "citation-sequence",
    xScale: "linear",
  };
}

export function getFocusGraphAppearance(
  base: GraphLayoutOptions,
): GraphLayoutOptions {
  const fallback = defaultFocusGraphAppearance(base);
  const version = Number(
    Zotero.Prefs.get(key("focusGraphAppearanceVersion"), true),
  );
  const raw = String(Zotero.Prefs.get(key("focusGraphAppearance"), true) ?? "");
  if (version !== FOCUS_GRAPH_APPEARANCE_SCHEMA_VERSION) {
    setFocusGraphAppearance(fallback);
    return fallback;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<GraphLayoutOptions>;
    return {
      ...fallback,
      ...parsed,
      xScale:
        parsed.xMetric === "citation-sequence"
          ? "linear"
          : (parsed.xScale ?? fallback.xScale),
      yScale:
        parsed.yMetric === "citation-sequence"
          ? "linear"
          : (parsed.yScale ?? fallback.yScale),
    };
  } catch {
    setFocusGraphAppearance(fallback);
    return fallback;
  }
}

export function setFocusGraphAppearance(options: GraphLayoutOptions): void {
  const normalized = {
    ...options,
    xScale: options.xMetric === "citation-sequence" ? "linear" : options.xScale,
    yScale: options.yMetric === "citation-sequence" ? "linear" : options.yScale,
  };
  Zotero.Prefs.set(
    key("focusGraphAppearance"),
    JSON.stringify(normalized),
    true,
  );
  Zotero.Prefs.set(
    key("focusGraphAppearanceVersion"),
    FOCUS_GRAPH_APPEARANCE_SCHEMA_VERSION,
    true,
  );
}

export function resetFocusGraphAppearance(
  base: GraphLayoutOptions,
): GraphLayoutOptions {
  const reset = defaultFocusGraphAppearance(base);
  setFocusGraphAppearance(reset);
  return reset;
}
