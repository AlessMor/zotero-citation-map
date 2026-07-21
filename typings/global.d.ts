declare const Zotero: any;
declare namespace Zotero {
  type Item = any;
}
declare namespace _ZoteroTypes {
  type DBConnection = any;
  type MainWindow = any;
  interface Prefs {
    PluginPrefsMap: Record<string, string | number | boolean>;
  }
}
declare const addon: import("../src/addon").default;
declare const rootURI: string;
declare const _globalThis: any;
declare const __env__: "development" | "production";
declare const Localization: any;

declare const Components: any;
