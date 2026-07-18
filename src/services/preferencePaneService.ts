import { config } from "../../package.json";
import { getAutomaticUpdatesEnabled } from "./citationPreferences";
import { scheduleAutomaticLibraryUpdate } from "./citationUpdateService";

const AUTOMATIC_PREF = `${config.prefsPrefix}.automaticUpdates`;
const PROVIDER_PREF = `${config.prefsPrefix}.provider`;

let registered = false;
let automaticObserverID: symbol | null = null;
let providerObserverID: symbol | null = null;

export async function registerCitationMapPreferencePane(): Promise<void> {
  if (registered) {
    return;
  }

  await Zotero.PreferencePanes.register({
    pluginID: config.addonID,
    src: rootURI + "content/preferences.xhtml",
    label: config.addonName,
    image: `chrome://${config.addonRef}/content/icons/network.svg`,
  });

  automaticObserverID = Zotero.Prefs.registerObserver(
    AUTOMATIC_PREF,
    () => {
      if (getAutomaticUpdatesEnabled()) {
        scheduleAutomaticLibraryUpdate(500);
      }
    },
    true,
  );

  providerObserverID = Zotero.Prefs.registerObserver(
    PROVIDER_PREF,
    () => {
      if (getAutomaticUpdatesEnabled()) {
        scheduleAutomaticLibraryUpdate(500);
      }
    },
    true,
  );

  registered = true;
}

export function unregisterCitationMapPreferenceObservers(): void {
  if (automaticObserverID) {
    Zotero.Prefs.unregisterObserver(automaticObserverID);
    automaticObserverID = null;
  }

  if (providerObserverID) {
    Zotero.Prefs.unregisterObserver(providerObserverID);
    providerObserverID = null;
  }

  registered = false;
}
