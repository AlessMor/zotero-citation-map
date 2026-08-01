/* global clearTimeout, document, setTimeout, Zotero */

(() => {
  const PREF_PREFIX = "extensions.zotero.citationmap.";
  let initialized = false;
  let notificationTimer = null;

  const byID = (id) => document.getElementById(id);
  const providerParent = () => byID("zotero-prefpane-citationmap-provider-all");
  const providerInputs = () =>
    Array.from(document.querySelectorAll("input[data-provider-pref]"));
  const providerChildren = () =>
    document.querySelector(".citation-map-provider-children");
  const updateParent = () =>
    byID("zotero-prefpane-citationmap-automatic-updates");
  const updateInputs = () =>
    Array.from(document.querySelectorAll("input[data-update-pref]"));
  const updateChildren = () =>
    document.querySelector(".citation-map-pref-children");
  const libraryList = () =>
    byID("zotero-prefpane-citationmap-update-library-list");
  const libraryStatus = () =>
    byID("zotero-prefpane-citationmap-update-library-status");
  const librarySelectAll = () =>
    byID("zotero-prefpane-citationmap-update-select-all");
  const libraryClearAll = () =>
    byID("zotero-prefpane-citationmap-update-clear-all");
  const libraryInputs = () =>
    Array.from(document.querySelectorAll("input[data-update-library-id]"));
  const refreshSelectedButton = () =>
    byID("zotero-prefpane-citationmap-refresh-selected");

  function prefKey(name) {
    return PREF_PREFIX + name;
  }

  function readBoolean(name, fallback = true) {
    const value = Zotero.Prefs.get(prefKey(name), true);
    return value === undefined || value === null ? fallback : Boolean(value);
  }

  function writeBoolean(name, value) {
    Zotero.Prefs.set(prefKey(name), Boolean(value), true);
  }

  function inputPreference(input, attribute) {
    return input.getAttribute(attribute) || "";
  }

  function writeInputState(input, attribute) {
    const name = inputPreference(input, attribute);
    if (name) writeBoolean(name, input.checked);
  }

  function setInputStates(inputs, attribute, checked) {
    for (const input of inputs) {
      input.checked = checked;
      writeInputState(input, attribute);
    }
  }

  function notifyProviderChange() {
    if (notificationTimer !== null) clearTimeout(notificationTimer);
    notificationTimer = setTimeout(() => {
      notificationTimer = null;
      Zotero.CitationMap.api.providerSelectionChanged();
    }, 0);
  }

  function updateProviderStatus(inputs, automatic) {
    const status = byID("zotero-prefpane-citationmap-provider-status");
    if (!status) return;
    const selected = inputs.filter((input) => input.checked).length;
    status.textContent = automatic
      ? `Automatic selection: all ${inputs.length} providers enabled.`
      : `Custom selection: ${selected} of ${inputs.length} providers enabled.`;
  }

  function renderProviderMode() {
    const parent = providerParent();
    const inputs = providerInputs();
    if (!parent || !inputs.length) return;

    const automatic = readBoolean("providerAutomatic", true);
    parent.checked = automatic;
    parent.indeterminate = false;

    if (automatic) {
      setInputStates(inputs, "data-provider-pref", true);
    } else {
      for (const input of inputs) {
        input.checked = readBoolean(
          inputPreference(input, "data-provider-pref"),
          true,
        );
      }
      if (!inputs.some((input) => input.checked)) {
        inputs[0].checked = true;
        writeInputState(inputs[0], "data-provider-pref");
      }
    }

    for (const input of inputs) input.disabled = automatic;
    providerChildren()?.classList.toggle(
      "citation-map-options-locked",
      automatic,
    );
    updateProviderStatus(inputs, automatic);
  }

  function handleProviderParentChange() {
    const parent = providerParent();
    const inputs = providerInputs();
    if (!parent || !inputs.length) return;

    const automatic = parent.checked;
    writeBoolean("providerAutomatic", automatic);
    if (automatic) setInputStates(inputs, "data-provider-pref", true);
    renderProviderMode();
    notifyProviderChange();
  }

  function handleProviderChildChange(input) {
    if (readBoolean("providerAutomatic", true)) {
      renderProviderMode();
      return;
    }

    const inputs = providerInputs();
    if (!inputs.some((candidate) => candidate.checked)) {
      input.checked = true;
    }
    writeInputState(input, "data-provider-pref");
    updateProviderStatus(inputs, false);
    notifyProviderChange();
  }

  function selectedUpdateLibraryIDs() {
    return libraryInputs()
      .filter((input) => input.checked)
      .map((input) => Number(input.getAttribute("data-update-library-id")))
      .filter((libraryID) => Number.isInteger(libraryID) && libraryID > 0);
  }

  function updateLibraryStatus() {
    const status = libraryStatus();
    if (!status) return;
    const inputs = libraryInputs();
    const selected = inputs.filter((input) => input.checked).length;
    if (!inputs.length) {
      status.textContent = "No compatible Zotero libraries are available.";
    } else if (!selected) {
      status.textContent = "No libraries selected.";
    } else {
      status.textContent = `${selected} of ${inputs.length} libraries selected.`;
    }
    const refresh = refreshSelectedButton();
    if (refresh) refresh.disabled = selected === 0;
  }

  function saveUpdateLibrarySelection() {
    Zotero.CitationMap.api.setUpdateLibraryIDs(selectedUpdateLibraryIDs());
    updateLibraryStatus();
  }

  function renderUpdateLibraries() {
    const list = libraryList();
    if (!list) return;
    const libraries = Zotero.CitationMap.api.updateLibraries();
    const selected = new Set(Zotero.CitationMap.api.updateLibraryIDs());
    list.replaceChildren();

    for (const library of libraries) {
      const label = document.createElement("label");
      label.className = "citation-map-update-library-option";

      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = selected.has(Number(library.libraryID));
      input.setAttribute("data-update-library-id", String(library.libraryID));
      input.addEventListener("change", saveUpdateLibrarySelection);

      const name = document.createElement("span");
      name.textContent = String(library.name || `Library ${library.libraryID}`);

      const kind = document.createElement("small");
      kind.textContent = library.isUserLibrary ? "My Library" : "Group library";

      label.append(input, name, kind);
      list.appendChild(label);
    }

    updateLibraryStatus();
  }

  function setAllUpdateLibraries(checked) {
    for (const input of libraryInputs()) input.checked = checked;
    saveUpdateLibrarySelection();
  }

  function renderUpdateMode() {
    const parent = updateParent();
    const inputs = updateInputs();
    if (!parent || !inputs.length) return;

    const automatic = readBoolean("automaticUpdates", true);
    parent.checked = automatic;
    parent.indeterminate = false;

    if (automatic) {
      setInputStates(inputs, "data-update-pref", true);
    } else {
      for (const input of inputs) {
        input.checked = readBoolean(
          inputPreference(input, "data-update-pref"),
          true,
        );
      }
    }

    for (const input of inputs) input.disabled = automatic;
    updateChildren()?.classList.toggle(
      "citation-map-options-locked",
      automatic,
    );
  }

  function handleUpdateParentChange() {
    const parent = updateParent();
    const inputs = updateInputs();
    if (!parent || !inputs.length) return;

    const automatic = parent.checked;
    writeBoolean("automaticUpdates", automatic);
    if (automatic) setInputStates(inputs, "data-update-pref", true);
    renderUpdateMode();
  }

  function handleUpdateChildChange(input) {
    if (readBoolean("automaticUpdates", true)) {
      renderUpdateMode();
      return;
    }
    writeInputState(input, "data-update-pref");
  }

  function bindControls() {
    const parent = providerParent();
    const providers = providerInputs();
    const updateMode = updateParent();
    const updates = updateInputs();
    const list = libraryList();
    const selectAll = librarySelectAll();
    const clearAll = libraryClearAll();
    const api = Zotero.CitationMap?.api;
    if (
      !parent ||
      !providers.length ||
      !updateMode ||
      !updates.length ||
      !list ||
      !selectAll ||
      !clearAll ||
      typeof api?.updateLibraries !== "function" ||
      typeof api?.updateLibraryIDs !== "function" ||
      typeof api?.setUpdateLibraryIDs !== "function"
    ) {
      return false;
    }

    parent.addEventListener("change", handleProviderParentChange);
    for (const input of providers) {
      input.addEventListener("change", () => handleProviderChildChange(input));
    }

    updateMode.addEventListener("change", handleUpdateParentChange);
    for (const input of updates) {
      input.addEventListener("change", () => handleUpdateChildChange(input));
    }

    selectAll.addEventListener("click", () => setAllUpdateLibraries(true));
    clearAll.addEventListener("click", () => setAllUpdateLibraries(false));

    renderProviderMode();
    renderUpdateLibraries();
    renderUpdateMode();
    return true;
  }

  function initialize(attempt = 0) {
    if (initialized) return;
    if (!bindControls()) {
      if (attempt < 40) setTimeout(() => initialize(attempt + 1), 50);
      return;
    }
    initialized = true;
  }

  initialize();
})();
