import { config } from "../package.json";
import hooks from "./hooks";
import { createZToolkit } from "./utils/ztoolkit";

class Addon {
  public data: {
    alive: boolean;
    config: typeof config;
    env: "development" | "production";
    initialized: boolean;
    ztoolkit: ZToolkit;

    /** Zotero tab containing Citation Map. */
    graphTabID: string | null;

    /** Optional detached Citation Map window. */
    graphWindow: Window | null;

    locale?: {
      current: any;
    };
  };

  public hooks: typeof hooks;

  public api: Record<string, unknown>;

  constructor() {
    this.data = {
      alive: true,
      config,
      env: __env__,
      initialized: false,
      ztoolkit: createZToolkit(),
      graphTabID: null,
      graphWindow: null,
    };

    this.hooks = hooks;
    this.api = {};
  }
}

export default Addon;
