import { config } from "../package.json";
import Addon from "./addon";

if (!(Zotero as any)[config.addonInstance]) {
  const instance = new Addon();
  _globalThis.addon = instance;
  (Zotero as any)[config.addonInstance] = instance;
}
