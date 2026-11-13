import { config } from "../../package.json";

export type ProviderCredential =
  "openAlexAPIKey" | "semanticScholarAPIKey" | "nasaADSAPIKey";

interface CredentialLoginManager {
  initializationPromise: Promise<void>;
  searchLoginsAsync(query: {
    origin: string;
    httpRealm: string;
  }): Promise<nsILoginInfo[]>;
  addLoginAsync(login: nsILoginInfo): Promise<unknown>;
  removeLoginAsync?: (login: nsILoginInfo) => Promise<void>;
  modifyLoginAsync?: (
    previous: nsILoginInfo,
    login: nsILoginInfo,
  ) => Promise<void>;
  removeLogin?: (login: nsILoginInfo) => void;
  modifyLogin?: (previous: nsILoginInfo, login: nsILoginInfo) => void;
}

interface CredentialLoginManager {
  initializationPromise: Promise<void>;
  searchLoginsAsync(query: {
    origin: string;
    httpRealm: string;
  }): Promise<nsILoginInfo[]>;
  addLoginAsync(login: nsILoginInfo): Promise<unknown>;
  removeLoginAsync?: (login: nsILoginInfo) => Promise<void>;
  modifyLoginAsync?: (
    previous: nsILoginInfo,
    login: nsILoginInfo,
  ) => Promise<void>;
  removeLogin?: (login: nsILoginInfo) => void;
  modifyLogin?: (previous: nsILoginInfo, login: nsILoginInfo) => void;
}

interface CredentialLogin extends nsILoginInfo {
  init(
    origin: string,
    actionOrigin: string | null,
    realm: string | null,
    username: string,
    password: string,
    usernameField: string,
    passwordField: string,
  ): void;
}

const CREDENTIAL_NAMES: readonly ProviderCredential[] = [
  "openAlexAPIKey",
  "semanticScholarAPIKey",
  "nasaADSAPIKey",
];
const CREDENTIAL_ORIGIN = "chrome://citationmap";
const CREDENTIAL_REALM = "Citation Map provider API credentials";
const credentials = new Map<ProviderCredential, string>();

function loginManager(): CredentialLoginManager {
  return Components.classes["@mozilla.org/login-manager;1"].getService(
    Components.interfaces.nsILoginManager,
  ) as CredentialLoginManager;
}

function credentialName(value: string): ProviderCredential {
  const name = CREDENTIAL_NAMES.find((entry) => entry === value);
  if (!name) throw new TypeError("Unknown Citation Map provider credential");
  return name;
}

async function storedLogin(
  name: ProviderCredential,
): Promise<nsILoginInfo | null> {
  const logins: nsILoginInfo[] = await loginManager().searchLoginsAsync({
    origin: CREDENTIAL_ORIGIN,
    httpRealm: CREDENTIAL_REALM,
  });
  const matches = logins.filter((login) => login.username === name);
  if (matches.length > 1)
    throw new Error(`Duplicate stored credential: ${name}`);
  return matches[0] ?? null;
}

export function getProviderCredential(name: ProviderCredential): string {
  return credentials.get(name) ?? "";
}

export async function saveProviderCredential(
  name: string,
  value: string,
): Promise<void> {
  const validatedName = credentialName(name);
  const password = value.trim();
  const previous = await storedLogin(validatedName);
  if (!password) {
    if (previous) {
      const manager = loginManager();
      if (manager.removeLoginAsync) await manager.removeLoginAsync(previous);
      else if (manager.removeLogin) manager.removeLogin(previous);
      else
        throw new TypeError(
          "Zotero login manager does not support removing credentials",
        );
    }
  } else {
    const login = Components.classes[
      "@mozilla.org/login-manager/loginInfo;1"
    ].createInstance(Components.interfaces.nsILoginInfo) as CredentialLogin;
    login.init(
      CREDENTIAL_ORIGIN,
      null,
      CREDENTIAL_REALM,
      validatedName,
      password,
      "",
      "",
    );
    if (previous) {
      const manager = loginManager();
      if (manager.modifyLoginAsync)
        await manager.modifyLoginAsync(previous, login);
      else if (manager.modifyLogin) manager.modifyLogin(previous, login);
      else
        throw new TypeError(
          "Zotero login manager does not support updating credentials",
        );
    } else await loginManager().addLoginAsync(login);
  }
  credentials.set(validatedName, password);
}

/** Remove legacy plaintext preferences only after secure storage succeeds. */
export async function initializeProviderCredentials(): Promise<void> {
  await loginManager().initializationPromise;
  for (const name of CREDENTIAL_NAMES) {
    const legacyKey = `${config.prefsPrefix}.${name}`;
    const legacy = String(Zotero.Prefs.get(legacyKey, true) ?? "").trim();
    const existing = await storedLogin(name);
    if (legacy && !existing) await saveProviderCredential(name, legacy);
    else credentials.set(name, existing?.password ?? "");
    if (legacy) Zotero.Prefs.clear(legacyKey, true);
  }
}

export function providerCredentialIsConfigured(name: string): boolean {
  return Boolean(getProviderCredential(credentialName(name)));
}
