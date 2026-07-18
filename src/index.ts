import { config } from "../package.json";
import Addon from "./addon";

// Citation Map no longer needs zotero-plugin-toolkit at runtime. Creating the
// toolkit initialized deprecated Gecko compatibility modules even though the
// plugin did not use them, producing ChromeUtils.import() warnings.
if (!(Zotero as any)[config.addonInstance]) {
  const instance = new Addon();
  _globalThis.addon = instance;
  (Zotero as any)[config.addonInstance] = instance;
}
