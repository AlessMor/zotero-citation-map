import { config } from "../../package.json";
import type {
  CitationProviderID,
  CitationProviderPreference,
} from "../domain/citationTypes";
import type { GraphLayoutOptions } from "../domain/graphTypes";

const key = (name: string): string => `${config.prefsPrefix}.${name}`;
const PROVIDER_LABELS: Record<CitationProviderPreference, string> = {
  auto: "Automatic — Crossref preferred",
  crossref: "Crossref",
  "semantic-scholar": "Semantic Scholar",
  opencitations: "OpenCitations",
  inspire: "INSPIRE-HEP",
  openalex: "OpenAlex (opportunistic public access)",
};
const CONCRETE = new Set<CitationProviderID>([
  "crossref",
  "semantic-scholar",
  "opencitations",
  "inspire",
  "openalex",
]);

function boolPref(name: string, fallback: boolean): boolean {
  const value = Zotero.Prefs.get(key(name), true);
  return value === undefined || value === null ? fallback : Boolean(value);
}

export function getProviderLabel(provider: CitationProviderPreference): string {
  return PROVIDER_LABELS[provider];
}

export function getProviderPreference(): CitationProviderPreference {
  const value = String(Zotero.Prefs.get(key("provider"), true) ?? "auto");
  return value === "auto" || CONCRETE.has(value as CitationProviderID)
    ? (value as CitationProviderPreference)
    : "auto";
}

export function setProviderPreference(
  provider: CitationProviderPreference,
): void {
  Zotero.Prefs.set(key("provider"), provider, true);
}

export function getAutomaticUpdatesEnabled(): boolean {
  return boolPref("automaticUpdates", true);
}
export function setAutomaticUpdatesEnabled(enabled: boolean): void {
  Zotero.Prefs.set(key("automaticUpdates"), enabled, true);
}

export function getUpdateNewItemsEnabled(): boolean {
  return boolPref("updateNewItems", true);
}
export function setUpdateNewItemsEnabled(enabled: boolean): void {
  Zotero.Prefs.set(key("updateNewItems"), enabled, true);
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

export function getLocalRelationsEnabled(): boolean {
  return boolPref("localRelations", true);
}
export function getNoteExtractionEnabled(): boolean {
  return boolPref("noteExtraction", false);
}
export function getPDFExtractionEnabled(): boolean {
  return boolPref("pdfExtraction", false);
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

const GRAPH_APPEARANCE_SCHEMA_VERSION = 3;

const DEFAULT_GRAPH_LAYOUT: GraphLayoutOptions = {
  xMetric: "year",
  xScale: "linear",
  yMetric: "citations",
  yScale: "linear",
  nodeSizeMetric: "citations",
  nodeColorMetric: "collection",
  nodeLabelMode: "title",
};

export function getGraphAppearance(): GraphLayoutOptions {
  const storedVersion = Number(
    Zotero.Prefs.get(key("graphAppearanceVersion"), true),
  );
  if (storedVersion !== GRAPH_APPEARANCE_SCHEMA_VERSION) {
    setGraphAppearance(DEFAULT_GRAPH_LAYOUT);
    return { ...DEFAULT_GRAPH_LAYOUT };
  }

  const raw = String(Zotero.Prefs.get(key("graphAppearance"), true) ?? "");
  try {
    const parsed = JSON.parse(raw) as Partial<GraphLayoutOptions>;
    return { ...DEFAULT_GRAPH_LAYOUT, ...parsed };
  } catch {
    return { ...DEFAULT_GRAPH_LAYOUT };
  }
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
