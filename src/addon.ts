import { config } from "../package.json";
import type { CitationLibraryOption } from "./services/citationLibraryService";
import hooks from "./hooks";

export interface CitationMapCacheStatus {
  metricRecords: number;
  manualRelations: number;
  ignoredRelations: number;
  lastUpdated: string | null;
}

export interface CitationMapAPI {
  refreshAll(): void;
  clearAllCachedData(): void;
  providerSelectionChanged(): void;
  openOpenAlexAccount(): void;
  cacheStatus(): CitationMapCacheStatus;
  updateLibraries(): CitationLibraryOption[];
  updateLibraryIDs(): number[];
  setUpdateLibraryIDs(libraryIDs: unknown): void;
}

function unavailableAPI(): CitationMapAPI {
  const unavailable = (): never => {
    throw new Error("Citation Map API is not initialized.");
  };
  return Object.freeze({
    refreshAll: unavailable,
    clearAllCachedData: unavailable,
    providerSelectionChanged: unavailable,
    openOpenAlexAccount: unavailable,
    cacheStatus: unavailable,
    updateLibraries: unavailable,
    updateLibraryIDs: unavailable,
    setUpdateLibraryIDs: unavailable,
  });
}

class Addon {
  public data: {
    alive: boolean;
    config: typeof config;
    env: "development" | "production";
    initialized: boolean;
    locale?: { current: any };
  };

  public hooks: typeof hooks;
  public api: CitationMapAPI;

  constructor() {
    this.data = {
      alive: true,
      config,
      env: __env__,
      initialized: false,
    };
    this.hooks = hooks;
    this.api = unavailableAPI();
  }

  public setAPI(api: CitationMapAPI): void {
    this.api = Object.freeze({ ...api });
  }
}

export default Addon;
