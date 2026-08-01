export type CitationMapViewKind = "map" | "focus";

export interface CitationMapInstanceDescriptor {
  instanceID: string;
  tabID: string | null;
  lastActivatedAt: number;
}

export interface ZoteroTabDescriptor {
  id?: string | null;
  type?: string | null;
}

/** Only real Citation Map tabs may be promoted into the view-instance registry. */
export function isCitationMapTabDescriptor(
  tab: ZoteroTabDescriptor | null | undefined,
): boolean {
  if (!tab || tab.id === "zotero-pane") return false;
  return String(tab.type ?? "").replace(/-unloaded$/, "") === "citationmap";
}

export function citationMapViewBaseTitle(kind: CitationMapViewKind): string {
  return kind === "focus" ? "Focus View" : "Citation Map";
}

/**
 * Return a stable, human-readable default title without reusing an existing
 * title. The first view keeps the unnumbered base name; later views use 2, 3,
 * and so on.
 */
export function nextCitationMapViewTitle(
  kind: CitationMapViewKind,
  existingTitles: readonly string[],
): string {
  const base = citationMapViewBaseTitle(kind);
  const occupied = new Set(existingTitles.map((title) => title.trim()));
  if (!occupied.has(base)) return base;
  let suffix = 2;
  while (occupied.has(`${base} ${suffix}`)) suffix += 1;
  return `${base} ${suffix}`;
}

/**
 * Route ordinary commands to the selected Citation Map when possible,
 * otherwise to the most recently activated live instance.
 */
export function selectReusableCitationMapInstance<
  T extends CitationMapInstanceDescriptor,
>(instances: readonly T[], selectedTabID: string | null | undefined): T | null {
  if (selectedTabID) {
    const selected = instances.find(
      (instance) => instance.tabID === selectedTabID,
    );
    if (selected) return selected;
  }
  return (
    [...instances].sort(
      (left, right) => right.lastActivatedAt - left.lastActivatedAt,
    )[0] ?? null
  );
}

/** Hidden tabs keep shared data current but defer expensive canvas rebuilds. */
export function citationMapInstanceShouldRender(
  hasDetachedWindow: boolean,
  isSelectedTab: boolean,
): boolean {
  return hasDetachedWindow || isSelectedTab;
}
