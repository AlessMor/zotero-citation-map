import { config } from "../package.json";
import hooks from "./hooks";

class Addon {
  public data: {
    alive: boolean;
    config: typeof config;
    env: "development" | "production";
    initialized: boolean;
    graphTabID: string | null;
    graphWindow: Window | null;
    locale?: { current: any };
  };

  public hooks: typeof hooks;
  public api: Record<string, any>;

  constructor() {
    this.data = {
      alive: true,
      config,
      env: __env__,
      initialized: false,
      graphTabID: null,
      graphWindow: null,
    };
    this.hooks = hooks;
    this.api = {};
  }
}

export default Addon;
