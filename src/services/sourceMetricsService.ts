import type { SourceMetrics, WorkIdentifiers } from "../domain/citationTypes";
import type {
  CitationGraphNode,
  GraphLayoutOptions,
  GraphNodeColorMetric,
  GraphNodeSizeMetric,
} from "../domain/graphTypes";
import { requestJSON } from "../providers/http";
import { getCitationProvider, getProviderPlan } from "../providers/registry";
import { normalizeDOI, normalizeExactTitle } from "./citationIdentifiers";
import {
  getCitationMetricRecord,
  saveCitationMetricRecord,
} from "./citationMetricsStore";
import {
  getOpenAlexAPIKey,
  getProviderPreference,
} from "./citationPreferences";

const SOURCE_METRIC_IDS = new Set<string>([
  "two-year-mean-citedness",
  "journal-h-index",
  "journal-i10-index",
]);
const RETRY_DELAY_MS = 30 * 1000;
const lastAttemptByItem = new Map<string, number>();
const activeByItem = new Map<string, Promise<boolean>>();

interface OpenAlexSource {
  id?: string;
  display_name?: string;
  issn_l?: string | null;
  issn?: string[] | null;
  summary_stats?: {
    "2yr_mean_citedness"?: number | null;
    h_index?: number | null;
    i10_index?: number | null;
  } | null;
}

interface OpenAlexSourceList {
  results?: OpenAlexSource[];
}

interface OpenAlexWorkSource {
  primary_location?: { source?: OpenAlexSource | null } | null;
  locations?: Array<{ source?: OpenAlexSource | null }> | null;
}

function openAlexURL(
  path: string,
  parameters: Record<string, string | number> = {},
): string {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`https://api.openalex.org${normalizedPath}`);
  for (const [name, value] of Object.entries(parameters)) {
    url.searchParams.set(name, String(value));
  }
  const apiKey = getOpenAlexAPIKey();
  if (apiKey) url.searchParams.set("api_key", apiKey);
  return url.toString();
}

function finiteNonNegative(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function sourceID(value: unknown): string | null {
  const text = String(value ?? "").trim();
  if (!text) return null;
  return text.replace(/^https:\/\/openalex\.org\//i, "");
}

function metricsFromSource(
  source: OpenAlexSource | null,
): SourceMetrics | null {
  const id = sourceID(source?.id);
  const metrics: SourceMetrics = {
    sourceID: id,
    sourceTitle: String(source?.display_name ?? "").trim() || null,
    twoYearMeanCitedness: finiteNonNegative(
      source?.summary_stats?.["2yr_mean_citedness"],
    ),
    hIndex: finiteNonNegative(source?.summary_stats?.h_index),
    i10Index: finiteNonNegative(source?.summary_stats?.i10_index),
    updatedAt: new Date().toISOString(),
  };
  return metrics.twoYearMeanCitedness !== null ||
    metrics.hIndex !== null ||
    metrics.i10Index !== null
    ? metrics
    : null;
}

function hasSourceMetric(metrics: SourceMetrics | null | undefined): boolean {
  return Boolean(
    metrics &&
    (metrics.twoYearMeanCitedness !== null ||
      metrics.hIndex !== null ||
      metrics.i10Index !== null),
  );
}

function usesSourceMetric(
  metric: string | GraphNodeColorMetric | GraphNodeSizeMetric,
): boolean {
  return SOURCE_METRIC_IDS.has(metric);
}

export function graphLayoutUsesSourceMetrics(
  layout: GraphLayoutOptions,
): boolean {
  return (
    usesSourceMetric(layout.xMetric) ||
    usesSourceMetric(layout.yMetric) ||
    usesSourceMetric(layout.nodeSizeMetric) ||
    usesSourceMetric(layout.nodeColorMetric)
  );
}

function identifiersForNode(node: CitationGraphNode): WorkIdentifiers {
  return {
    doi: node.doi,
    pmid: null,
    arxiv: null,
    isbn: null,
    title: node.title,
    normalizedTitle: normalizeExactTitle(node.title),
    year: node.year,
    authors: node.authors,
    sourceTitle: node.sourceTitle,
  };
}

function itemIdentity(node: CitationGraphNode, libraryID: number): string {
  return `${libraryID}:${node.itemKey}`;
}

function itemISSNs(item: Zotero.Item): string[] {
  const raw = String(item.getField?.("ISSN") ?? "");
  const matches = raw.match(/\b\d{4}-?\d{3}[\dXx]\b/g) ?? [];
  return [...new Set(matches.map((value) => value.toUpperCase()))];
}

function itemSourceTitle(item: Zotero.Item, node: CitationGraphNode): string {
  return String(
    node.sourceTitle ??
      item.getField?.("publicationTitle") ??
      item.getField?.("conferenceName") ??
      item.getField?.("publisher") ??
      "",
  ).trim();
}

async function sourceMetricsBySourceID(
  id: string,
): Promise<SourceMetrics | null> {
  const normalizedID = sourceID(id);
  if (!normalizedID) return null;
  const response = await requestJSON<OpenAlexSource>(
    "openalex",
    openAlexURL(`/sources/${encodeURIComponent(normalizedID)}`, {
      select: "id,display_name,issn_l,issn,summary_stats",
    }),
  );
  return response.ok ? metricsFromSource(response.data) : null;
}

async function sourceMetricsByISSN(
  issn: string,
): Promise<SourceMetrics | null> {
  const compact = issn.replace(/[^0-9Xx]/g, "").toUpperCase();
  if (compact.length !== 8) return null;
  const formatted = `${compact.slice(0, 4)}-${compact.slice(4)}`;
  const response = await requestJSON<OpenAlexSourceList>(
    "openalex",
    openAlexURL("/sources", {
      filter: `issn:${formatted}`,
      per_page: 5,
      select: "id,display_name,issn_l,issn,summary_stats",
    }),
  );
  if (!response.ok || !response.data) return null;
  const candidate = (response.data.results ?? [])[0] ?? null;
  const direct = metricsFromSource(candidate);
  if (direct) return direct;
  return candidate?.id ? sourceMetricsBySourceID(candidate.id) : null;
}

async function sourceMetricsByTitle(
  title: string,
): Promise<SourceMetrics | null> {
  const normalized = normalizeExactTitle(title);
  if (!normalized) return null;
  const response = await requestJSON<OpenAlexSourceList>(
    "openalex",
    openAlexURL("/sources", {
      search: title,
      per_page: 20,
      select: "id,display_name,issn_l,issn,summary_stats",
    }),
  );
  if (!response.ok || !response.data) return null;
  const candidates = response.data.results ?? [];
  const exact = candidates.find(
    (candidate) => normalizeExactTitle(candidate.display_name) === normalized,
  );
  const candidate = exact ?? (candidates.length === 1 ? candidates[0] : null);
  const direct = metricsFromSource(candidate);
  if (direct) return direct;
  return candidate?.id ? sourceMetricsBySourceID(candidate.id) : null;
}

async function sourceMetricsByDOI(doi: string): Promise<SourceMetrics | null> {
  const normalized = normalizeDOI(doi);
  if (!normalized) return null;
  const response = await requestJSON<OpenAlexWorkSource>(
    "openalex",
    openAlexURL(`/works/${encodeURIComponent(`doi:${normalized}`)}`, {
      select: "primary_location,locations",
    }),
  );
  if (!response.ok || !response.data) return null;
  const sources = [
    response.data.primary_location?.source ?? null,
    ...(response.data.locations ?? []).map(
      (location) => location.source ?? null,
    ),
  ].filter((source): source is OpenAlexSource => Boolean(source?.id));
  for (const source of sources) {
    const direct = metricsFromSource(source);
    if (direct) return direct;
    const fetched = await sourceMetricsBySourceID(source.id!);
    if (fetched) return fetched;
  }
  return null;
}

async function sourceMetricsForItem(
  item: Zotero.Item,
  node: CitationGraphNode,
  knownSourceID?: string | null,
): Promise<SourceMetrics | null> {
  if (knownSourceID) {
    const known = await sourceMetricsBySourceID(knownSourceID);
    if (known) return known;
  }
  for (const issn of itemISSNs(item)) {
    const metrics = await sourceMetricsByISSN(issn);
    if (metrics) return metrics;
  }
  const doi = normalizeDOI(node.doi ?? item.getField?.("DOI"));
  if (doi) {
    const metrics = await sourceMetricsByDOI(doi);
    if (metrics) return metrics;
  }
  const title = itemSourceTitle(item, node);
  return title ? sourceMetricsByTitle(title) : null;
}

async function sourceMetricsFromWork(
  node: CitationGraphNode,
): Promise<SourceMetrics | null> {
  const provider = getCitationProvider("openalex");
  const identifiers = identifiersForNode(node);
  let result = provider.supports(identifiers)
    ? await provider.lookup(identifiers)
    : null;
  if (
    (!result || result.status !== "success") &&
    provider.searchExactTitle &&
    identifiers.normalizedTitle
  ) {
    result = await provider.searchExactTitle(identifiers);
  }
  return result?.status === "success" ? (result.sourceMetrics ?? null) : null;
}

async function enrichNode(node: CitationGraphNode): Promise<boolean> {
  if (hasSourceMetric(node.sourceMetrics)) return false;
  const item = Zotero.Items.get(node.itemID) as Zotero.Item | null;
  const libraryID = Number(item?.libraryID);
  if (!item || !Number.isFinite(libraryID)) return false;
  const record = getCitationMetricRecord(libraryID, node.itemKey);
  if (!record) return false;
  if (hasSourceMetric(record.sourceMetrics)) {
    node.sourceMetrics = record.sourceMetrics;
    return true;
  }

  const identity = itemIdentity(node, libraryID);
  const active = activeByItem.get(identity);
  if (active) return active;
  const lastAttempt = lastAttemptByItem.get(identity) ?? 0;
  if (Date.now() - lastAttempt < RETRY_DELAY_MS) return false;
  lastAttemptByItem.set(identity, Date.now());

  const operation = (async (): Promise<boolean> => {
    try {
      const metrics =
        (await sourceMetricsForItem(
          item,
          node,
          record.sourceMetrics?.sourceID ?? null,
        )) ?? (await sourceMetricsFromWork(node));
      if (!hasSourceMetric(metrics)) return false;
      const current = getCitationMetricRecord(libraryID, node.itemKey);
      if (!current) return false;
      await saveCitationMetricRecord({
        ...current,
        sourceTitle:
          current.sourceTitle ?? metrics?.sourceTitle ?? node.sourceTitle,
        sourceMetrics: metrics,
      });
      node.sourceMetrics = metrics;
      return true;
    } catch (error) {
      Zotero.debug(
        "Citation Map: source-metric enrichment failed for " +
          `${node.itemKey}: ${String(error)}`,
      );
      return false;
    }
  })().finally(() => activeByItem.delete(identity));
  activeByItem.set(identity, operation);
  return operation;
}

export async function ensureSourceMetricsForNodes(
  nodes: CitationGraphNode[],
  onUpdate?: (updated: number, total: number) => void,
): Promise<number> {
  const preference = getProviderPreference();
  const plan = getProviderPlan("source-metrics", preference);
  if (!plan.providers.includes("openalex") || !getOpenAlexAPIKey()) return 0;

  const missing = nodes.filter((node) => !hasSourceMetric(node.sourceMetrics));
  let updated = 0;
  for (const node of missing) {
    if (await enrichNode(node)) {
      updated += 1;
      onUpdate?.(updated, missing.length);
    }
  }
  return updated;
}
