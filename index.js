const MODULE_NAME = "userPresetCustom";
const CHAT_STATE_KEY = "userPresetCustom";
const SCHEMA_VERSION = 8;
const BUTTON_ID = "prompt_controls_button";
const PANEL_ID = "prompt_controls_runtime_panel";
const SETTINGS_ID = "prompt_controls_settings";
const SETTINGS_ANCHOR_ID = "completion_prompt_manager";
const VARIABLE_TYPE_ORDER = ["dropdown", "single", "multi", "toggle", "input"];
const PROMPT_TYPE_ORDER = ["dropdown", "single", "multi", "group"];
const VARIABLE_TYPES = new Set(VARIABLE_TYPE_ORDER);
const PROMPT_TYPES = new Set(PROMPT_TYPE_ORDER);
const THEME_STORAGE_KEY = "promptControlsCustomTheme";
const THEME_MAP_STORAGE_KEY = "promptControlsCustomThemeByStTheme";
const THEME_BODY_CLASS = "sb-theme-dark";
const DEFAULT_ST_THEME_KEY = "__default__";
const MACRO_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const FORCE_TOGGLE_MARKERS = new Set([
    "charDescription",
    "charPersonality",
    "scenario",
    "personaDescription",
    "worldInfoBefore",
    "worldInfoAfter",
    "main",
    "chatHistory",
    "dialogueExamples",
]);
const TYPE_LABELS = {
    dropdown: "드롭다운",
    single: "단일선택",
    multi: "다중선택",
    toggle: "ON/OFF",
    input: "텍스트",
    group: "그룹토글",
};
const TYPE_ICONS = {
    dropdown: "fa-chevron-down",
    single: "fa-circle-dot",
    multi: "fa-list-check",
    toggle: "fa-toggle-on",
    input: "fa-keyboard",
    group: "fa-layer-group",
};

let initialized = false;
let currentPresetKey = "";
let currentPresetName = "";
let currentDefinition = createEmptyDefinition();
let registeredMacroNames = new Set();
let macroWarnings = [];
let settingsContainer = null;
let runtimePanel = null;
let runtimeButton = null;
let leftFormObserver = null;
let settingsPlacementObserver = null;
let promptCatalogObserver = null;
let promptCatalogSyncTimer = null;
let observedPromptCatalogList = null;
let settingsPlacementTarget = null;
let nativeCatalogCache = null;
let toggleableCatalogCache = null;
let catalogCacheScheduled = false;
let suppressCatalogSync = false;
let lastPersistedPayload = "";
let lastPersistedKey = "";
let nativePromptRenderWatchdog = null;
let nativePromptSettleTimer = null;
let lightRenderInFlight = false;
let lightRenderPending = false;
let settingsEditorDirty = false;
let settingsVisibilityObserver = null;
let observedSettingsContainer = null;
let resizeFrame = 0;
let reloadTimer = null;
let nativePromptRenderTimer = null;
let nativePromptRenderInFlight = false;
let nativePromptRenderPending = false;
let saveChain = Promise.resolve();
let pendingSave = null;
let openRuntimeDropdown = null;
let nativePromptSyncChain = Promise.resolve();
let loadRevision = 0;
let importWarnings = [];
let inspectedPromptIdentifier = "";
let protectedLocalVariableState = null;
const expandedVariableIds = new Set();
const activeEditorTabs = new Map();
const stEventBindings = [];

let activeStThemeName = "";
let activeFavoriteId = '';
let favoriteDeleteMode = false;

function getContext() {
    return globalThis.SillyTavern?.getContext?.() ?? null;
}

function getEventTypes(context = getContext()) {
    return context?.eventTypes ?? context?.event_types ?? {};
}

function notify(kind, message) {
    const notifier = globalThis.toastr?.[kind];
    if (typeof notifier === "function") {
        notifier(message, "Switch Binder");
    } else {
        console[kind === "error" ? "error" : "log"](`[Switch Binder] ${message}`);
    }
}

function getStThemeName() {
    const context = getContext();
    const fromSettings = context?.powerUserSettings?.theme;
    if (typeof fromSettings === "string" && fromSettings) return fromSettings;
    const select = document.getElementById("themes");
    const fromDom = select?.value;
    if (typeof fromDom === "string" && fromDom) return fromDom;
    return DEFAULT_ST_THEME_KEY;
}

function readThemeMap() {
    try {
        const raw = globalThis.localStorage?.getItem(THEME_MAP_STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : null;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
        return {};
    }
}

function writeThemeMap(map) {
    try {
        globalThis.localStorage?.setItem(THEME_MAP_STORAGE_KEY, JSON.stringify(map));
    } catch {}
}

function getFallbackTheme() {
    try {
        const saved = globalThis.localStorage?.getItem(THEME_STORAGE_KEY);
        return saved === "dark" || saved === "light" ? saved : "light";
    } catch {
        return "light";
    }
}

function getStoredTheme(themeName = getStThemeName()) {
    const stored = readThemeMap()[themeName];
    if (stored === "dark" || stored === "light") return stored;
    return getFallbackTheme();
}

function persistTheme(theme, themeName = getStThemeName()) {
    const map = readThemeMap();
    map[themeName] = theme;
    writeThemeMap(map);
    try {
        globalThis.localStorage?.setItem(THEME_STORAGE_KEY, theme);
    } catch {}
}

function applyTheme(theme, {persist = true} = {}) {
    document.body.classList.toggle(THEME_BODY_CLASS, theme === "dark");
    const toggleButton = document.getElementById("prompt_controls_theme_toggle");
    if (toggleButton) {
        const icon = toggleButton.querySelector("i");
        icon?.classList.toggle("fa-moon", theme !== "dark");
        icon?.classList.toggle("fa-sun", theme === "dark");
        toggleButton.setAttribute("aria-pressed", theme === "dark" ? "true" : "false");
        toggleButton.title = theme === "dark" ? "라이트 모드로 전환" : "다크 모드로 전환";
    }
    if (persist) persistTheme(theme, activeStThemeName || getStThemeName());
}

function toggleTheme() {
    const next = document.body.classList.contains(THEME_BODY_CLASS) ? "light" : "dark";
    applyTheme(next);
}

function syncThemeWithStTheme({force = false} = {}) {
    const themeName = getStThemeName();
    if (!force && themeName === activeStThemeName) return;
    activeStThemeName = themeName;
    applyTheme(getStoredTheme(themeName), {persist: false});
}

function handleStThemeSelectChange(event) {
    if (event.target?.id !== "themes") return;
    setTimeout(() => syncThemeWithStTheme(), 0);
}

function createEmptyDefinition() {
    return {version: SCHEMA_VERSION, variables: [], favorites: []};
}

function normalizeFavorite(raw) {
    const favorite = raw && typeof raw === "object" ? raw : {};
    const rawValues = favorite.values && typeof favorite.values === "object" && !Array.isArray(favorite.values) ? favorite.values : {};
    return {
        id: asString(favorite.id, 160) || makeId("favorite"),
        name: asString(favorite.name, 100) || "프리셋",
        values: Object.fromEntries(Object.entries(rawValues).slice(0, 50)),
    };
}

function makeId(prefix) {
    const uuid = globalThis.crypto?.randomUUID?.();
    return `${prefix}_${uuid ?? `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
}

function asString(value, maxLength = 10000) {
    return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function normalizeOption(raw, index) {
    const option = raw && typeof raw === "object" ? raw : {};
    return {
        id: asString(option.id, 160) || makeId("option"),
        label: asString(option.label, 200) || `옵션 ${index + 1}`,
        value: asString(option.value, 20000),
    };
}

function normalizePromptOption(raw, index) {
    const option = raw && typeof raw === "object" ? raw : {};
    const promptIdentifier = asString(option.promptIdentifier ?? option.identifier, 240).trim();
    return {
        id: asString(option.id, 160) || makeId("prompt-option"),
        promptIdentifier,
        label: asString(option.label, 300) || promptIdentifier || `프롬프트 ${index + 1}`,
        displayLabel: asString(option.displayLabel, 300).trim(),
    };
}

function normalizePromptGroup(raw, index, promptOptions) {
    const group = raw && typeof raw === "object" ? raw : {};
    const requested = new Set((Array.isArray(group.optionIds) ? group.optionIds : []).map((value) => asString(value, 160)));
    return {
        id: asString(group.id, 160) || makeId("prompt-group"),
        label: asString(group.label, 200) || `그룹 ${index + 1}`,
        optionIds: promptOptions.filter((option) => requested.has(option.id)).map((option) => option.id),
    };
}

function normalizeGroupSelection(rawSelection, groups, single = false) {
    const groupList = Array.isArray(groups) ? groups : [];
    const requested = new Set((Array.isArray(rawSelection) ? rawSelection : []).map((value) => asString(value, 160)));
    const selected = groupList.filter((group) => requested.has(group.id)).map((group) => group.id);
    return single ? selected.slice(0, 1) : selected;
}

function isSingleGroupMode(variable) {
    return variable.groupMode === "single";
}

function normalizeSelectionDefault(type, rawDefault, options, isPromptToggle = false) {
    if (type === "multi") {
        const values = Array.isArray(rawDefault) ? rawDefault : [];
        return [...new Set(values.filter((value) => options.some((option) => option.id === value)))];
    }
    const candidate = asString(rawDefault, 160);
    if (options.some((option) => option.id === candidate)) return candidate;
    if (isPromptToggle && options.length === 1) return "";
    return options[0]?.id ?? "";
}

function normalizeVariableDefault(type, rawDefault, options) {
    if (type === "toggle") return rawDefault === true;
    if (type === "input") return asString(rawDefault, 10000);
    return normalizeSelectionDefault(type, rawDefault, options);
}

function normalizeVariable(raw, index) {
    const variable = raw && typeof raw === "object" ? raw : {};
    const promptToggleMode = variable.promptToggleMode === true;
    const legacyType = VARIABLE_TYPES.has(variable.type) ? variable.type : "dropdown";
    const variableType =
        VARIABLE_TYPES.has(variable.variableType) ? variable.variableType
        : promptToggleMode ? "dropdown"
        : legacyType;
    const promptType =
        PROMPT_TYPES.has(variable.promptType) ? variable.promptType
        : promptToggleMode && variable.type === "group" ? "group"
        : promptToggleMode && PROMPT_TYPES.has(legacyType) ? legacyType
        : "dropdown";
    const type = promptToggleMode ? promptType : variableType;
    const options = Array.isArray(variable.options) ? variable.options.slice(0, 100).map(normalizeOption) : [];
    const normalizedPromptOptions =
        Array.isArray(variable.promptOptions) ?
            variable.promptOptions
                .slice(0, 200)
                .map(normalizePromptOption)
                .filter((option) => option.promptIdentifier)
        :   [];
    const promptOptions = [...new Map(normalizedPromptOptions.map((option) => [option.promptIdentifier, option])).values()];
    const groupMode = variable.groupMode === "single" ? "single" : "multi";
    const promptGroups =
        Array.isArray(variable.promptGroups) ?
            variable.promptGroups.slice(0, 50).map((rawGroup, groupIndex) => normalizePromptGroup(rawGroup, groupIndex, promptOptions))
        :   [];
    const fallbackKey = `variable${index + 1}`;
    const key = MACRO_NAME_PATTERN.test(variable.key) ? variable.key : fallbackKey;
    const defaultValue = normalizeVariableDefault(variableType, variable.defaultValue, options);

    return {
        id: asString(variable.id, 160) || makeId("variable"),
        key,
        label: asString(variable.label, 200) || `변수 ${index + 1}`,
        type,
        variableType,
        promptType,
        promptToggleMode,
        setvarMode: variable.setvarMode === true,
        pinned: variable.pinned === true,
        runtimeHidden: variable.runtimeHidden === true,
        defaultValue,
        groupMode,
        promptDefaultValue:
            promptType === "group" ?
                normalizeGroupSelection(variable.promptDefaultValue, promptGroups, groupMode === "single")
            :   normalizeSelectionDefault(promptType, variable.promptDefaultValue, promptOptions, true),
        separator: asString(variable.separator, 40) || "\n",
        placeholder: asString(variable.placeholder, 300),
        onValue: asString(variable.onValue, 20000),
        offValue: asString(variable.offValue, 20000),
        options,
        promptOptions,
        promptGroups,
    };
}

function normalizeDefinition(raw) {
    const source = raw && typeof raw === "object" ? raw : {};
    const variables = Array.isArray(source.variables) ? source.variables.slice(0, 50).map(normalizeVariable) : [];
    const usedKeys = new Set();

    for (let index = 0; index < variables.length; index++) {
        const variable = variables[index];
        let candidate = variable.key;
        let suffix = 2;
        while (usedKeys.has(candidate.toLowerCase())) {
            candidate = `${variable.key}${suffix++}`.slice(0, 64);
        }
        variable.key = candidate;
        usedKeys.add(candidate.toLowerCase());
    }

    const favorites = Array.isArray(source.favorites) ? source.favorites.slice(0, 30).map(normalizeFavorite) : [];

    return {version: SCHEMA_VERSION, variables, favorites};
}

function cloneData(value) {
    return globalThis.structuredClone ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function getPresetInfo() {
    const context = getContext();
    const manager = context?.getPresetManager?.();
    const name = manager?.getSelectedPresetName?.()?.trim?.() ?? "";
    if (!manager || !name) return null;
    const apiId = asString(manager.apiId, 80) || asString(context?.mainApi, 80) || "current";
    return {
        manager,
        name,
        key: `${apiId}::${name}`,
    };
}

function hasActiveChat() {
    const context = getContext();
    if (!context) return false;
    const chatId = context.chatId ?? context.getCurrentChatId?.();
    return chatId !== undefined && chatId !== null && String(chatId).length > 0;
}

function getChatPresetState({create = false} = {}) {
    const context = getContext();
    const metadata = context?.chatMetadata;
    if (!metadata || !currentPresetKey || !hasActiveChat()) return null;

    let root = metadata[CHAT_STATE_KEY];
    if (!root || typeof root !== "object" || Array.isArray(root)) {
        if (!create) return null;
        root = {version: SCHEMA_VERSION, presets: {}};
        metadata[CHAT_STATE_KEY] = root;
    }
    if (!root.presets || typeof root.presets !== "object" || Array.isArray(root.presets)) {
        if (!create) return null;
        root.presets = {};
    }
    let presetState = root.presets[currentPresetKey];
    if (!presetState || typeof presetState !== "object" || Array.isArray(presetState)) {
        if (!create) return null;
        presetState = {values: {}};
        root.presets[currentPresetKey] = presetState;
    }
    if (!presetState.values || typeof presetState.values !== "object" || Array.isArray(presetState.values)) {
        if (!create) return null;
        presetState.values = {};
    }
    if (!presetState.promptValues || typeof presetState.promptValues !== "object" || Array.isArray(presetState.promptValues)) {
        if (create) presetState.promptValues = {};
    }
    return presetState;
}

function saveChatMetadata() {
    const context = getContext();
    if (typeof context?.saveMetadataDebounced === "function") {
        context.saveMetadataDebounced();
        return;
    }
    Promise.resolve(context?.saveMetadata?.()).catch((error) => {
        console.error("[Switch Binder] Could not save chat metadata.", error);
        notify("error", "채팅별 변수 값을 저장하지 못했습니다.");
    });
}

function getRawValue(variable) {
    const presetState = getChatPresetState();
    const values = variable.promptToggleMode ? presetState?.promptValues : presetState?.values;
    if (values && Object.hasOwn(values, variable.id)) {
        return sanitizeRuntimeValue(variable, values[variable.id]);
    }
    if (variable.promptToggleMode && presetState?.values && Object.hasOwn(presetState.values, variable.id)) {
        return sanitizeRuntimeValue(variable, presetState.values[variable.id]);
    }
    return sanitizeRuntimeValue(variable, getVariableDefaultValue(variable));
}

function getVariableOptions(variable) {
    return variable.promptToggleMode ? variable.promptOptions : variable.options;
}

function getPromptOptionDisplayLabel(option, promptCatalog = null) {
    return option.displayLabel || promptCatalog?.get(option.promptIdentifier)?.name || option.label;
}

function isVariableVisibleInRuntime(variable) {
    return variable.runtimeHidden !== true;
}

function getVariableDefaultValue(variable) {
    return variable.promptToggleMode ? variable.promptDefaultValue : variable.defaultValue;
}

function setVariableDefaultValue(variable, value) {
    if (variable.promptToggleMode) variable.promptDefaultValue = value;
    else variable.defaultValue = value;
}

function sanitizeRuntimeValue(variable, value) {
    if (variable.type === "group") return normalizeGroupSelection(value, variable.promptGroups ?? [], isSingleGroupMode(variable));
    const options = getVariableOptions(variable);
    if (variable.type === "multi") {
        const list = Array.isArray(value) ? value : [];
        return [...new Set(list.filter((item) => options.some((option) => option.id === item)))];
    }
    if (variable.type === "toggle") return value === true;
    if (variable.type === "input") return asString(value, 10000);
    const candidate = asString(value, 160);
    if (options.some((option) => option.id === candidate)) return candidate;
    if (variable.promptToggleMode && options.length === 1 && candidate === "") return "";
    return options[0]?.id ?? "";
}

function setRawValue(variable, value) {
    const presetState = getChatPresetState({create: true});
    if (!presetState) {
        notify("warning", "먼저 채팅을 열어주세요. 현재값은 채팅별로 저장됩니다.");
        return false;
    }
    const values = variable.promptToggleMode ? presetState.promptValues : presetState.values;
    values[variable.id] = sanitizeRuntimeValue(variable, value);
    saveChatMetadata();
    queueNativePromptSync([variable]);
    updateFavoriteButtonState();
    return true;
}

function substituteBasicMacros(text) {
    if (typeof text !== "string" || !text) return text;
    const context = getContext();
    if (typeof context?.substituteParams === "function") {
        return context.substituteParams(text);
    }
    const userName = context?.name1 ?? "";
    const charName = context?.name2 ?? "";
    const groupNames =
        context?.groups
            ?.find?.((g) => g.id === context?.groupId)
            ?.members?.map((member) => context?.characters?.find?.((c) => c.avatar === member)?.name)
            ?.filter(Boolean)
            ?.join(", ") ?? charName;
    return text
        .replace(/\{\{user\}\}/gi, userName)
        .replace(/\{\{char\}\}/gi, charName)
        .replace(/\{\{group\}\}/gi, groupNames);
}

function resolveVariable(variable) {
    if (variable.promptToggleMode) return "";
    const raw = getRawValue(variable);
    let result;
    if (variable.type === "multi") {
        result = raw
            .map((id) => variable.options.find((option) => option.id === id)?.value ?? "")
            .filter(Boolean)
            .join(variable.separator);
    } else if (variable.type === "toggle") {
        result = raw ? variable.onValue : variable.offValue;
    } else if (variable.type === "input") {
        result = raw;
    } else {
        result = variable.options.find((option) => option.id === raw)?.value ?? "";
    }
    return substituteBasicMacros(result);
}

function getVariableMacroLabel(variable) {
    if (variable.promptToggleMode) return "토글 제어";
    return variable.setvarMode ? `{{getvar::${variable.key}}}` : `{{${variable.key}}}`;
}

function restoreSetvarBindings() {
    const state = protectedLocalVariableState;
    protectedLocalVariableState = null;
    if (!state) return;

    try {
        if (state.toJSONDescriptor) {
            Object.defineProperty(state.store, "toJSON", state.toJSONDescriptor);
        } else {
            delete state.store.toJSON;
        }
        for (const [key, record] of state.records) {
            if (record.descriptor) Object.defineProperty(state.store, key, record.descriptor);
            else delete state.store[key];
        }
    } catch (error) {
        console.warn("[Switch Binder] Could not restore protected local variables.", error);
    }
}

function refreshSetvarBindings() {
    restoreSetvarBindings();
    const protectedVariables = currentDefinition.variables.filter((variable) => !variable.promptToggleMode && variable.setvarMode);
    if (protectedVariables.length === 0) return;

    const context = getContext();
    const metadata = context?.chatMetadata;
    if (!metadata || typeof metadata !== "object") return;
    if (!metadata.variables || typeof metadata.variables !== "object" || Array.isArray(metadata.variables)) {
        metadata.variables = {};
    }

    const store = metadata.variables;
    const toJSONDescriptor = Object.getOwnPropertyDescriptor(store, "toJSON");
    if (toJSONDescriptor && !toJSONDescriptor.configurable) {
        console.warn("[Switch Binder] Local variables have a non-configurable toJSON property; setvar mode was not applied.");
        return;
    }

    const records = new Map();
    for (const variable of protectedVariables) {
        if (variable.key === "toJSON") {
            console.warn('[Switch Binder] The exact variable name "toJSON" cannot use setvar mode.');
            continue;
        }
        const descriptor = Object.getOwnPropertyDescriptor(store, variable.key);
        if (descriptor && !descriptor.configurable) {
            console.warn(`[Switch Binder] Could not protect local variable ${variable.key}.`);
            continue;
        }
        let originalValue;
        try {
            originalValue =
                descriptor ?
                    "value" in descriptor ?
                        descriptor.value
                    :   descriptor.get?.call(store)
                :   undefined;
        } catch {
            originalValue = undefined;
        }
        records.set(variable.key, {descriptor, originalValue});
        Object.defineProperty(store, variable.key, {
            configurable: true,
            enumerable: false,
            get() {
                const activeVariable = currentDefinition.variables.find((item) => item.setvarMode && !item.promptToggleMode && item.key === variable.key);
                return activeVariable ? resolveVariable(activeVariable) : originalValue;
            },
            set() {},
        });
    }

    if (records.size === 0) return;
    Object.defineProperty(store, "toJSON", {
        configurable: true,
        enumerable: false,
        value() {
            const snapshot = {};
            for (const key of Object.keys(store)) snapshot[key] = store[key];
            for (const [key, record] of records) {
                if (record.descriptor?.enumerable) snapshot[key] = record.originalValue;
            }
            if (toJSONDescriptor?.enumerable && "value" in toJSONDescriptor && typeof toJSONDescriptor.value !== "function") {
                snapshot.toJSON = toJSONDescriptor.value;
            }
            return snapshot;
        },
    });
    protectedLocalVariableState = {store, records, toJSONDescriptor};
}

function getNativePromptOrder(settings) {
    const orderGroups = Array.isArray(settings?.prompt_order) ? settings.prompt_order : [];
    return orderGroups.find((group) => String(group?.character_id) === "100001")?.order ?? orderGroups[0]?.order ?? [];
}

function getPromptManagerList() {
    return document.getElementById("completion_prompt_manager_list");
}

function isElementVisible(element) {
    if (!element?.isConnected) return false;
    if (element.offsetParent) return true;
    if (typeof element.checkVisibility === "function") return element.checkVisibility();
    return false;
}

function isPromptManagerVisible() {
    return isElementVisible(getPromptManagerList());
}

function scheduleCatalogCacheReset() {
    if (catalogCacheScheduled) return;
    catalogCacheScheduled = true;
    queueMicrotask(() => {
        catalogCacheScheduled = false;
        nativeCatalogCache = null;
        toggleableCatalogCache = null;
    });
}

function getNativePromptCatalog() {
    if (nativeCatalogCache) return nativeCatalogCache;
    const catalog = computeNativePromptCatalog();
    nativeCatalogCache = catalog;
    scheduleCatalogCacheReset();
    return catalog;
}

function getToggleableNativePromptCatalog() {
    if (toggleableCatalogCache) return toggleableCatalogCache;
    const catalog = computeToggleableNativePromptCatalog();
    toggleableCatalogCache = catalog;
    scheduleCatalogCacheReset();
    return catalog;
}

function computeNativePromptCatalog() {
    const context = getContext();
    const settings = context?.chatCompletionSettings;
    if (context?.mainApi !== "openai" || !settings || !Array.isArray(settings.prompts)) return [];
    const prompts = settings.prompts.filter((prompt) => prompt && typeof prompt === "object" && prompt.identifier);
    const order = getNativePromptOrder(settings);
    const orderState = new Map(order.map((item, index) => [item.identifier, {index, enabled: item.enabled === true}]));
    return prompts
        .map((prompt, fallbackIndex) => ({
            identifier: asString(prompt.identifier, 240),
            name: asString(prompt.name, 300) || asString(prompt.identifier, 240),
            enabled: orderState.get(prompt.identifier)?.enabled ?? false,
            order: orderState.get(prompt.identifier)?.index ?? 100000 + fallbackIndex,
            marker: prompt.marker === true,
            attached: orderState.has(prompt.identifier),
        }))
        .filter((prompt) => prompt.identifier)
        .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name));
}

function computeToggleableNativePromptCatalog() {
    return getNativePromptCatalog().filter((prompt) => prompt.attached && (!prompt.marker || FORCE_TOGGLE_MARKERS.has(prompt.identifier)));
}

function getDesiredPromptStates(variable) {
    if (!variable.promptToggleMode || !PROMPT_TYPES.has(variable.type)) return [];

    if (variable.type === "group") {
        const activeGroups = new Set(getRawValue(variable));
        const activeOptionIds = new Set(variable.promptGroups.filter((group) => activeGroups.has(group.id)).flatMap((group) => group.optionIds));
        return variable.promptOptions.map((option) => ({
            identifier: option.promptIdentifier,
            enabled: activeOptionIds.has(option.id),
        }));
    }
    const raw = getRawValue(variable);
    const selectedIds = variable.type === "multi" ? raw : [raw];
    return variable.promptOptions.map((option) => ({
        identifier: option.promptIdentifier,
        enabled: selectedIds.includes(option.id),
    }));
}

function refreshOpenPromptInspector() {
    if (!inspectedPromptIdentifier) return;
    const popup = document.getElementById("completion_prompt_manager_popup");
    const inspectArea = document.getElementById("completion_prompt_manager_popup_inspect");
    if (!popup?.classList.contains("openDrawer") || inspectArea?.style.display === "none") return;

    findPromptManagerRow(inspectedPromptIdentifier)?.querySelector(".prompt-manager-inspect-action")?.click();
}

function escapeAttributeValue(value) {
    return String(value).replace(/[\\"]/g, "\\$&");
}

function findPromptManagerRow(identifier) {
    const list = getPromptManagerList();
    if (!list || !identifier) return null;
    return list.querySelector(`[data-pm-identifier="${escapeAttributeValue(identifier)}"]`);
}

function handlePromptInspectorClick(event) {
    if (nativePromptRenderPending) {
        setTimeout(flushPendingNativePromptRender, 0);
        setTimeout(flushPendingNativePromptRender, 350);
    }
    if (settingsEditorDirty) {
        setTimeout(flushPendingSettingsRender, 0);
        setTimeout(flushPendingSettingsRender, 350);
    }
    const inspectAction = event.target.closest?.(".prompt-manager-inspect-action");
    if (inspectAction) {
        inspectedPromptIdentifier = inspectAction.closest("[data-pm-identifier]")?.dataset.pmIdentifier ?? "";
        return;
    }
    if (event.target.closest?.("#completion_prompt_manager_popup_close_button, .prompt-manager-edit-action")) {
        inspectedPromptIdentifier = "";
    }
}

function reflectNativePromptState(identifier, enabled) {
    const row = findPromptManagerRow(identifier);
    if (!row) return false;
    row.classList.toggle("completion_prompt_manager_prompt_disabled", !enabled);
    const toggle = row.querySelector(".prompt-manager-toggle-action");
    toggle?.classList.toggle("fa-toggle-on", enabled);
    toggle?.classList.toggle("fa-toggle-off", !enabled);
    return true;
}

function reflectSettingsPromptState(identifier, enabled) {
    if (!settingsContainer?.isConnected) return;
    const rows = settingsContainer.querySelectorAll(`.sb-prompt-option-row[data-prompt-identifier="${escapeAttributeValue(identifier)}"]`);
    for (const row of rows) {
        const state = row.querySelector(".sb-prompt-state-icon");
        state?.classList.toggle("sb-prompt-state-icon-on", enabled);
        const icon = state?.querySelector("i");
        icon?.classList.toggle("fa-toggle-on", enabled);
        icon?.classList.toggle("fa-toggle-off", !enabled);
        const meta = row.querySelector(".sb-prompt-state-text");
        if (meta) meta.textContent = enabled ? "현재 ON" : "현재 OFF";
    }
}

const SETTLE_RENDER_DELAY = 1200;

function scheduleNativePromptRender({relistNeeded = false} = {}) {
    nativePromptRenderPending = true;
    if (!isPromptManagerVisible()) {
        clearTimeout(nativePromptRenderTimer);
        nativePromptRenderTimer = null;
        clearTimeout(nativePromptSettleTimer);
        nativePromptSettleTimer = null;
        return;
    }
    if (relistNeeded) scheduleLightPromptRender();
    scheduleSettlePromptRender();
}

function scheduleLightPromptRender() {
    if (nativePromptRenderTimer) return;
    nativePromptRenderTimer = setTimeout(() => {
        nativePromptRenderTimer = null;
        runPromptManagerRender(false);
    }, 24);
}

function scheduleSettlePromptRender() {
    clearTimeout(nativePromptSettleTimer);
    nativePromptSettleTimer = setTimeout(() => {
        nativePromptSettleTimer = null;
        runSettlePromptRender();
    }, SETTLE_RENDER_DELAY);
}

function runSettlePromptRender() {
    if (nativePromptRenderInFlight || !isPromptManagerVisible()) return;
    nativePromptRenderPending = false;
    nativePromptRenderInFlight = true;
    armNativePromptRenderWatchdog();
    runPromptManagerRender(true);
}

function runPromptManagerRender(withDryRun) {
    if (!withDryRun) {
        if (lightRenderInFlight) {
            lightRenderPending = true;
            return nativePromptSyncChain;
        }
        lightRenderInFlight = true;
    }
    suppressCatalogSync = true;
    nativePromptSyncChain = nativePromptSyncChain
        .catch(() => undefined)
        .then(async () => {
            const context = getContext();
            const execute = context?.executeSlashCommandsWithOptions ?? context?.executeSlashCommands;
            if (typeof execute !== "function") throw new Error("Slash command executor is unavailable.");
            await execute(`/pm-render refresh=${withDryRun ? "true" : "false"}`);
        })
        .catch((error) => {
            console.error("[Switch Binder] Could not refresh the prompt manager.", error);
            if (!withDryRun) return;
            releaseNativePromptRenderLock();
            notify("error", "Prompt List를 새로 계산하지 못했습니다.");
            if (nativePromptRenderPending) scheduleSettlePromptRender();
        })
        .finally(() => {
            if (!withDryRun) {
                lightRenderInFlight = false;
                if (lightRenderPending) {
                    lightRenderPending = false;
                    scheduleLightPromptRender();
                }
            }
            setTimeout(() => {
                suppressCatalogSync = false;
            }, 100);
        });
    return nativePromptSyncChain;
}

function armNativePromptRenderWatchdog() {
    clearTimeout(nativePromptRenderWatchdog);
    nativePromptRenderWatchdog = setTimeout(() => {
        nativePromptRenderWatchdog = null;
        if (!nativePromptRenderInFlight) return;
        console.warn("[Switch Binder] The prompt manager never reported a finished render; releasing the lock.");
        nativePromptRenderInFlight = false;
        if (nativePromptRenderPending) scheduleSettlePromptRender();
    }, 8000);
}

function releaseNativePromptRenderLock() {
    clearTimeout(nativePromptRenderWatchdog);
    nativePromptRenderWatchdog = null;
    nativePromptRenderInFlight = false;
}

function flushPendingNativePromptRender() {
    if (!nativePromptRenderPending || nativePromptRenderTimer || nativePromptSettleTimer) return;
    if (!isPromptManagerVisible()) return;
    scheduleNativePromptRender();
}

function queueNativePromptSync(variables = currentDefinition.variables) {
    const requested = Array.isArray(variables) ? [...variables] : [];
    const context = getContext();
    const settings = context?.chatCompletionSettings;
    const catalog = getNativePromptCatalog();
    if (catalog.length === 0 || requested.length === 0 || !settings) return nativePromptSyncChain;

    const available = new Set(catalog.map((prompt) => prompt.identifier));
    const desired = new Map();
    for (const variable of requested) {
        for (const promptState of getDesiredPromptStates(variable)) {
            if (available.has(promptState.identifier)) desired.set(promptState.identifier, promptState.enabled);
        }
    }

    const orderEntries = new Map(getNativePromptOrder(settings).map((entry) => [entry.identifier, entry]));
    const promptListPresent = Boolean(getPromptManagerList());
    const settingsAttached = Boolean(settingsContainer?.isConnected);
    let settingsChanged = false;
    let relistNeeded = false;
    for (const [identifier, enabled] of desired) {
        const entry = orderEntries.get(identifier);
        if (!entry) continue;
        if (entry.enabled !== enabled) {
            entry.enabled = enabled;
            settingsChanged = true;
        }
        if (promptListPresent && !reflectNativePromptState(identifier, enabled)) relistNeeded = true;
        if (settingsAttached) reflectSettingsPromptState(identifier, enabled);
    }
    if (settingsChanged) context.saveSettingsDebounced?.();

    scheduleNativePromptRender({relistNeeded});
    return nativePromptSyncChain;
}

function unregisterMacros() {
    const context = getContext();
    for (const name of registeredMacroNames) {
        try {
            const usesNewMacroEngine = context?.powerUserSettings?.experimental_macro_engine === true;
            if (usesNewMacroEngine && context?.macros?.registry?.unregisterMacro) {
                context.macros.registry.unregisterMacro(name);
            } else if (context?.unregisterMacro) {
                context.unregisterMacro(name);
            } else {
                context?.macros?.registry?.unregisterMacro?.(name);
            }
        } catch (error) {
            console.warn(`[Switch Binder] Could not unregister macro ${name}.`, error);
        }
    }
    registeredMacroNames = new Set();
}

function refreshMacros() {
    const context = getContext();
    unregisterMacros();
    macroWarnings = [];
    if (!context) return;

    for (const variable of currentDefinition.variables) {
        if (variable.promptToggleMode || variable.setvarMode) continue;
        const name = variable.key;
        const registry = context.macros?.registry;
        const usesNewMacroEngine = context.powerUserSettings?.experimental_macro_engine === true;
        if (usesNewMacroEngine && registry?.hasMacro?.(name)) {
            macroWarnings.push(`{{${name}}} 이름은 SillyTavern 또는 다른 확장에서 이미 사용 중이라 등록하지 않았습니다.`);
            continue;
        }

        const handler = () => {
            const activeVariable = currentDefinition.variables.find((item) => item.key.toLowerCase() === name.toLowerCase());
            return activeVariable ? resolveVariable(activeVariable) : "";
        };

        try {
            if (usesNewMacroEngine && context.macros?.register) {
                const result = context.macros.register(name, {
                    category: "prompt-controls",
                    description: `Switch Binder variable: ${variable.label}`,
                    returns: `Current value of {{${name}}}`,
                    handler,
                });
                if (!result) {
                    macroWarnings.push(`{{${name}}} 변수를 등록하지 못했습니다.`);
                    continue;
                }
            } else if (context.registerMacro) {
                context.registerMacro(name, handler, `Switch Binder variable: ${variable.label}`);
            } else if (context.macros?.register) {
                const result = context.macros.register(name, {
                    category: "prompt-controls",
                    description: `Switch Binder variable: ${variable.label}`,
                    returns: `Current value of {{${name}}}`,
                    handler,
                });
                if (!result) {
                    macroWarnings.push(`{{${name}}} 변수를 등록하지 못했습니다.`);
                    continue;
                }
            } else {
                macroWarnings.push("이 SillyTavern 버전에서는 사용자 변수 등록 API를 찾지 못했습니다.");
                break;
            }
            registeredMacroNames.add(name);
        } catch (error) {
            console.error(`[Switch Binder] Could not register macro ${name}.`, error);
            macroWarnings.push(`{{${name}}} 변수를 등록하지 못했습니다.`);
        }
    }
    refreshSetvarBindings();
}

function setSaveStatus(message) {
    const target = document.getElementById("prompt_controls_save_status");
    if (target) target.textContent = message;
}

function persistDefinition({announce = false} = {}) {
    if (pendingSave) {
        pendingSave.presetKey = currentPresetKey;
        pendingSave.presetName = currentPresetName;
        pendingSave.announce = pendingSave.announce || announce;
        return saveChain;
    }

    pendingSave = {presetKey: currentPresetKey, presetName: currentPresetName, announce};
    setSaveStatus("저장 중…");
    saveChain = saveChain.catch(() => undefined).then(flushPendingSave);
    return saveChain;
}

async function flushPendingSave() {
    const request = pendingSave;
    pendingSave = null;
    if (!request) return;
    if (currentPresetKey !== request.presetKey) return;

    const snapshot = normalizeDefinition(cloneData(currentDefinition));
    let payload = "";
    try {
        payload = JSON.stringify(snapshot);
    } catch {
        payload = "";
    }

    if (payload && payload === lastPersistedPayload && request.presetKey === lastPersistedKey) {
        setSaveStatus(`“${request.presetName}” 프롬프트에 저장됨`);
        if (request.announce) notify("success", "현재 변수 설정을 프롬프트에 저장했습니다.");
        return;
    }

    try {
        const info = getPresetInfo();
        if (!info || info.key !== request.presetKey) return;
        await info.manager.writePresetExtensionField({
            path: MODULE_NAME,
            value: snapshot,
        });
        lastPersistedPayload = payload;
        lastPersistedKey = request.presetKey;
        if (currentPresetKey === request.presetKey) {
            setSaveStatus(`“${request.presetName}” 프롬프트에 저장됨`);
            if (request.announce) notify("success", "현재 변수 설정을 프롬프트에 저장했습니다.");
        }
    } catch (error) {
        lastPersistedPayload = "";
        lastPersistedKey = "";
        console.error("[Switch Binder] Could not save preset definition.", error);
        if (currentPresetKey === request.presetKey) setSaveStatus("저장 실패");
        notify("error", "현재 프롬프트에 변수 설정을 저장하지 못했습니다.");
    }
}

function validateImportedDefinition(raw) {
    const errors = [];
    const warnings = [];
    const candidate = raw?.definition ?? raw?.extensions?.[MODULE_NAME] ?? raw;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        return {ok: false, errors: ["가져온 파일에 변수 정의 객체가 없습니다."], warnings, definition: null};
    }
    if (!Array.isArray(candidate.variables)) {
        return {ok: false, errors: ["variables 배열이 필요합니다."], warnings, definition: null};
    }
    if (candidate.variables.length > 50) errors.push("변수는 최대 50개까지 가져올 수 있습니다.");
    const usedKeys = new Set();
    const usedToggleIdentifiers = new Set();
    const catalogIds = new Set(getNativePromptCatalog().map((prompt) => prompt.identifier));
    candidate.variables.slice(0, 50).forEach((rawVariable, index) => {
        const path = `변수 ${index + 1}`;
        if (!rawVariable || typeof rawVariable !== "object") {
            errors.push(`${path}: 객체 형식이 아닙니다.`);
            return;
        }
        const key = asString(rawVariable.key, 100).trim();
        if (!MACRO_NAME_PATTERN.test(key)) errors.push(`${path}: 올바르지 않은 변수 이름입니다.`);
        if (usedKeys.has(key.toLowerCase())) errors.push(`${path}: 중복 변수 이름 “${key}”입니다.`);
        usedKeys.add(key.toLowerCase());
        const promptMode = rawVariable.promptToggleMode === true;
        if (!(promptMode ? PROMPT_TYPES : VARIABLE_TYPES).has(rawVariable.type)) {
            errors.push(`${path}: 지원하지 않는 종류입니다.`);
        }
        if (promptMode) {
            if (!Array.isArray(rawVariable.promptOptions)) {
                errors.push(`${path}: promptOptions 배열이 필요합니다.`);
            }
            if (rawVariable.type === "group" && !Array.isArray(rawVariable.promptGroups)) {
                errors.push(`${path}: 그룹 토글 방식에는 promptGroups 배열이 필요합니다.`);
            }
            rawVariable.promptOptions?.forEach?.((rawOption, optionIndex) => {
                const identifier = asString(rawOption?.promptIdentifier ?? rawOption?.identifier, 240).trim();
                if (!identifier) {
                    errors.push(`${path} 토글 ${optionIndex + 1}: 프롬프트 식별자가 없습니다.`);
                    return;
                }
                if (usedToggleIdentifiers.has(identifier)) {
                    errors.push(`${path} 토글 ${optionIndex + 1}: 프롬프트 “${identifier}”가 다른 토글 변수에 이미 등록되어 있습니다.`);
                } else {
                    usedToggleIdentifiers.add(identifier);
                }
                if (catalogIds.size && !catalogIds.has(identifier)) {
                    warnings.push(`${path} 토글 ${optionIndex + 1}: 프롬프트 “${identifier}”를 현재 프롬프트에서 찾지 못했습니다.`);
                }
            });
        } else if (["dropdown", "single", "multi"].includes(rawVariable.type)) {
            if (!Array.isArray(rawVariable.options) || rawVariable.options.length === 0) {
                errors.push(`${path}: 선택형 변수에는 선택지가 하나 이상 필요합니다.`);
            }
            rawVariable.options?.forEach?.((rawOption, optionIndex) => {
                if (!rawOption || typeof rawOption !== "object") {
                    errors.push(`${path} 선택지 ${optionIndex + 1}: 객체 형식이 아닙니다.`);
                }
            });
        }
    });
    if (Number(candidate.version) > SCHEMA_VERSION) warnings.push("더 새로운 버전에서 만든 정의입니다. 알려진 필드만 가져옵니다.");
    return {
        ok: errors.length === 0,
        errors,
        warnings: [...new Set(warnings)],
        definition: errors.length === 0 ? normalizeDefinition(candidate) : null,
    };
}

function exportCurrentDefinition() {
    if (!currentPresetKey) return;
    const payload = {
        format: "sillytavern-prompt-controls",
        version: SCHEMA_VERSION,
        preset: currentPresetName,
        definition: normalizeDefinition(cloneData(currentDefinition)),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], {type: "application/json"});
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${currentPresetName || "prompt-controls"}.user-custom.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function importDefinitionFile(file) {
    if (!file) return;
    if (file.size > 2_000_000) {
        notify("error", "가져오기 파일은 2MB 이하여야 합니다.");
        return;
    }
    try {
        const raw = JSON.parse(await file.text());
        const result = validateImportedDefinition(raw);
        importWarnings = [...result.errors, ...result.warnings];
        renderSettingsWarnings();
        if (!result.ok || !result.definition) {
            notify("error", `가져오기 검증 실패 · ${result.errors.length}개 오류`);
            return;
        }
        if (!globalThis.confirm(`검증을 통과했습니다. 현재 프롬프트 “${currentPresetName}”의 변수 정의를 교체할까요?`)) return;
        currentDefinition = result.definition;
        expandedVariableIds.clear();
        refreshMacros();
        renderSettingsEditor();
        renderRuntimePanel();
        updateRuntimeButton();
        await persistDefinition();
        notify("success", result.warnings.length ? `가져오기 완료 · ${result.warnings.length}개 경고 확인 필요` : "변수 정의를 검증하고 가져왔습니다.");
    } catch (error) {
        console.error("[Switch Binder] Could not import definition.", error);
        importWarnings = ["JSON 파일을 읽거나 해석하지 못했습니다."];
        renderSettingsWarnings();
        notify("error", "올바른 Switch Binder JSON 파일이 아닙니다.");
    }
}

async function copyDefinitionToPreset() {
    const wrap = document.getElementById("prompt_controls_copy_target_wrap");
    const sourceName = wrap?.dataset.value ?? "";
    const info = getPresetInfo();
    if (!info || !sourceName || sourceName === currentPresetName) return;

    let sourceDefinition;
    try {
        sourceDefinition = normalizeDefinition(info.manager.readPresetExtensionField({name: sourceName, path: MODULE_NAME}));
    } catch (error) {
        console.error("[Switch Binder] Could not read source preset definition.", error);
        notify("error", "선택한 프롬프트의 변수 설정을 읽지 못했습니다.");
        return;
    }

    if (sourceDefinition.variables.length === 0) {
        notify("error", `“${sourceName}” 프롬프트에는 가져올 변수 설정이 없습니다.`);
        return;
    }

    if (currentDefinition.variables.length > 0 && !globalThis.confirm(`현재 프롬프트 “${currentPresetName}”의 기존 변수 ${currentDefinition.variables.length}개를 “${sourceName}”의 설정으로 덮어쓸까요?`)) return;

    const targetCatalogIds = new Set(getNativePromptCatalog().map((prompt) => prompt.identifier));
    const sourceVariables = sourceDefinition.variables;
    const filteredVariables = sourceVariables.filter((variable) => {
        if (!variable.promptToggleMode) return true;
        return variable.promptOptions.length > 0 && variable.promptOptions.every((option) => targetCatalogIds.has(option.promptIdentifier));
    });
    const skippedCount = sourceVariables.length - filteredVariables.length;

    if (filteredVariables.length === 0) {
        notify("error", `“${sourceName}”의 변수는 현재 프롬프트와 토글 구성이 일치하지 않아 복사할 수 없습니다.`);
        return;
    }

    try {
        currentDefinition = normalizeDefinition(cloneData({...sourceDefinition, variables: filteredVariables}));
        expandedVariableIds.clear();
        refreshMacros();
        renderSettingsEditor();
        renderRuntimePanel();
        updateRuntimeButton();
        await persistDefinition();
        notify("success", skippedCount > 0 ? `“${sourceName}” 프롬프트의 변수 설정을 가져왔습니다. (토글 구성이 다른 변수 ${skippedCount}개 제외됨)` : `“${sourceName}” 프롬프트의 변수 설정을 가져왔습니다.`);
    } catch (error) {
        console.error("[Switch Binder] Could not import definition from preset.", error);
        notify("error", "프롬프트 간 변수 정의를 가져오지 못했습니다.");
    }
}

function loadCurrentPreset() {
    activeFavoriteId = '';
    pendingSave = null;
    lastPersistedPayload = "";
    lastPersistedKey = "";
    const revision = ++loadRevision;
    importWarnings = [];
    const info = getPresetInfo();
    if (!info) {
        currentPresetKey = "";
        currentPresetName = "";
        currentDefinition = createEmptyDefinition();
    } else {
        currentPresetKey = info.key;
        currentPresetName = info.name;
        let raw = null;
        try {
            raw = info.manager.readPresetExtensionField({path: MODULE_NAME});
        } catch (error) {
            console.error("[Switch Binder] Could not read preset definition.", error);
            notify("error", "현재 프롬프트의 변수 설정을 읽지 못했습니다.");
        }
        if (revision !== loadRevision) return;
        currentDefinition = normalizeDefinition(raw);
    }

    refreshMacros();
    ensurePromptCatalogObserver();
    ensureSettingsPlacementObserver();
    renderSettingsEditor();
    renderRuntimePanel();
    updateRuntimeButton();
    if (currentPresetKey && hasActiveChat()) {
        const presetKeyAtLoad = currentPresetKey;
        setTimeout(() => {
            if (currentPresetKey === presetKeyAtLoad) queueNativePromptSync();
        }, 180);
    }
}

function schedulePresetReload(delay = 80) {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(loadCurrentPreset, delay);
}

function isMacroNameAvailable(candidate, variableId) {
    const duplicate = currentDefinition.variables.some((variable) => variable.id !== variableId && variable.key.toLowerCase() === candidate.toLowerCase());
    if (duplicate) return {ok: false, message: "같은 프롬프트에서 이미 사용 중인 변수 이름입니다."};

    const registry = getContext()?.macros?.registry;
    const isOwned = [...registeredMacroNames].some((name) => name.toLowerCase() === candidate.toLowerCase());
    if (registry?.hasMacro?.(candidate) && !isOwned) {
        return {ok: false, message: "SillyTavern 또는 다른 확장이 이미 사용하는 변수 이름입니다."};
    }
    return {ok: true};
}

function uniqueVariableKey() {
    let index = currentDefinition.variables.length + 1;
    let key = `variable${index}`;
    const used = new Set(currentDefinition.variables.map((variable) => variable.key.toLowerCase()));
    while (used.has(key.toLowerCase()) || getContext()?.macros?.registry?.hasMacro?.(key)) {
        key = `variable${++index}`;
    }
    return key;
}

function createVariable() {
    const firstOption = {id: makeId("option"), label: "옵션 A", value: ""};
    const secondOption = {id: makeId("option"), label: "옵션 B", value: ""};
    const variable = {
        id: makeId("variable"),
        key: uniqueVariableKey(),
        label: "새 변수",
        type: "dropdown",
        variableType: "dropdown",
        promptType: "dropdown",
        promptToggleMode: false,
        setvarMode: false,
        pinned: false,
        runtimeHidden: false,
        defaultValue: firstOption.id,
        promptDefaultValue: "",
        groupMode: "multi",
        separator: "\n",
        placeholder: "",
        onValue: "",
        offValue: "",
        options: [firstOption, secondOption],
        promptOptions: [],
        promptGroups: [],
    };
    currentDefinition.variables.push(variable);
    expandedVariableIds.add(variable.id);
    refreshMacros();
    ensurePromptCatalogObserver();
    renderSettingsEditor();
    renderRuntimePanel();
    updateRuntimeButton();
    persistDefinition();
}

function findVariable(variableId) {
    return currentDefinition.variables.find((variable) => variable.id === variableId) ?? null;
}

function createIcon(iconClass) {
    const icon = document.createElement("i");
    icon.className = `fa-solid ${iconClass}`;
    icon.setAttribute("aria-hidden", "true");
    return icon;
}

function createLabeledField(labelText, control, iconClass = "") {
    const wrapper = document.createElement("div");
    wrapper.className = "sb-editor-field";
    const label = document.createElement("label");
    if (iconClass) label.append(createIcon(iconClass));
    const text = document.createElement("span");
    text.textContent = labelText;
    label.append(text);
    wrapper.append(label, control);
    return wrapper;
}

function createEditorSection(iconClass, titleText, description = "") {
    const section = document.createElement("section");
    section.className = "sb-card-section";
    const header = document.createElement("div");
    header.className = "sb-card-section-header";
    const icon = document.createElement("span");
    icon.className = "sb-card-section-icon";
    icon.append(createIcon(iconClass));
    const copy = document.createElement("div");
    copy.className = "sb-card-section-copy";
    const title = document.createElement("div");
    title.className = "sb-card-section-title";
    title.textContent = titleText;
    copy.append(title);
    if (description) {
        const descriptionElement = document.createElement("div");
        descriptionElement.className = "sb-card-section-description";
        descriptionElement.textContent = description;
        copy.append(descriptionElement);
    }
    header.append(icon, copy);
    section.append(header);
    return section;
}

function createEditorTabs(ownerId, tabs) {
    const wrap = document.createElement("div");
    wrap.className = "sb-editor-tabs";
    const tablist = document.createElement("div");
    tablist.className = "sb-editor-tablist";
    tablist.setAttribute("role", "tablist");
    const panels = document.createElement("div");
    panels.className = "sb-editor-tabpanels";
    const remembered = activeEditorTabs.get(ownerId);
    const buttons = [];

    const select = (key) => {
        activeEditorTabs.set(ownerId, key);
        tabs.forEach((tab, index) => {
            const selected = tab.key === key;
            buttons[index].classList.toggle("sb-editor-tab-active", selected);
            buttons[index].setAttribute("aria-selected", selected ? "true" : "false");
            tab.panel.hidden = !selected;
        });
    };

    for (const tab of tabs) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "sb-editor-tab";
        button.setAttribute("role", "tab");
        button.append(createIcon(tab.icon));
        const label = document.createElement("span");
        label.textContent = tab.label;
        button.append(label);
        button.addEventListener("click", () => select(tab.key));
        buttons.push(button);
        tablist.append(button);
        panels.append(tab.panel);
    }

    select(tabs.some((tab) => tab.key === remembered) ? remembered : tabs[0].key);
    wrap.append(tablist, panels);
    return wrap;
}

function createTextInput(value, {placeholder = "", className = "sb-editor-input"} = {}) {
    const input = document.createElement("input");
    input.type = "text";
    input.className = className;
    input.value = value;
    input.placeholder = placeholder;
    return input;
}

function createTextarea(value, placeholder = "") {
    const textarea = document.createElement("textarea");
    textarea.className = "sb-editor-textarea";
    textarea.value = value;
    textarea.placeholder = placeholder;
    return textarea;
}

function createActionButton(text, onClick, extraClass = "", iconClass = "") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `sb-action ${extraClass}`.trim();
    if (iconClass) button.append(createIcon(iconClass));
    const label = document.createElement("span");
    label.textContent = text;
    button.append(label);
    button.addEventListener("click", onClick);
    return button;
}
const DRAG_SHIELD_EVENTS = ["pointerdown", "mousedown", "touchstart", "click"];

function shieldPointerDown(event) {
    event.stopPropagation();
}

function installDragShield() {
    for (const type of DRAG_SHIELD_EVENTS) {
        document.addEventListener(type, shieldPointerDown, true);
    }
}

function removeDragShield() {
    setTimeout(() => {
        for (const type of DRAG_SHIELD_EVENTS) {
            document.removeEventListener(type, shieldPointerDown, true);
        }
    }, 0);
}

function attachDragReorder(listEl, itemsOrGetter, rowSelector, onReorder) {
    let dragRow = null;
    let placeholder = null;
    let handleEl = null;
    let pointerId = null;
    let startY = 0;
    let baseTop = 0;
    let dragItem = null;
    const rows = () => [...listEl.children];
    const getItems = () => (typeof itemsOrGetter === "function" ? itemsOrGetter() : itemsOrGetter);

    function onPointerMove(event) {
        if (!dragRow || (pointerId !== null && event.pointerId !== pointerId)) return;
        dragRow.style.top = `${baseTop + (event.clientY - startY)}px`;
        const placeholderIndex = rows().indexOf(placeholder);
        for (const row of rows()) {
            if (row === placeholder) continue;
            const rect = row.getBoundingClientRect();
            const mid = rect.top + rect.height / 2;
            const rowIndex = rows().indexOf(row);
            if (event.clientY < mid && rowIndex < placeholderIndex) {
                row.before(placeholder);
                break;
            }
            if (event.clientY > mid && rowIndex > placeholderIndex) {
                row.after(placeholder);
                break;
            }
        }
    }

    function endDrag() {
        if (!dragRow) return -1;
        document.removeEventListener("pointermove", onPointerMove);
        document.removeEventListener("pointerup", onPointerUp);
        document.removeEventListener("pointercancel", onPointerCancel);
        if (handleEl && pointerId !== null && handleEl.releasePointerCapture) {
            try {
                handleEl.releasePointerCapture(pointerId);
            } catch {

            }
        }
        dragRow.classList.remove("sb-drag-active");
        dragRow.style.cssText = "";
        placeholder.replaceWith(dragRow);
        const endIndex = rows().indexOf(dragRow);
        placeholder = null;
        dragRow = null;
        handleEl = null;
        pointerId = null;
        removeDragShield();
        return endIndex;
    }

    function onPointerUp(event) {
        if (pointerId !== null && event.pointerId !== pointerId) return;
        const endIndex = endDrag();
        const items = getItems();
        const itemIndex = items.indexOf(dragItem);
        if (endIndex !== -1 && itemIndex !== -1 && endIndex !== itemIndex) {
            const [moved] = items.splice(itemIndex, 1);
            items.splice(endIndex, 0, moved);
            onReorder();
        }
        dragItem = null;
    }

    function onPointerCancel(event) {
        if (pointerId !== null && event.pointerId !== pointerId) return;
        endDrag();
        dragItem = null;
    }

    listEl.addEventListener("pointerdown", (event) => {
        if (dragRow) return;
        const handle = event.target.closest(".sb-drag-handle");
        const row = handle?.closest(rowSelector);
        if (!row) return;
        event.preventDefault();

        installDragShield();

        const rect = row.getBoundingClientRect();
        dragRow = row;
        handleEl = handle;
        pointerId = event.pointerId;
        startY = event.clientY;
        baseTop = rect.top;
        const startIndex = rows().indexOf(row);
        dragItem = getItems()[startIndex] ?? null;

        placeholder = document.createElement("div");
        placeholder.className = "sb-drag-placeholder";
        placeholder.style.height = `${rect.height}px`;
        row.replaceWith(placeholder);

        const dragHost = listEl.closest("#left-nav-panel") ?? document.body;
        dragHost.append(dragRow);
        dragRow.classList.add("sb-drag-active");
        Object.assign(dragRow.style, {
            position: "fixed",
            top: `${rect.top}px`,
            left: `${rect.left}px`,
            width: `${rect.width}px`,
            margin: "0",
            zIndex: "1000",
            pointerEvents: "none",
            touchAction: "none",
        });

        if (handle.setPointerCapture) {
            try {
                handle.setPointerCapture(pointerId);
            } catch {

            }
        }

        document.addEventListener("pointermove", onPointerMove);
        document.addEventListener("pointerup", onPointerUp);
        document.addEventListener("pointercancel", onPointerCancel);
    });
}

function renderSelectionEditor(variable, body) {
    const describe = () => `${variable.options.length}개의 값을 구성하고 기본 선택을 지정합니다.`;
    const section = createEditorSection("fa-list-check", "선택지", describe());
    const sectionDescription = section.querySelector(".sb-card-section-description");
    if (variable.type === "multi") {
        const separatorInput = createTextInput(variable.separator, {placeholder: "\\n"});
        separatorInput.addEventListener("change", () => {
            variable.separator = separatorInput.value.slice(0, 40) || "\n";
            persistDefinition();
        });
        section.append(createLabeledField("다중선택 결합 문자", separatorInput, "fa-link"));
    }

    const list = document.createElement("div");
    list.className = "sb-option-list";

    function renderOptionRows() {
        if (sectionDescription) sectionDescription.textContent = describe();
        const fragment = document.createDocumentFragment();

        variable.options.forEach((option, optionIndex) => {
            const row = document.createElement("div");
            row.className = "sb-option-row";
            const labelInput = createTextInput(option.label, {placeholder: `옵션 ${optionIndex + 1}`});
            labelInput.classList.add("sb-option-label-input");
            const valueInput = createTextarea(option.value, "이 옵션을 선택했을 때 {{variable}}에 삽입할 내용");
            valueInput.classList.add("sb-option-value-input");
            labelInput.addEventListener("change", () => {
                option.label = labelInput.value.slice(0, 200) || `옵션 ${optionIndex + 1}`;
                persistDefinition();
                renderRuntimePanel();
            });
            valueInput.addEventListener("change", () => {
                option.value = valueInput.value.slice(0, 20000);
                persistDefinition();
                renderRuntimePanel();
            });

            const defaultLabel = document.createElement("label");
            defaultLabel.className = "sb-default-picker";
            const defaultInput = document.createElement("input");
            defaultInput.type = variable.type === "multi" ? "checkbox" : "radio";
            defaultInput.name = `sb-default-${variable.id}`;
            defaultInput.checked = variable.type === "multi" ? variable.defaultValue.includes(option.id) : variable.defaultValue === option.id;
            defaultInput.addEventListener("change", () => {
                if (variable.type === "multi") {
                    const defaults = new Set(variable.defaultValue);
                    defaultInput.checked ? defaults.add(option.id) : defaults.delete(option.id);
                    variable.defaultValue = [...defaults];
                } else {
                    variable.defaultValue = option.id;
                }
                persistDefinition();
                renderRuntimePanel();
            });
            defaultLabel.append(defaultInput, createIcon("fa-star"));
            const defaultText = document.createElement("span");
            defaultText.textContent = "기본";
            defaultLabel.append(defaultText);

            const remove = createActionButton(
                "삭제",
                () => {
                    variable.options = variable.options.filter((item) => item.id !== option.id);
                    variable.defaultValue = sanitizeRuntimeValue(variable, variable.defaultValue);
                    renderOptionRows();
                    renderRuntimePanel();
                    persistDefinition();
                },
                "sb-action-danger sb-option-remove",
                "fa-trash-can",
            );
            remove.disabled = variable.options.length <= 1;

            const header = document.createElement("div");
            header.className = "sb-option-row-header";
            const index = document.createElement("span");
            index.className = "sb-option-index sb-drag-handle";
            index.style.touchAction = "none";
            index.append(createIcon("fa-grip-vertical"));
            const indexText = document.createElement("span");
            indexText.textContent = String(optionIndex + 1).padStart(2, "0");
            index.append(indexText);
            header.append(index, labelInput, defaultLabel, remove);

            const valueField = document.createElement("div");
            valueField.className = "sb-option-value-field";
            const valueIcon = document.createElement("span");
            valueIcon.className = "sb-option-value-icon";
            valueIcon.append(createIcon("fa-align-left"));
            valueField.append(valueIcon, valueInput);
            row.append(header, valueField);
            fragment.append(row);
        });

        list.replaceChildren(fragment);
    }

    attachDragReorder(list, () => variable.options, ".sb-option-row", () => {
        renderOptionRows();
        renderRuntimePanel();
        persistDefinition();
    });

    const addOption = createActionButton(
        "선택지 추가",
        () => {
            const option = {
                id: makeId("option"),
                label: `옵션 ${String.fromCharCode(65 + Math.min(variable.options.length, 25))}`,
                value: "",
            };
            variable.options.push(option);
            if (!variable.defaultValue && variable.type !== "multi") variable.defaultValue = option.id;
            renderOptionRows();
            renderRuntimePanel();
            persistDefinition();
        },
        "sb-action-primary sb-add-option",
        "fa-plus",
    );

    renderOptionRows();
    section.append(list, addOption);
    body.append(section);
}

const PROMPT_PICKER_SEARCH_DEBOUNCE = 110;

function renderPromptToggleEditor(variable, body) {
    const describe = () =>
        variable.type === "group" ?
            `${variable.promptOptions.length}개 토글을 이 변수에서 관리합니다. 그룹 스위치 탭에서 각 그룹에 담으세요.`
        :   `${variable.promptOptions.length}개 토글을 이 변수에서 관리합니다. 선택한 항목만 ON으로 유지됩니다.`;
    const section = createEditorSection("fa-toggle-on", "토글 제어", describe());
    section.classList.add("sb-prompt-toggle-section");
    const sectionDescription = section.querySelector(".sb-card-section-description");
    const list = document.createElement("div");
    list.className = "sb-prompt-option-list";

    function syncPromptDefault() {
        if (variable.type === "group") {
            for (const group of variable.promptGroups) {
                group.optionIds = variable.promptOptions.filter((option) => group.optionIds.includes(option.id)).map((option) => option.id);
            }
            variable.promptDefaultValue = normalizeGroupSelection(variable.promptDefaultValue, variable.promptGroups, isSingleGroupMode(variable));
            return;
        }
        variable.promptDefaultValue = normalizeSelectionDefault(variable.type, variable.promptDefaultValue, variable.promptOptions, true);
    }

    const groupBadges = new Map();

    function applyGroupBadge(badge, optionId) {
        const memberCount = variable.promptGroups.filter((group) => group.optionIds.includes(optionId)).length;
        badge.className = `sb-prompt-group-badge${memberCount === 0 ? " sb-prompt-group-badge-empty" : ""}`;
        badge.textContent = memberCount === 0 ? "미배정" : `그룹 ${memberCount}개`;
        badge.title = memberCount === 0 ? "어느 그룹에도 속하지 않아 항상 OFF로 유지됩니다." : "이 토글이 속한 그룹 수입니다.";
    }

    function refreshGroupBadge(optionId) {
        const badge = groupBadges.get(optionId);
        if (badge?.isConnected) applyGroupBadge(badge, optionId);
    }

    function renderOptionRows() {
        if (sectionDescription) sectionDescription.textContent = describe();
        const catalogById = new Map(getNativePromptCatalog().map((prompt) => [prompt.identifier, prompt]));
        groupBadges.clear();
        list.replaceChildren();

        if (variable.promptOptions.length === 0) {
            const empty = document.createElement("div");
            empty.className = "sb-prompt-option-empty";
            empty.append(createIcon("fa-toggle-off"));
            const copy = document.createElement("div");
            const title = document.createElement("strong");
            title.textContent = "등록된 토글이 없습니다";
            const description = document.createElement("span");
            description.textContent = "아래 토글 추가 버튼에서 현재 프롬프트의 항목을 선택하세요.";
            copy.append(title, description);
            empty.append(copy);
            list.append(empty);
            return;
        }

        const fragment = document.createDocumentFragment();
        for (const option of variable.promptOptions) {
            const prompt = catalogById.get(option.promptIdentifier);
            const nativeName = prompt?.name ?? option.label;
            const row = document.createElement("div");
            row.className = "sb-prompt-option-row";
            row.dataset.promptIdentifier = option.promptIdentifier;
            const handle = document.createElement("span");
            handle.className = "sb-option-index sb-drag-handle";
            handle.style.touchAction = "none";
            handle.append(createIcon("fa-grip-vertical"));
            const icon = document.createElement("span");
            icon.className = `sb-prompt-state-icon${prompt?.enabled ? " sb-prompt-state-icon-on" : ""}`;
            icon.append(createIcon(prompt?.enabled ? "fa-toggle-on" : "fa-toggle-off"));
            const copy = document.createElement("div");
            copy.className = "sb-prompt-option-copy";
            const nameRow = document.createElement("div");
            nameRow.className = "sb-prompt-option-name";
            const name = document.createElement("strong");
            const applyDisplayLabel = () => {
                name.textContent = option.displayLabel || nativeName;
                name.title =
                    option.displayLabel ?
                        `표시용 라벨 · 실제 토글 이름: ${nativeName}`
                    :   `실제 토글 이름: ${nativeName}`;
                name.classList.toggle("sb-prompt-option-name-custom", Boolean(option.displayLabel));
            };
            applyDisplayLabel();
            const editLabel = document.createElement("button");
            editLabel.type = "button";
            editLabel.className = "sb-prompt-label-edit";
            editLabel.title = "이 패널에서 보여줄 이름을 수정합니다. 실제 토글 이름은 바뀌지 않습니다.";
            editLabel.setAttribute("aria-label", `${nativeName} 표시용 라벨 수정`);
            editLabel.append(createIcon("fa-pen"));
            const beginLabelEdit = () => {
                const input = createTextInput(option.displayLabel, {
                    placeholder: nativeName,
                    className: "sb-editor-input sb-prompt-display-label-input",
                });
                input.maxLength = 300;
                input.setAttribute("aria-label", `${nativeName} 표시용 라벨`);
                input.title = "비워두면 실제 토글 이름을 사용합니다.";
                let settled = false;
                const finish = (save) => {
                    if (settled) return;
                    settled = true;
                    const next = input.value.slice(0, 300).trim();
                    const changed = save && next !== option.displayLabel;
                    if (changed) option.displayLabel = next;
                    applyDisplayLabel();
                    nameRow.replaceChildren(name, editLabel);
                    if (changed) {
                        renderRuntimePanel();
                        persistDefinition();
                    }
                };
                input.addEventListener("keydown", (event) => {
                    if (event.key === "Enter") {
                        event.preventDefault();
                        finish(true);
                    } else if (event.key === "Escape") {
                        event.preventDefault();
                        finish(false);
                    }
                });
                input.addEventListener("blur", () => finish(true));
                nameRow.replaceChildren(input);
                input.focus();
                input.select();
            };
            editLabel.addEventListener("click", beginLabelEdit);
            name.addEventListener("dblclick", beginLabelEdit);
            nameRow.append(name, editLabel);
            const meta = document.createElement("span");
            meta.className = "sb-prompt-state-text";
            meta.textContent =
                prompt ?
                    prompt.enabled ?
                        "현재 ON"
                    :   "현재 OFF"
                :   "현재 프롬프트에서 찾을 수 없음";
            copy.append(nameRow, meta);

            if (variable.type === "group") {
                const badge = document.createElement("span");
                applyGroupBadge(badge, option.id);
                groupBadges.set(option.id, badge);
                const removeFromGroups = createActionButton(
                    "등록 제거",
                    () => {
                        variable.promptOptions = variable.promptOptions.filter((item) => item.id !== option.id);
                        syncPromptDefault();
                        renderOptionRows();
                        renderGroupRows();
                        refreshPickerAvailability();
                        renderRuntimePanel();
                        queueNativePromptSync([variable]);
                        persistDefinition();
                    },
                    "sb-action-danger sb-prompt-option-remove",
                    "fa-xmark",
                );
                row.append(handle, icon, copy, badge, removeFromGroups);
                fragment.append(row);
                continue;
            }

            const defaultLabel = document.createElement("label");
            defaultLabel.className = "sb-default-picker";
            const defaultInput = document.createElement("input");
            defaultInput.type = variable.type === "multi" ? "checkbox" : "radio";
            defaultInput.name = `sb-prompt-default-${variable.id}`;
            defaultInput.checked = variable.type === "multi" ? variable.promptDefaultValue.includes(option.id) : variable.promptDefaultValue === option.id;
            defaultInput.addEventListener("change", () => {
                if (variable.type === "multi") {
                    const defaults = new Set(variable.promptDefaultValue);
                    defaultInput.checked ? defaults.add(option.id) : defaults.delete(option.id);
                    variable.promptDefaultValue = [...defaults];
                } else {
                    variable.promptDefaultValue = option.id;
                }
                persistDefinition();
                renderRuntimePanel();
            });
            defaultLabel.append(defaultInput, createIcon("fa-star"));
            const defaultText = document.createElement("span");
            defaultText.textContent = "기본";
            defaultLabel.append(defaultText);

            const remove = createActionButton(
                "등록 제거",
                () => {
                    variable.promptOptions = variable.promptOptions.filter((item) => item.id !== option.id);
                    syncPromptDefault();
                    renderOptionRows();
                    renderGroupRows();
                    refreshPickerAvailability();
                    renderRuntimePanel();
                    queueNativePromptSync([variable]);
                    persistDefinition();
                },
                "sb-action-danger sb-prompt-option-remove",
                "fa-xmark",
            );
            row.append(handle, icon, copy, defaultLabel, remove);
            fragment.append(row);
        }
        list.append(fragment);
    }

    attachDragReorder(list, () => variable.promptOptions, ".sb-prompt-option-row", () => {
        syncPromptDefault();
        renderOptionRows();
        renderGroupRows();
        renderRuntimePanel();
        queueNativePromptSync([variable]);
        persistDefinition();
    });

    const picker = document.createElement("div");
    picker.className = "sb-prompt-picker";
    picker.hidden = true;
    const pickerHeader = document.createElement("div");
    pickerHeader.className = "sb-prompt-picker-header";
    const pickerTitle = document.createElement("div");
    pickerTitle.className = "sb-prompt-picker-title";
    pickerTitle.append(createIcon("fa-list-check"));
    const pickerTitleText = document.createElement("strong");
    pickerTitleText.textContent = "추가할 토글 선택";
    pickerTitle.append(pickerTitleText);
    const closePicker = createActionButton(
        "닫기",
        () => {
            picker.hidden = true;
            pickerStale = true;
        },
        "sb-prompt-picker-close",
        "fa-xmark",
    );
    pickerHeader.append(pickerTitle, closePicker);

    const searchWrap = document.createElement("label");
    searchWrap.className = "sb-prompt-search";
    searchWrap.append(createIcon("fa-magnifying-glass"));
    const search = createTextInput("", {placeholder: "프롬프트 이름 검색"});
    search.type = "search";
    searchWrap.append(search);
    const pickerList = document.createElement("div");
    pickerList.className = "sb-prompt-picker-list";
    const footer = document.createElement("div");
    footer.className = "sb-prompt-picker-footer";
    const selectionCount = document.createElement("span");
    selectionCount.textContent = "0개 선택";
    const availableCount = document.createElement("span");
    availableCount.className = "sb-prompt-picker-count";

    let available = [];
    let pickerStale = true;
    let searchTimer = null;
    const selected = new Set();

    const updateSelection = () => {
        selectionCount.textContent = `${selected.size}개 선택`;
        availableCount.textContent = `추가 가능 ${available.length}개`;
        addSelected.disabled = selected.size === 0;
    };

    function computeAvailable() {
        const used = new Set(variable.promptOptions.map((option) => option.promptIdentifier));
        const usedByOtherVariables = new Set(currentDefinition.variables.filter((item) => item.id !== variable.id && item.promptToggleMode).flatMap((item) => item.promptOptions.map((option) => option.promptIdentifier)));
        available = getToggleableNativePromptCatalog()
            .filter((prompt) => !used.has(prompt.identifier) && !usedByOtherVariables.has(prompt.identifier))
            .map((prompt) => ({...prompt, search: prompt.name.toLocaleLowerCase()}));
        const availableIds = new Set(available.map((prompt) => prompt.identifier));
        for (const identifier of [...selected]) {
            if (!availableIds.has(identifier)) selected.delete(identifier);
        }
        updateSelection();
    }

    function renderPickerRows() {
        const query = search.value.trim().toLocaleLowerCase();
        const matches = query ? available.filter((prompt) => prompt.search.includes(query)) : available;
        const fragment = document.createDocumentFragment();

        for (const prompt of matches) {
            const isSelected = selected.has(prompt.identifier);
            const row = document.createElement("label");
            row.className = `sb-prompt-picker-row${isSelected ? " sb-prompt-picker-row-selected" : ""}`;
            row.dataset.identifier = prompt.identifier;
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.checked = isSelected;
            const state = document.createElement("span");
            state.className = `sb-prompt-state-dot${prompt.enabled ? " sb-prompt-state-dot-on" : ""}`;
            const copy = document.createElement("span");
            copy.className = "sb-prompt-picker-copy";
            const name = document.createElement("strong");
            name.textContent = prompt.name;
            copy.append(name);
            row.append(checkbox, state, copy);
            fragment.append(row);
        }

        if (matches.length === 0) {
            const empty = document.createElement("div");
            empty.className = "sb-prompt-picker-empty";
            empty.textContent =
                available.length === 0 ?
                    "추가할 수 있는 토글이 없습니다. 다른 토글 변수에 이미 등록된 항목은 여기에 나오지 않습니다."
                :   "검색 결과가 없습니다.";
            fragment.append(empty);
        }

        pickerList.replaceChildren(fragment);
        pickerList.scrollTop = 0;
    }

    function refreshPickerAvailability() {
        if (picker.hidden) {
            pickerStale = true;
            return;
        }
        computeAvailable();
        renderPickerRows();
    }

    pickerList.addEventListener("change", (event) => {
        const checkbox = event.target;
        if (!(checkbox instanceof HTMLInputElement) || checkbox.type !== "checkbox") return;
        const row = checkbox.closest(".sb-prompt-picker-row");
        const identifier = row?.dataset.identifier;
        if (!identifier) return;
        checkbox.checked ? selected.add(identifier) : selected.delete(identifier);
        row.classList.toggle("sb-prompt-picker-row-selected", checkbox.checked);
        updateSelection();
    });

    search.addEventListener("input", () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(renderPickerRows, PROMPT_PICKER_SEARCH_DEBOUNCE);
    });

    const addSelected = createActionButton(
        "선택한 토글 추가",
        () => {
            const additions = available
                .filter((prompt) => selected.has(prompt.identifier))
                .map((prompt) => ({id: makeId("prompt-option"), promptIdentifier: prompt.identifier, label: prompt.name, displayLabel: ""}));
            if (additions.length === 0) return;
            variable.promptOptions.push(...additions);
            syncPromptDefault();
            selected.clear();
            renderOptionRows();
            renderGroupRows();
            computeAvailable();
            renderPickerRows();
            renderRuntimePanel();
            queueNativePromptSync([variable]);
            persistDefinition();
        },
        "sb-action-primary",
        "fa-plus",
    );
    addSelected.disabled = true;
    footer.append(selectionCount, availableCount, addSelected);
    picker.append(pickerHeader, searchWrap, pickerList, footer);

    const addToggle = createActionButton(
        "토글 추가",
        () => {
            if (!picker.hidden) {
                search.focus();
                return;
            }
            computeAvailable();
            pickerStale = false;
            renderPickerRows();
            picker.hidden = false;
            search.focus();
        },
        "sb-action-primary sb-open-prompt-picker",
        "fa-plus",
    );

    const groupSection = createEditorSection("fa-layer-group", "그룹 스위치", "");
    const modeButtons = new Map();
    const groupModeControl = document.createElement("div");
    groupModeControl.className = "sb-group-mode-control";
    groupModeControl.setAttribute("role", "group");
    groupModeControl.setAttribute("aria-label", "그룹 선택 방식");

    const setGroupMode = (mode) => {
        if (variable.groupMode === mode) return;
        variable.groupMode = mode;
        variable.promptDefaultValue = normalizeGroupSelection(variable.promptDefaultValue, variable.promptGroups, mode === "single");
        for (const [key, button] of modeButtons) {
            button.classList.toggle("sb-group-mode-option-active", key === mode);
            button.setAttribute("aria-pressed", key === mode ? "true" : "false");
        }
        renderGroupRows();
        renderRuntimePanel();
        queueNativePromptSync([variable]);
        persistDefinition();
    };

    for (const [mode, text, hint] of [
        ["single", "단일", "그룹 하나만 켜집니다. 다른 그룹을 켜면 이전 그룹이 꺼집니다."],
        ["multi", "다중", "여러 그룹을 동시에 켤 수 있습니다."],
    ]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `sb-group-mode-option${variable.groupMode === mode ? " sb-group-mode-option-active" : ""}`;
        button.textContent = text;
        button.title = hint;
        button.setAttribute("aria-pressed", variable.groupMode === mode ? "true" : "false");
        button.addEventListener("click", () => setGroupMode(mode));
        modeButtons.set(mode, button);
        groupModeControl.append(button);
    }
    groupSection.querySelector(".sb-card-section-header")?.append(groupModeControl);
    groupSection.classList.add("sb-prompt-group-section");
    const groupList = document.createElement("div");
    groupList.className = "sb-prompt-group-list";
    const expandedGroupIds = new Set();

    function renderGroupRows() {
        groupList.replaceChildren();

        if (variable.promptGroups.length === 0) {
            const empty = document.createElement("div");
            empty.className = "sb-prompt-option-empty";
            empty.append(createIcon("fa-layer-group"));
            const copy = document.createElement("div");
            const title = document.createElement("strong");
            title.textContent = "그룹이 없습니다";
            const description = document.createElement("span");
            description.textContent = "아래 그룹 추가 버튼으로 스위치를 만들고, 등록한 토글을 담으세요.";
            copy.append(title, description);
            empty.append(copy);
            groupList.append(empty);
            return;
        }

        const catalogById = new Map(getNativePromptCatalog().map((prompt) => [prompt.identifier, prompt]));
        const fragment = document.createDocumentFragment();

        variable.promptGroups.forEach((group, groupIndex) => {
            const row = document.createElement("div");
            row.className = "sb-prompt-group-row";
            const header = document.createElement("div");
            header.className = "sb-prompt-group-header";
            const handle = document.createElement("span");
            handle.className = "sb-option-index sb-drag-handle";
            handle.style.touchAction = "none";
            handle.append(createIcon("fa-grip-vertical"));
            const handleText = document.createElement("span");
            handleText.textContent = String(groupIndex + 1).padStart(2, "0");
            handle.append(handleText);

            const labelInput = createTextInput(group.label, {placeholder: `그룹 ${groupIndex + 1}`});
            labelInput.classList.add("sb-option-label-input");
            labelInput.title = "런타임 패널의 스위치에 표시할 이름입니다.";
            labelInput.addEventListener("change", () => {
                group.label = labelInput.value.slice(0, 200) || `그룹 ${groupIndex + 1}`;
                labelInput.value = group.label;
                renderRuntimePanel();
                persistDefinition();
            });

            const defaultLabel = document.createElement("label");
            defaultLabel.className = "sb-default-picker";
            const defaultInput = document.createElement("input");
            defaultInput.type = "checkbox";
            defaultInput.checked = variable.promptDefaultValue.includes(group.id);
            defaultInput.addEventListener("change", () => {
                if (isSingleGroupMode(variable)) {
                    variable.promptDefaultValue = defaultInput.checked ? [group.id] : [];
                    renderGroupRows();
                } else {
                    const defaults = new Set(variable.promptDefaultValue);
                    defaultInput.checked ? defaults.add(group.id) : defaults.delete(group.id);
                    variable.promptDefaultValue = normalizeGroupSelection([...defaults], variable.promptGroups);
                }
                renderRuntimePanel();
                queueNativePromptSync([variable]);
                persistDefinition();
            });
            defaultLabel.append(defaultInput, createIcon("fa-star"));
            const defaultText = document.createElement("span");
            defaultText.textContent = "기본 ON";
            defaultLabel.append(defaultText);

            const remove = createActionButton(
                "그룹 삭제",
                () => {
                    if (!globalThis.confirm(`“${group.label}” 그룹을 삭제할까요? 등록된 토글은 그대로 남습니다.`)) return;
                    variable.promptGroups = variable.promptGroups.filter((item) => item.id !== group.id);
                    variable.promptDefaultValue = normalizeGroupSelection(variable.promptDefaultValue, variable.promptGroups, isSingleGroupMode(variable));
                    renderOptionRows();
                    renderGroupRows();
                    renderRuntimePanel();
                    queueNativePromptSync([variable]);
                    persistDefinition();
                },
                "sb-action-danger sb-prompt-option-remove",
                "fa-trash-can",
            );
            const membersWrap = document.createElement("div");
            membersWrap.className = "sb-prompt-group-members-wrap sb-prompt-group-members-idle";
            membersWrap.id = `sb-group-members-${group.id}`;
            const members = document.createElement("div");
            members.className = "sb-prompt-group-members";
            membersWrap.append(members);

            let membersBuilt = false;
            const buildMembers = () => {
                if (membersBuilt) return;
                membersBuilt = true;
                if (variable.promptOptions.length === 0) {
                    const hint = document.createElement("div");
                    hint.className = "sb-prompt-group-hint";
                    hint.textContent = "먼저 위에서 토글을 등록하면 여기에 담을 수 있습니다.";
                    members.append(hint);
                    return;
                }
                const memberFragment = document.createDocumentFragment();
                for (const option of variable.promptOptions) {
                    const member = document.createElement("label");
                    member.className = "sb-prompt-group-member";
                    const checkbox = document.createElement("input");
                    checkbox.type = "checkbox";
                    checkbox.checked = group.optionIds.includes(option.id);
                    checkbox.addEventListener("change", () => {
                        const membership = new Set(group.optionIds);
                        checkbox.checked ? membership.add(option.id) : membership.delete(option.id);
                        group.optionIds = variable.promptOptions.filter((item) => membership.has(item.id)).map((item) => item.id);
                        member.classList.toggle("sb-prompt-group-member-on", checkbox.checked);
                        updateExpandLabel();
                        refreshGroupBadge(option.id);
                        renderRuntimePanel();
                        queueNativePromptSync([variable]);
                        persistDefinition();
                    });
                    const name = document.createElement("span");
                    name.textContent = getPromptOptionDisplayLabel(option, catalogById);
                    member.append(checkbox, name);
                    member.classList.toggle("sb-prompt-group-member-on", checkbox.checked);
                    memberFragment.append(member);
                }
                members.append(memberFragment);
            };

            const expandButton = document.createElement("button");
            expandButton.type = "button";
            expandButton.className = "sb-prompt-group-expand";
            expandButton.setAttribute("aria-controls", membersWrap.id);
            const expandCount = document.createElement("span");
            expandCount.className = "sb-prompt-group-expand-count";
            expandButton.append(expandCount, createIcon("fa-chevron-down"));

            const updateExpandLabel = () => {
                expandCount.textContent = `토글 ${group.optionIds.length}`;
                expandButton.title = expandedGroupIds.has(group.id) ? "담긴 토글 접기" : "담긴 토글 편집";
            };

            const setExpanded = (expanded) => {
                if (expanded) {
                    buildMembers();
                    expandedGroupIds.add(group.id);
                } else {
                    expandedGroupIds.delete(group.id);
                }
                membersWrap.classList.toggle("sb-prompt-group-members-idle", !expanded);
                row.classList.toggle("sb-prompt-group-row-open", expanded);
                expandButton.setAttribute("aria-expanded", expanded ? "true" : "false");
                updateExpandLabel();
            };

            expandButton.addEventListener("click", () => setExpanded(!expandedGroupIds.has(group.id)));
            setExpanded(expandedGroupIds.has(group.id));

            header.append(handle, labelInput, expandButton, defaultLabel, remove);

            row.append(header, membersWrap);
            fragment.append(row);
        });

        groupList.append(fragment);
    }

    attachDragReorder(groupList, () => variable.promptGroups, ".sb-prompt-group-row", () => {
        variable.promptDefaultValue = normalizeGroupSelection(variable.promptDefaultValue, variable.promptGroups, isSingleGroupMode(variable));
        renderGroupRows();
        renderRuntimePanel();
        persistDefinition();
    });

    const addGroup = createActionButton(
        "그룹 추가",
        () => {
            variable.promptGroups.push({
                id: makeId("prompt-group"),
                label: `그룹 ${String.fromCharCode(65 + Math.min(variable.promptGroups.length, 25))}`,
                optionIds: [],
            });
            renderOptionRows();
            renderGroupRows();
            renderRuntimePanel();
            persistDefinition();
        },
        "sb-action-primary sb-add-option",
        "fa-plus",
    );
    groupSection.append(groupList, addGroup);

    renderOptionRows();
    section.append(list, addToggle, picker);
    if (variable.type !== "group") {
        body.append(section);
        return;
    }
    renderGroupRows();
    body.append(
        createEditorTabs(variable.id, [
            {key: "toggles", label: "토글 제어", icon: "fa-toggle-on", panel: section},
            {key: "groups", label: "그룹 스위치", icon: "fa-layer-group", panel: groupSection},
        ]),
    );
}

function renderToggleEditor(variable, body) {
    const section = createEditorSection("fa-toggle-on", "스위치", "ON과 OFF 상태에서 삽입할 내용을 설정합니다.");
    const defaultRow = document.createElement("div");
    defaultRow.className = "sb-switch-row";
    const defaultCopy = document.createElement("span");
    defaultCopy.className = "sb-switch-copy";
    defaultCopy.append(createIcon("fa-power-off"));
    const defaultText = document.createElement("span");
    defaultText.textContent = "프롬프트 기본 상태";
    defaultCopy.append(defaultText);
    const switchLabel = document.createElement("label");
    switchLabel.className = "sb-switch";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = variable.defaultValue;
    const track = document.createElement("span");
    track.className = "sb-switch-track";
    checkbox.addEventListener("change", () => {
        variable.defaultValue = checkbox.checked;
        persistDefinition();
        renderRuntimePanel();
    });
    switchLabel.append(checkbox, track);
    defaultRow.append(defaultCopy, switchLabel);

    const grid = document.createElement("div");
    grid.className = "sb-editor-grid";
    const onValue = createTextarea(variable.onValue, "ON일 때 삽입할 내용");
    const offValue = createTextarea(variable.offValue, "OFF일 때 삽입할 내용");
    onValue.addEventListener("change", () => {
        variable.onValue = onValue.value.slice(0, 20000);
        persistDefinition();
    });
    offValue.addEventListener("change", () => {
        variable.offValue = offValue.value.slice(0, 20000);
        persistDefinition();
    });
    grid.append(createLabeledField("ON 값", onValue, "fa-toggle-on"), createLabeledField("OFF 값", offValue, "fa-toggle-off"));
    section.append(defaultRow, grid);
    body.append(section);
}

function renderInputEditor(variable, body) {
    const section = createEditorSection("fa-keyboard", "텍스트", "변수의 기본값와 설명을 설정합니다.");
    const grid = document.createElement("div");
    grid.className = "sb-editor-grid";
    const defaultInput = createTextInput(variable.defaultValue, {placeholder: "기본값"});
    const placeholderInput = createTextInput(variable.placeholder, {placeholder: "설명"});
    defaultInput.maxLength = 10000;
    placeholderInput.maxLength = 300;
    defaultInput.addEventListener("change", () => {
        variable.defaultValue = defaultInput.value.slice(0, 10000);
        persistDefinition();
        renderRuntimePanel();
    });
    placeholderInput.addEventListener("change", () => {
        variable.placeholder = placeholderInput.value.slice(0, 300);
        persistDefinition();
        renderRuntimePanel();
    });
    grid.append(createLabeledField("기본값", defaultInput, "fa-star"), createLabeledField("Placeholder", placeholderInput, "fa-message"));
    section.append(grid);
    body.append(section);
}

function renderVariableCard(variable) {
    const details = document.createElement("details");
    details.className = "sb-variable-card";
    details.open = expandedVariableIds.has(variable.id);
    details.addEventListener("toggle", () => {
        details.open ? expandedVariableIds.add(variable.id) : expandedVariableIds.delete(variable.id);
    });

    const summary = document.createElement("summary");
    summary.className = "sb-variable-summary";
    const dragHandle = document.createElement("span");
    dragHandle.className = "sb-variable-drag-handle sb-drag-handle";
    dragHandle.style.touchAction = "none";
    dragHandle.append(createIcon("fa-grip-vertical"));
    dragHandle.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
    });
    const leading = document.createElement("span");
    leading.className = "sb-variable-leading-icon";
    const heading = document.createElement("span");
    heading.className = "sb-variable-heading";
    const label = document.createElement("span");
    label.className = "sb-variable-summary-label";
    label.textContent = variable.label;
    const macro = document.createElement("code");
    macro.className = "sb-variable-macro";
    macro.textContent = getVariableMacroLabel(variable);
    heading.append(label, macro);
    const type = document.createElement("span");
    type.className = "sb-type-chip";
    type.append(createIcon(TYPE_ICONS[variable.type]));
    const typeText = document.createElement("span");
    typeText.textContent = TYPE_LABELS[variable.type];
    type.append(typeText);
    const visibility = document.createElement("button");
    visibility.type = "button";
    const visibilityIcon = createIcon("fa-eye");
    visibility.append(visibilityIcon);
    const applyVisibilityState = () => {
        visibility.className = `sb-variable-control sb-variable-visibility${variable.runtimeHidden ? " sb-variable-visibility-hidden" : ""}`;
        visibility.title = variable.runtimeHidden ? "런타임 패널에 표시" : "런타임 패널에서 숨기기";
        visibility.setAttribute("aria-label", visibility.title);
        visibility.setAttribute("aria-pressed", variable.runtimeHidden ? "true" : "false");
        visibilityIcon.classList.toggle("fa-eye-slash", variable.runtimeHidden);
        visibilityIcon.classList.toggle("fa-eye", !variable.runtimeHidden);
    };
    applyVisibilityState();
    visibility.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        variable.runtimeHidden = !variable.runtimeHidden;
        applyVisibilityState();
        renderRuntimePanel();
        persistDefinition();
    });
    const pin = document.createElement("button");
    pin.type = "button";
    pin.append(createIcon("fa-thumbtack"));
    const applyPinState = () => {
        pin.className = `sb-variable-control sb-variable-pin${variable.pinned ? " sb-variable-pin-active" : ""}`;
        pin.title = variable.pinned ? "런타임 상단 고정 해제" : "런타임 상단에 고정";
        pin.setAttribute("aria-label", pin.title);
        pin.setAttribute("aria-pressed", variable.pinned ? "true" : "false");
    };
    applyPinState();
    pin.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        variable.pinned = !variable.pinned;
        applyPinState();
        renderRuntimePanel();
        persistDefinition();
    });
    const chevron = document.createElement("span");
    chevron.className = "sb-variable-chevron";
    chevron.append(createIcon("fa-chevron-right"));
    summary.append(dragHandle, leading, heading, type, visibility, pin, chevron);

    const body = document.createElement("div");
    body.className = "sb-variable-body";
    const basics = createEditorSection("fa-sliders", "기본 설정", variable.promptToggleMode ? "표시 이름과 프롬프트 선택 방식을 관리합니다." : "표시 이름, 변수 이름과 입력 방식을 관리합니다.");
    const modeControl = document.createElement("label");
    modeControl.className = `sb-mode-control${variable.promptToggleMode ? " sb-mode-control-active" : ""}`;
    modeControl.title = "변수 치환 대신 등록한 프롬프트 토글을 ON/OFF합니다.";
    const modeCopy = document.createElement("span");
    modeCopy.className = "sb-mode-control-copy";
    const modeText = document.createElement("span");
    modeText.textContent = "토글 제어";
    modeCopy.append(modeText);
    const modeSwitch = document.createElement("span");
    modeSwitch.className = "sb-switch";
    const modeInput = document.createElement("input");
    modeInput.type = "checkbox";
    modeInput.checked = variable.promptToggleMode;
    const modeTrack = document.createElement("span");
    modeTrack.className = "sb-switch-track";
    modeSwitch.append(modeInput, modeTrack);
    modeControl.append(modeCopy, modeSwitch);
    basics.querySelector(".sb-card-section-header")?.append(modeControl);
    const grid = document.createElement("div");
    grid.className = "sb-editor-grid";
    const labelInput = createTextInput(variable.label, {placeholder: "사용자에게 보일 이름"});
    const keyInput = createTextInput(variable.key, {placeholder: "variable_name"});
    const keyControl = document.createElement("div");
    keyControl.className = "sb-key-control";
    const setvarControl = document.createElement("label");
    setvarControl.className = `sb-setvar-control${variable.setvarMode ? " sb-setvar-control-active" : ""}`;
    setvarControl.title = "체크하면 {{변수명}} 대신 같은 이름의 {{setvar::변수명::값}} 쓰기를 막고 {{getvar::변수명}}에 이 확장 값을 사용합니다.";
    const setvarInput = document.createElement("input");
    setvarInput.type = "checkbox";
    setvarInput.checked = variable.setvarMode;
    const setvarText = document.createElement("span");
    setvarText.textContent = "setvar";
    setvarControl.append(setvarInput, setvarText);
    keyControl.append(keyInput, setvarControl);
    const typeSelect = document.createElement("select");
    typeSelect.className = "sb-editor-select";
    const availableTypes = variable.promptToggleMode ? PROMPT_TYPE_ORDER : VARIABLE_TYPE_ORDER;
    for (const value of availableTypes) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = TYPE_LABELS[value];
        option.selected = variable.type === value;
        typeSelect.append(option);
    }

    labelInput.addEventListener("change", () => {
        variable.label = labelInput.value.slice(0, 200) || "이름 없는 변수";
        label.textContent = variable.label;
        persistDefinition();
        renderRuntimePanel();
    });
    keyInput.addEventListener("change", () => {
        const candidate = keyInput.value.trim();
        if (!MACRO_NAME_PATTERN.test(candidate)) {
            notify("warning", "변수 이름은 영문자로 시작하고 영문·숫자·밑줄·하이픈만 사용할 수 있습니다.");
            keyInput.value = variable.key;
            return;
        }
        const availability = isMacroNameAvailable(candidate, variable.id);
        if (!availability.ok) {
            notify("warning", availability.message);
            keyInput.value = variable.key;
            return;
        }
        variable.key = candidate;
        macro.textContent = getVariableMacroLabel(variable);
        refreshMacros();
        renderSettingsWarnings();
        renderRuntimePanel();
        persistDefinition();
    });
    setvarInput.addEventListener("change", () => {
        if (setvarInput.checked && variable.key === "toJSON") {
            setvarInput.checked = false;
            notify("warning", "toJSON은 SillyTavern 저장 처리에 사용되는 이름이라 setvar 모드로 지정할 수 없습니다.");
            return;
        }
        variable.setvarMode = setvarInput.checked;
        refreshMacros();
        renderSettingsEditor();
        renderRuntimePanel();
        persistDefinition();
    });
    modeInput.addEventListener("change", () => {
        if (variable.promptToggleMode) variable.promptType = variable.type;
        else variable.variableType = variable.type;
        variable.promptToggleMode = modeInput.checked;
        variable.type = variable.promptToggleMode ? variable.promptType : variable.variableType;
        variable.promptDefaultValue =
            variable.promptType === "group" ?
                normalizeGroupSelection(variable.promptDefaultValue, variable.promptGroups, isSingleGroupMode(variable))
            :   normalizeSelectionDefault(variable.promptType, variable.promptDefaultValue, variable.promptOptions, true);
        refreshMacros();
        renderSettingsEditor();
        renderRuntimePanel();
        queueNativePromptSync([variable]);
        persistDefinition();
    });
    typeSelect.addEventListener("change", () => {
        variable.type = typeSelect.value;
        if (variable.promptToggleMode) {
            variable.promptType = variable.type;
            variable.promptDefaultValue =
                variable.type === "group" ?
                    normalizeGroupSelection(variable.promptDefaultValue, variable.promptGroups, isSingleGroupMode(variable))
                :   normalizeSelectionDefault(variable.type, null, variable.promptOptions, true);
        } else {
            variable.variableType = variable.type;
            variable.defaultValue = normalizeVariableDefault(variable.type, null, variable.options);
        }
        renderSettingsEditor();
        renderRuntimePanel();
        if (variable.promptToggleMode) queueNativePromptSync([variable]);
        persistDefinition();
    });
    grid.append(createLabeledField("표시 이름", labelInput, "fa-tag"));
    if (!variable.promptToggleMode) grid.append(createLabeledField("변수 이름", keyControl, "fa-code"));
    grid.append(createLabeledField("종류", typeSelect, "fa-shapes"));
    basics.append(grid);
    body.append(basics);

    if (variable.promptToggleMode) renderPromptToggleEditor(variable, body);
    else if (["dropdown", "single", "multi"].includes(variable.type)) renderSelectionEditor(variable, body);
    else if (variable.type === "toggle") renderToggleEditor(variable, body);
    else if (variable.type === "input") renderInputEditor(variable, body);

    const actions = document.createElement("div");
    actions.className = "sb-card-actions";
    const copy = createActionButton(
        "변수명",
        async () => {
            try {
                const syntax = getVariableMacroLabel(variable);
                await navigator.clipboard.writeText(syntax);
                notify("success", `${syntax} 복사됨`);
            } catch {
                notify("warning", "클립보드에 복사하지 못했습니다.");
            }
        },
        "sb-action-primary",
        "fa-copy",
    );
    const remove = createActionButton(
        "삭제",
        () => {
            if (!globalThis.confirm(`“${variable.label}” 변수를 삭제할까요?`)) return;
            currentDefinition.variables = currentDefinition.variables.filter((item) => item.id !== variable.id);
            expandedVariableIds.delete(variable.id);
            refreshMacros();
            renderSettingsEditor();
            renderRuntimePanel();
            updateRuntimeButton();
            persistDefinition();
        },
        "sb-action-danger",
        "fa-trash-can",
    );
    if (!variable.promptToggleMode) actions.append(copy);
    actions.append(remove);
    body.append(actions);
    details.append(summary, body);
    return details;
}

function ensureSettingsUI() {
    const anchor = document.getElementById(SETTINGS_ANCHOR_ID);
    if (!anchor) return null;
    if (settingsContainer?.isConnected) {
        if (settingsContainer.nextElementSibling !== anchor) anchor.before(settingsContainer);
        return settingsContainer;
    }

    settingsContainer = document.createElement("div");
    settingsContainer.id = SETTINGS_ID;
    settingsContainer.className = "sb-settings-root";
    settingsContainer.innerHTML = `
        <details class="sb-settings-shell">
            <summary class="sb-settings-header">
                <span class="sb-settings-mark"><i class="fa-solid fa-sliders"></i></span>
                <span class="sb-settings-heading">
                    <span class="sb-settings-title">Switch Binder</span>
                    <span class="sb-settings-subtitle">Preset variables &amp; chat controls</span>
                </span>
                <i class="sb-settings-chevron fa-solid fa-chevron-down"></i>
            </summary>
            <div class="sb-settings-content">
                <div class="sb-settings-toolbar">
                    <div id="prompt_controls_settings_preset" class="sb-settings-preset"></div>
                    <button id="prompt_controls_reload" type="button" class="sb-action"><i class="fa-solid fa-rotate"></i></button>
                    <button id="prompt_controls_theme_toggle" type="button" class="sb-action" aria-pressed="false" title="다크 모드로 전환"><i class="fa-solid fa-moon"></i></button>
                </div>
                <p class="sb-help">현재 프롬프트에 변수를 정의합니다. 프롬프트에 {{variable}}을 넣고 입력창 왼쪽의 슬라이더 버튼에서 값을 선택하세요.</p>
                <div class="sb-transfer-panel">
                    <div class="sb-transfer-heading">
                        <span class="sb-transfer-icon"><i class="fa-solid fa-arrow-right-arrow-left"></i></span>
                        <span><strong>유저 설정 관리</strong><small>프롬프트 변수 설정 복사 · 관리</small></span>
                    </div>
                    <div class="sb-transfer-actions">
                        <div id="prompt_controls_copy_target_wrap" class="sb-searchable-select">
                            <label class="sb-prompt-search sb-editor-select sb-searchable-select-field">
                                <i class="fa-solid fa-magnifying-glass"></i>
                                <input id="prompt_controls_copy_target_search" type="text" placeholder="복사해올 프롬프트 선택" autocomplete="off">
                                <button type="button" id="prompt_controls_copy_target_clear" class="sb-searchable-select-clear" tabindex="-1" hidden><i class="fa-solid fa-xmark"></i></button>
                            </label>
                            <div id="prompt_controls_copy_target_list" class="sb-prompt-picker-list sb-searchable-select-list" hidden></div>
                        </div>
                        <button id="prompt_controls_copy" type="button" class="sb-action"><i class="fa-solid fa-copy"></i></button>
                        <button id="prompt_controls_import" type="button" class="sb-action sb-action-primary"><i class="fa-solid fa-file-import"></i></button>
                        <button id="prompt_controls_export" type="button" class="sb-action"><i class="fa-solid fa-file-export"></i></button>                        
                        <input id="prompt_controls_import_file" type="file" accept="application/json,.json" hidden>
                    </div>
                </div>
                <div id="prompt_controls_settings_warnings"></div>
                <div id="prompt_controls_variable_list" class="sb-variable-list"></div>
                <button id="prompt_controls_add" type="button" class="sb-action sb-action-primary"><i class="fa-solid fa-plus"></i><span>변수 추가</span></button>
                <div id="prompt_controls_save_status" class="sb-save-status"></div>
            </div>
        </details>`;
    anchor.before(settingsContainer);
    settingsContainer.querySelector(".sb-settings-shell")?.addEventListener("toggle", () => {
        setTimeout(flushPendingSettingsRender, 0);
    });
    settingsContainer.querySelector("#prompt_controls_reload")?.addEventListener("click", loadCurrentPreset);
    settingsContainer.querySelector("#prompt_controls_theme_toggle")?.addEventListener("click", toggleTheme);
    settingsContainer.querySelector("#prompt_controls_add")?.addEventListener("click", createVariable);
    settingsContainer.querySelector("#prompt_controls_copy")?.addEventListener("click", copyDefinitionToPreset);
    settingsContainer.querySelector("#prompt_controls_copy_target_search")?.addEventListener("focus", () => {
    settingsContainer.querySelector("#prompt_controls_copy_target_list")?.removeAttribute("hidden");
    });
    settingsContainer.querySelector("#prompt_controls_copy_target_list")?.addEventListener("mousedown", (event) => {
        event.preventDefault();
    });
    document.addEventListener("click", (event) => {
        const wrap = settingsContainer?.querySelector("#prompt_controls_copy_target_wrap");
        if (wrap && !wrap.contains(event.target)) wrap.querySelector("#prompt_controls_copy_target_list")?.setAttribute("hidden", "");
    });
    settingsContainer.querySelector("#prompt_controls_copy_target_wrap")?.addEventListener("focusout", (event) => {
        const wrap = event.currentTarget;
        setTimeout(() => {
            if (!wrap.contains(document.activeElement)) {
                wrap.querySelector("#prompt_controls_copy_target_list")?.setAttribute("hidden", "");
            }
        }, 0);
    });
    settingsContainer.querySelector("#prompt_controls_copy_target_clear")?.addEventListener("click", () => {
        const wrap = settingsContainer.querySelector("#prompt_controls_copy_target_wrap");
        const search = settingsContainer.querySelector("#prompt_controls_copy_target_search");
        const listEl = settingsContainer.querySelector("#prompt_controls_copy_target_list");
        const clearBtn = settingsContainer.querySelector("#prompt_controls_copy_target_clear");
        const copyBtn = settingsContainer.querySelector("#prompt_controls_copy");
        if (!wrap || !search) return;
        search.value = "";
        wrap.dataset.value = "";
        if (copyBtn) copyBtn.disabled = true;
        clearBtn.hidden = true;
        listEl.hidden = true;
        search.focus();
    });
    settingsContainer.querySelector("#prompt_controls_export")?.addEventListener("click", exportCurrentDefinition);
    settingsContainer.querySelector("#prompt_controls_import")?.addEventListener("click", () => {
        settingsContainer.querySelector("#prompt_controls_import_file")?.click();
    });
    settingsContainer.querySelector("#prompt_controls_import_file")?.addEventListener("change", (event) => {
        const input = event.currentTarget;
        importDefinitionFile(input.files?.[0]);
        input.value = "";
    });
    return settingsContainer;
}

function ensureSettingsPlacementObserver() {
    if (!document.body) return;
    const anchor = document.getElementById(SETTINGS_ANCHOR_ID);
    const target = anchor?.parentElement ?? document.body;
    if (settingsPlacementObserver && settingsPlacementTarget === target && target.isConnected) return;
    settingsPlacementObserver?.disconnect();
    settingsPlacementTarget = target;
    settingsPlacementObserver = new MutationObserver(() => {
        const currentAnchor = document.getElementById(SETTINGS_ANCHOR_ID);
        if (!currentAnchor) return;
        if (currentAnchor.parentElement && currentAnchor.parentElement !== settingsPlacementTarget) {
            ensureSettingsPlacementObserver();
        }
        const needsPlacement = !settingsContainer?.isConnected || settingsContainer.nextElementSibling !== currentAnchor;
        if (!needsPlacement) return;
        ensureSettingsUI();
        renderSettingsEditor();
    });
    settingsPlacementObserver.observe(target, {childList: true, subtree: target === document.body});
}

function syncPromptToggleLabels() {
    const catalog = getNativePromptCatalog();
    if (catalog.length === 0) return false;
    const catalogById = new Map(catalog.map((prompt) => [prompt.identifier, prompt]));
    let changed = false;
    for (const variable of currentDefinition.variables) {
        if (!variable.promptToggleMode) continue;
        for (const option of variable.promptOptions) {
            const liveName = catalogById.get(option.promptIdentifier)?.name;
            if (liveName && liveName !== option.label) {
                option.label = liveName;
                changed = true;
            }
        }
    }
    return changed;
}

function ensurePromptCatalogObserver() {
    const list = getPromptManagerList();
    if (!list) return;
    if (promptCatalogObserver && observedPromptCatalogList === list && list.isConnected) return;
    promptCatalogObserver?.disconnect();
    observedPromptCatalogList = list;
    promptCatalogObserver = new MutationObserver(() => {
        if (suppressCatalogSync) return;
        clearTimeout(promptCatalogSyncTimer);
        promptCatalogSyncTimer = setTimeout(() => {
            if (!syncPromptToggleLabels()) return;
            renderSettingsEditor();
            renderRuntimePanel();
            persistDefinition();
        }, 120);
    });
    promptCatalogObserver.observe(list, {childList: true, subtree: true});
}

function renderSettingsWarnings() {
    const target = document.getElementById("prompt_controls_settings_warnings");
    if (!target) return;
    target.replaceChildren();
    for (const warning of [...macroWarnings, ...importWarnings]) {
        const item = document.createElement("div");
        item.className = "sb-warning";
        item.textContent = warning;
        target.append(item);
    }
}

function ensureSettingsVisibilityObserver(container) {
    if (typeof IntersectionObserver !== "function") return false;
    if (settingsVisibilityObserver && observedSettingsContainer === container && container.isConnected) return true;
    settingsVisibilityObserver?.disconnect();
    observedSettingsContainer = container;
    settingsVisibilityObserver = new IntersectionObserver((entries) => {
        if (!settingsEditorDirty) return;
        if (!entries.some((entry) => entry.isIntersecting)) return;
        renderSettingsEditor();
    }, {rootMargin: "600px"});
    settingsVisibilityObserver.observe(container);
    return true;
}

function flushPendingSettingsRender() {
    if (!settingsEditorDirty) return;
    if (!isElementVisible(settingsContainer)) return;
    renderSettingsEditor();
}

function renderSettingsEditor() {
    const container = ensureSettingsUI();
    if (!container) return;
    if (ensureSettingsVisibilityObserver(container) && !isElementVisible(container)) {
        settingsEditorDirty = true;
        return;
    }
    settingsEditorDirty = false;
    const preset = container.querySelector("#prompt_controls_settings_preset");
    const addButton = container.querySelector("#prompt_controls_add");
    const copyTargetWrap = container.querySelector("#prompt_controls_copy_target_wrap");
    const copyTargetSearch = container.querySelector("#prompt_controls_copy_target_search");
    const copyTargetList = container.querySelector("#prompt_controls_copy_target_list");
    const copyTargetClear = container.querySelector("#prompt_controls_copy_target_clear");
    const copyButton = container.querySelector("#prompt_controls_copy");
    const exportButton = container.querySelector("#prompt_controls_export");
    const importButton = container.querySelector("#prompt_controls_import");
    const list = container.querySelector("#prompt_controls_variable_list");
    if (!preset || !list) return;
    preset.textContent = currentPresetName ? `현재 프롬프트: ${currentPresetName}` : "사용 가능한 프롬프트가 없습니다.";
    if (addButton) addButton.disabled = !currentPresetKey;
    if (exportButton) exportButton.disabled = !currentPresetKey;
    if (importButton) importButton.disabled = !currentPresetKey;
    if (copyTargetWrap && copyTargetSearch && copyTargetList) {
        const info = getPresetInfo();
        const names = (info?.manager?.getAllPresets?.() ?? []).filter((name) => name !== currentPresetName);
        const disabled = !currentPresetKey || names.length === 0;

        copyTargetWrap.dataset.value = "";
        copyTargetSearch.value = "";
        copyTargetSearch.disabled = disabled;
        copyTargetSearch.placeholder = disabled ? "복사해올 프롬프트 없음" : "복사해올 프롬프트 선택";
        if (copyButton) copyButton.disabled = true;
        if (copyTargetClear) copyTargetClear.hidden = true;

        copyTargetList.replaceChildren();
        copyTargetList.hidden = true;
        const rows = [];
        for (const name of names) {
            const row = document.createElement("div");
            row.className = "sb-prompt-picker-row";
            row.dataset.search = name.toLocaleLowerCase();
            row.textContent = name;
            row.addEventListener("click", () => {
                copyTargetWrap.dataset.value = name;
                copyTargetSearch.value = name;
                copyTargetList.hidden = true;
                if (copyButton) copyButton.disabled = false;
                if (copyTargetClear) copyTargetClear.hidden = false;
            });
            rows.push(row);
            copyTargetList.append(row);
        }

        copyTargetSearch.oninput = () => {
            copyTargetWrap.dataset.value = "";
            if (copyButton) copyButton.disabled = true;
            const query = copyTargetSearch.value.trim().toLocaleLowerCase();
            for (const row of rows) row.hidden = Boolean(query) && !row.dataset.search.includes(query);
            copyTargetList.hidden = false;
            if (copyTargetClear) copyTargetClear.hidden = copyTargetSearch.value.length === 0;
        };
    }
    list.replaceChildren();
    renderSettingsWarnings();

    if (!currentPresetKey) {
        const empty = document.createElement("div");
        empty.className = "sb-empty";
        empty.textContent = "API와 프롬프트를 선택한 뒤 변수를 추가할 수 있습니다.";
        list.append(empty);
        setSaveStatus("");
        return;
    }
    if (currentDefinition.variables.length === 0) {
        const empty = document.createElement("div");
        empty.className = "sb-empty";
        empty.textContent = "아직 변수가 없습니다. “변수 추가”를 눌러 시작하세요.";
        list.append(empty);
    } else {
        currentDefinition.variables.forEach((variable) => list.append(renderVariableCard(variable)));
    }
    if (!list.dataset.dragReorderAttached) {
        list.dataset.dragReorderAttached = "true";
        attachDragReorder(list, () => currentDefinition.variables, ".sb-variable-card", () => {
            renderSettingsEditor();
            renderRuntimePanel();
            persistDefinition();
        });
    }
    setSaveStatus(`“${currentPresetName}” 프롬프트에서 불러옴`);
}

function updateFavoriteButtonState() {
    const button = document.getElementById('prompt_controls_save_favorite');
    if (!button) return;

    if (currentDefinition.favorites.length === 0) {
        activeFavoriteId = '';
        button.classList.remove('sb-action-favorited');
        return;
    }

    const snapshot = currentDefinition.variables.map(v => [v.id, JSON.stringify(getRawValue(v))]);

    const matchingFavorite = currentDefinition.favorites.find(favorite =>
        snapshot.every(([id, value]) => value === JSON.stringify(favorite.values[id])),
    );

    activeFavoriteId = matchingFavorite ? matchingFavorite.id : '';

    button.classList.toggle('sb-action-favorited', Boolean(activeFavoriteId));
}

function ensureRuntimePanel() {
    if (runtimePanel?.isConnected) return runtimePanel;
    runtimePanel = document.createElement("section");
    runtimePanel.id = PANEL_ID;
    runtimePanel.setAttribute("role", "dialog");
    runtimePanel.setAttribute("aria-modal", "false");
    runtimePanel.setAttribute("aria-label", "Switch Binder");
    runtimePanel.innerHTML = `
        <div class="sb-runtime-header">
            <span class="sb-runtime-mark"><i class="fa-solid fa-sliders"></i></span>
            <div class="sb-runtime-heading">
                <div class="sb-runtime-title">Switch Binder</div>
                <div id="prompt_controls_runtime_preset" class="sb-runtime-preset"></div>
            </div>
            <button id="prompt_controls_close" type="button" class="sb-icon-button" title="닫기" aria-label="닫기"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div id="prompt_controls_runtime_body" class="sb-runtime-body"></div>
        <div class="sb-runtime-footer">
            <button id="prompt_controls_favorite_manage" type="button" class="sb-icon-button" title="프리셋 관리"><i class="fa-solid fa-gear"></i></button>
            <div class="sb-runtime-footer-right">
                <button id="prompt_controls_reset" type="button" class="sb-action"><i class="fa-solid fa-arrow-rotate-left"></i></button>
                <button id="prompt_controls_save_favorite" type="button" class="sb-action"><i class="fa-solid fa-star"></i></button>
                <button id="prompt_controls_save_defaults" type="button" class="sb-action sb-action-primary"><i class="fa-solid fa-floppy-disk"></i></button>
            </div>
        </div>`;
    document.body.append(runtimePanel);
    
    runtimePanel.querySelector("#prompt_controls_close")?.addEventListener("click", closeRuntimePanel);
    runtimePanel.querySelector("#prompt_controls_reset")?.addEventListener("click", resetChatValues);
    runtimePanel.querySelector("#prompt_controls_save_defaults")?.addEventListener("click", saveCurrentValuesAsDefaults);
    
    runtimePanel.querySelector('#prompt_controls_favorite_manage')?.addEventListener('click', event => {
        favoriteDeleteMode = !favoriteDeleteMode;
        event.currentTarget.classList.toggle('sb-action-favorited', favoriteDeleteMode);
        renderRuntimePanel();
    });
    runtimePanel.querySelector('#prompt_controls_save_favorite')?.addEventListener('click', () => {
        if (activeFavoriteId) {
            const favorite = currentDefinition.favorites.find(item => item.id === activeFavoriteId);
            if (favorite && globalThis.confirm(`“${favorite.name}” 프리셋을 삭제(해제)할까요?`)) {
                deleteFavorite(favorite.id);
            }
            return;
        }
        
        const favoriteName = globalThis.prompt("프리셋 이름을 입력하세요:");
        
        if (favoriteName !== null) {
            saveCurrentValuesAsFavorite(favoriteName);
        }
    });

    return runtimePanel;
}

function createRuntimeLabel(variable) {
    const label = document.createElement("label");
    label.className = "sb-runtime-label";
    const copy = document.createElement("span");
    copy.className = "sb-runtime-label-copy";
    if (variable.pinned) copy.append(createIcon("fa-thumbtack"));
    const text = document.createElement("span");
    text.textContent = variable.label;
    copy.append(text);
    const macro = document.createElement("span");
    macro.className = "sb-runtime-macro";
    macro.textContent = getVariableMacroLabel(variable);
    label.append(copy, macro);
    return label;
}

function closeRuntimeDropdown() {
    openRuntimeDropdown?.close();
}

function createRuntimeDropdown(variable, options, raw, promptCatalog) {
    const labelOf = (option) => (variable.promptToggleMode ? getPromptOptionDisplayLabel(option, promptCatalog) : option.label);
    let selectedId = raw;

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = "sb-select sb-dropdown-trigger";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    const value = document.createElement("span");
    value.className = "sb-dropdown-value";
    trigger.append(value, createIcon("fa-chevron-down"));

    const syncTrigger = () => {
        const selected = options.find((option) => option.id === selectedId);
        value.textContent = selected ? labelOf(selected) : "선택 안 함";
        value.classList.toggle("sb-dropdown-value-empty", !selected);
    };
    syncTrigger();

    const openMenu = () => {
        closeRuntimeDropdown();

        const menu = document.createElement("div");
        menu.className = "sb-dropdown-menu";
        menu.setAttribute("role", "listbox");

        const rows = options.map((option) => {
            const isSelected = option.id === selectedId;
            const row = document.createElement("button");
            row.type = "button";
            row.className = `sb-dropdown-option${isSelected ? " sb-dropdown-option-selected" : ""}`;
            row.setAttribute("role", "option");
            row.setAttribute("aria-selected", isSelected ? "true" : "false");
            row.tabIndex = -1;
            const text = document.createElement("span");
            text.className = "sb-dropdown-option-label";
            text.textContent = labelOf(option);
            row.append(text, createIcon("fa-check"));
            row.addEventListener("click", () => {
                selectedId = option.id;
                setRawValue(variable, option.id);
                syncTrigger();
                close();
                trigger.focus();
            });
            menu.append(row);
            return row;
        });

        document.body.append(menu);

        const position = () => {
            const rect = trigger.getBoundingClientRect();
            const margin = 8;
            const gap = 4;
            const limit = 260;
            menu.style.width = `${rect.width}px`;
            menu.style.left = `${Math.max(margin, Math.min(rect.left, window.innerWidth - rect.width - margin))}px`;

            const below = window.innerHeight - rect.bottom - gap - margin;
            const above = rect.top - gap - margin;

            menu.style.maxHeight = `${limit}px`;
            const natural = menu.offsetHeight;

            const placeAbove = natural > below && above > below;
            const room = Math.max(96, placeAbove ? above : below);
            menu.style.maxHeight = `${Math.min(natural, room)}px`;

            if (placeAbove) {
                menu.style.top = `${Math.max(margin, rect.top - gap - menu.offsetHeight)}px`;
                menu.classList.add("sb-dropdown-menu-above");
            } else {
                menu.style.top = `${rect.bottom + gap}px`;
                menu.classList.remove("sb-dropdown-menu-above");
            }
        };

        const reposition = () => {
            if (!trigger.isConnected) {
                close();
                return;
            }
            position();
        };

        function close() {
            window.removeEventListener("resize", reposition);
            window.removeEventListener("scroll", reposition, true);
            menu.remove();
            trigger.setAttribute("aria-expanded", "false");
            if (openRuntimeDropdown?.trigger === trigger) openRuntimeDropdown = null;
        }

        const focusRow = (index) => {
            if (rows.length === 0) return;
            rows[(index + rows.length) % rows.length].focus();
        };

        menu.addEventListener("keydown", (event) => {
            const index = rows.indexOf(document.activeElement);
            if (event.key === "ArrowDown") {
                event.preventDefault();
                focusRow(index + 1);
            } else if (event.key === "ArrowUp") {
                event.preventDefault();
                focusRow(index - 1);
            } else if (event.key === "Home") {
                event.preventDefault();
                focusRow(0);
            } else if (event.key === "End") {
                event.preventDefault();
                focusRow(rows.length - 1);
            } else if (event.key === "Escape") {
                event.preventDefault();
                close();
                trigger.focus();
            } else if (event.key === "Tab") {
                close();
            }
        });

        position();
        window.addEventListener("resize", reposition);
        window.addEventListener("scroll", reposition, true);
        trigger.setAttribute("aria-expanded", "true");
        openRuntimeDropdown = {trigger, menu, close};

        const selectedIndex = options.findIndex((option) => option.id === selectedId);
        focusRow(selectedIndex >= 0 ? selectedIndex : 0);
    };

    trigger.addEventListener("click", () => {
        if (openRuntimeDropdown?.trigger === trigger) {
            closeRuntimeDropdown();
            return;
        }
        openMenu();
    });
    trigger.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        if (openRuntimeDropdown?.trigger !== trigger) openMenu();
    });

    return trigger;
}

function renderRuntimeSelection(variable, field) {
    const raw = getRawValue(variable);
    const options = getVariableOptions(variable);
    const promptCatalog = variable.promptToggleMode ? new Map(getNativePromptCatalog().map((prompt) => [prompt.identifier, prompt])) : null;

    if (variable.promptToggleMode && variable.type !== "multi" && options.length === 1) {
        renderSinglePromptToggle(variable, options[0], field, promptCatalog);
        return;
    }

    if (variable.type === "dropdown") {
        field.append(createRuntimeDropdown(variable, options, raw, promptCatalog));
        return;
    }

    const list = document.createElement("div");
    list.className = "sb-choice-list";
    for (const option of options) {
        const choice = document.createElement("label");
        choice.className = "sb-choice";
        const input = document.createElement("input");
        input.type = variable.type === "multi" ? "checkbox" : "radio";
        input.name = `sb-runtime-${variable.id}`;
        input.checked = variable.type === "multi" ? raw.includes(option.id) : raw === option.id;
        input.addEventListener("change", () => {
            if (variable.type === "multi") {
                const selected = new Set(getRawValue(variable));
                input.checked ? selected.add(option.id) : selected.delete(option.id);
                setRawValue(variable, [...selected]);
            } else if (input.checked) {
                setRawValue(variable, option.id);
            }
        });
        const copy = document.createElement("span");
        copy.className = "sb-choice-copy";
        const optionLabel = document.createElement("span");
        optionLabel.className = "sb-choice-label";
        optionLabel.textContent = variable.promptToggleMode ? getPromptOptionDisplayLabel(option, promptCatalog) : option.label;
        copy.append(optionLabel);
        if (!variable.promptToggleMode && option.value) {
            const preview = document.createElement("span");
            preview.className = "sb-choice-preview";
            preview.textContent = option.value;
            copy.append(preview);
        }
        choice.append(input, copy);
        list.append(choice);
    }
    field.append(list);
}

function renderRuntimeToggle(variable, field) {
    const row = document.createElement("div");
    row.className = "sb-switch-row";
    const stateText = document.createElement("span");
    stateText.textContent = getRawValue(variable) ? "ON" : "OFF";
    const switchLabel = document.createElement("label");
    switchLabel.className = "sb-switch";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = getRawValue(variable);
    const track = document.createElement("span");
    track.className = "sb-switch-track";
    checkbox.addEventListener("change", () => {
        if (setRawValue(variable, checkbox.checked)) stateText.textContent = checkbox.checked ? "ON" : "OFF";
    });
    switchLabel.append(checkbox, track);
    row.append(stateText, switchLabel);
    field.append(row);
}

function renderSinglePromptToggle(variable, option, field, promptCatalog) {
    const row = document.createElement("div");
    row.className = "sb-switch-row";
    const stateCopy = document.createElement("span");
    stateCopy.className = "sb-switch-state-copy";
    const optionLabel = document.createElement("span");
    optionLabel.className = "sb-switch-option-label";
    optionLabel.textContent = getPromptOptionDisplayLabel(option, promptCatalog);
    const stateText = document.createElement("span");
    stateText.className = "sb-switch-state-text";
    const isOn = getRawValue(variable) === option.id;
    stateText.textContent = isOn ? "ON" : "OFF";
    const switchLabel = document.createElement("label");
    switchLabel.className = "sb-switch";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = isOn;
    const track = document.createElement("span");
    track.className = "sb-switch-track";
    checkbox.addEventListener("change", () => {
        const nextValue = checkbox.checked ? option.id : "";
        if (setRawValue(variable, nextValue)) stateText.textContent = checkbox.checked ? "ON" : "OFF";
    });
    switchLabel.append(checkbox, track);
    stateCopy.append(optionLabel, stateText);
    row.append(stateCopy, switchLabel);
    field.append(row);
}

function renderSingleGroupToggle(variable, group, field) {
    const row = document.createElement("div");
    row.className = "sb-switch-row";
    const stateCopy = document.createElement("span");
    stateCopy.className = "sb-switch-state-copy";
    const groupLabel = document.createElement("span");
    groupLabel.className = "sb-switch-option-label";
    groupLabel.textContent = group.label;
    groupLabel.title = group.label;
    const stateText = document.createElement("span");
    stateText.className = "sb-switch-state-text";
    const isOn = getRawValue(variable).includes(group.id);
    stateText.textContent = isOn ? "ON" : "OFF";
    const switchLabel = document.createElement("label");
    switchLabel.className = "sb-switch";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = isOn;
    const track = document.createElement("span");
    track.className = "sb-switch-track";
    checkbox.addEventListener("change", () => {
        const next = checkbox.checked ? [group.id] : [];
        if (setRawValue(variable, next)) stateText.textContent = checkbox.checked ? "ON" : "OFF";
        else checkbox.checked = !checkbox.checked;
    });
    switchLabel.append(checkbox, track);
    stateCopy.append(groupLabel, stateText);
    row.append(stateCopy, switchLabel);
    field.append(row);
}

function renderRuntimePromptGroups(variable, field) {
    if (variable.promptGroups.length === 0) {
        const message = document.createElement("div");
        message.className = "sb-message";
        message.textContent = "이 변수에 만들어 둔 그룹이 없습니다.";
        field.append(message);
        return;
    }

    if (variable.promptGroups.length === 1) {
        renderSingleGroupToggle(variable, variable.promptGroups[0], field);
        return;
    }

    const single = isSingleGroupMode(variable);
    const raw = getRawValue(variable);
    const list = document.createElement("div");
    list.className = "sb-choice-list";
    for (const group of variable.promptGroups) {
        const choice = document.createElement("label");
        choice.className = "sb-choice";
        const input = document.createElement("input");
        input.type = single ? "radio" : "checkbox";
        input.name = `sb-runtime-group-${variable.id}`;
        input.checked = raw.includes(group.id);
        input.addEventListener("change", () => {
            if (single) {
                if (input.checked) setRawValue(variable, [group.id]);
                return;
            }
            const enabled = new Set(getRawValue(variable));
            input.checked ? enabled.add(group.id) : enabled.delete(group.id);
            const next = variable.promptGroups.filter((item) => enabled.has(item.id)).map((item) => item.id);
            if (!setRawValue(variable, next)) input.checked = !input.checked;
        });
        const copy = document.createElement("span");
        copy.className = "sb-choice-copy";
        const groupLabel = document.createElement("span");
        groupLabel.className = "sb-choice-label";
        groupLabel.textContent = group.label;
        groupLabel.title = group.label;
        copy.append(groupLabel);
        choice.append(input, copy);
        list.append(choice);
    }
    field.append(list);
}

function renderRuntimeInput(variable, field) {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "sb-input";
    input.value = getRawValue(variable);
    input.placeholder = variable.placeholder;
    input.maxLength = 10000;
    input.addEventListener("input", () => setRawValue(variable, input.value));
    field.append(input);
}

function renderRuntimeFavorites(body) {
    const section = document.createElement("div");
    section.className = "sb-runtime-favorites";

    for (const favorite of currentDefinition.favorites) {
        const row = document.createElement('div');
        row.className = 'sb-runtime-favorite-row';

        if (favoriteDeleteMode) {
            const removeBadge = document.createElement('button');
            removeBadge.type = 'button';
            removeBadge.className = 'sb-favorite-remove-badge';
            removeBadge.append(createIcon('fa-xmark'));
            removeBadge.addEventListener('click', event => {
                event.stopPropagation();
                if (globalThis.confirm(`“${favorite.name}” 프리셋을 삭제할까요?`)) deleteFavorite(favorite.id);
            });
            row.append(removeBadge);
        }

        const applyButton = document.createElement('button');
        applyButton.type = 'button';
        applyButton.className = 'sb-action';
        applyButton.append(createIcon('fa-bolt'));
        const label = document.createElement('span');
        label.textContent = favorite.name;
        applyButton.append(label);
        applyButton.disabled = favoriteDeleteMode;
        applyButton.addEventListener('click', () => applyFavorite(favorite.id));

        row.append(applyButton);
        section.append(row);
    }

    body.append(section);
}

function renderRuntimePanel() {
    closeRuntimeDropdown();
    const panel = ensureRuntimePanel();
    if (!panel.classList.contains("sb-open")) {
        updateFavoriteButtonState();
        return;
    }
    const preset = panel.querySelector("#prompt_controls_runtime_preset");
    const body = panel.querySelector("#prompt_controls_runtime_body");
    const reset = panel.querySelector("#prompt_controls_reset");
    const saveDefaults = panel.querySelector("#prompt_controls_save_defaults");
    if (!preset || !body) return;
    preset.textContent = currentPresetName || "프롬프트 없음";
    body.replaceChildren();
    const available = Boolean(currentPresetKey && hasActiveChat());
    if (reset) reset.disabled = !available || currentDefinition.variables.length === 0;
    if (saveDefaults) saveDefaults.disabled = !available || currentDefinition.variables.length === 0;

    if (!currentPresetKey) {
        const message = document.createElement("div");
        message.className = "sb-message";
        message.textContent = "먼저 API와 프롬프트를 선택하세요.";
        body.append(message);
        return;
    }
    if (!hasActiveChat()) {
        const message = document.createElement("div");
        message.className = "sb-message";
        message.textContent = "채팅을 열면 변수 값을 선택할 수 있습니다.";
        body.append(message);
        return;
    }
    if (currentDefinition.variables.length === 0) {
        const message = document.createElement("div");
        message.className = "sb-message";
        message.textContent = "이 프롬프트에 할당된 Switch Binder 변수가 없습니다.";
        body.append(message);
        return;
    }

    renderRuntimeFavorites(body);

    const runtimeVariables = currentDefinition.variables.filter(isVariableVisibleInRuntime);
    if (runtimeVariables.length === 0) {
        const message = document.createElement("div");
        message.className = "sb-message";
        message.textContent = "런타임 패널에 표시하도록 설정된 변수가 없습니다.";
        body.append(message);
        updateFavoriteButtonState();
        return;
    }

    const pinned = runtimeVariables.filter((variable) => variable.pinned);
    const regular = runtimeVariables.filter((variable) => !variable.pinned);
    for (const [label, icon, variables] of [
        ["고정 변수", "fa-thumbtack", pinned],
        ["나머지 변수", "fa-layer-group", regular],
    ]) {
        if (variables.length === 0) continue;
        if (pinned.length && regular.length) {
            const groupLabel = document.createElement("div");
            groupLabel.className = "sb-runtime-group-label";
            groupLabel.append(createIcon(icon));
            const text = document.createElement("span");
            text.textContent = label;
            groupLabel.append(text);
            body.append(groupLabel);
        }
        for (const variable of variables) {
            const field = document.createElement("div");
            field.className = `sb-runtime-field${variable.pinned ? " sb-runtime-field-pinned" : ""}`;
            field.append(createRuntimeLabel(variable));
            if (["dropdown", "single", "multi"].includes(variable.type)) renderRuntimeSelection(variable, field);
            if (variable.type === "group") renderRuntimePromptGroups(variable, field);
            if (variable.type === "toggle") renderRuntimeToggle(variable, field);
            if (variable.type === "input") renderRuntimeInput(variable, field);
            body.append(field);
        }
    }
    updateFavoriteButtonState();
}

function saveCurrentValuesAsFavorite(name) {
    if (!currentPresetKey || !hasActiveChat()) return;
    const trimmedName = asString(name, 100).trim() || `프리셋 ${currentDefinition.favorites.length + 1}`;
    const values = Object.fromEntries(
        currentDefinition.variables.map(variable => [variable.id, cloneData(getRawValue(variable))]),
    );
    const existing = currentDefinition.favorites.find(item => item.name === trimmedName);
    
    if (existing) {
        existing.values = values;
        activeFavoriteId = existing.id;
        notify('success', `“${trimmedName}” 프리셋을 덮어썼습니다.`);
    } else {
        const favorite = { id: makeId('favorite'), name: trimmedName, values };
        currentDefinition.favorites.push(favorite);
        activeFavoriteId = favorite.id;
    }
    
    renderRuntimePanel();
    persistDefinition({ announce: true });
}

function deleteFavorite(favoriteId) {
    const index = currentDefinition.favorites.findIndex(item => item.id === favoriteId);
    if (index === -1) return;
    const [removed] = currentDefinition.favorites.splice(index, 1);
    if (activeFavoriteId === favoriteId) activeFavoriteId = '';
    renderRuntimePanel();
    persistDefinition({ announce: true });
    notify('success', `“${removed.name}” 프리셋을 삭제했습니다.`);
}

function applyFavorite(favoriteId) {
    const favorite = currentDefinition.favorites.find((item) => item.id === favoriteId);
    const presetState = getChatPresetState({create: true});
    if (!favorite || !presetState) {
        notify("warning", "먼저 채팅을 열어주세요.");
        return;
    }
    const changed = [];
    for (const variable of currentDefinition.variables) {
        if (!Object.hasOwn(favorite.values, variable.id)) continue;
        const target = variable.promptToggleMode ? presetState.promptValues : presetState.values;
        target[variable.id] = sanitizeRuntimeValue(variable, favorite.values[variable.id]);
        changed.push(variable);
    }
    saveChatMetadata();
    queueNativePromptSync(changed);
    activeFavoriteId = favoriteId;
    renderRuntimePanel();
    notify("success", `“${favorite.name}” 프리셋을 적용했습니다.`);
}

function resetChatValues() {
    const context = getContext();
    const root = context?.chatMetadata?.[CHAT_STATE_KEY];
    if (root?.presets && currentPresetKey) {
        delete root.presets[currentPresetKey];
        saveChatMetadata();
    }
    renderRuntimePanel();
    queueNativePromptSync();
    notify("success", "이 채팅의 변수 값을 프롬프트 기본값으로 되돌렸습니다.");
}

function saveCurrentValuesAsDefaults() {
    if (!currentPresetKey || !hasActiveChat()) return;
    for (const variable of currentDefinition.variables) {
        setVariableDefaultValue(variable, cloneData(getRawValue(variable)));
    }
    renderSettingsEditor();
    renderRuntimePanel();
    persistDefinition({announce: true});
}

function positionRuntimePanel() {
    if (!runtimePanel?.classList.contains("sb-open") || !runtimeButton) return;
    const buttonRect = runtimeButton.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const margin = 8;
    const gap = 8;
    const panelWidth = Math.min(400, viewportWidth - margin * 2);
    const availableHeight = Math.max(0, buttonRect.top - gap - margin);
    const left = Math.max(margin, Math.min(buttonRect.left, viewportWidth - panelWidth - margin));
    runtimePanel.style.width = `${panelWidth}px`;
    runtimePanel.style.left = `${left}px`;
    runtimePanel.style.right = "auto";
    runtimePanel.style.top = "auto";
    runtimePanel.style.bottom = `${Math.max(margin, window.innerHeight - buttonRect.top + gap)}px`;
    runtimePanel.style.maxHeight = `${Math.min(680, availableHeight)}px`;
}

function handleWindowResize() {
    if (resizeFrame) return;
    resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0;
        positionRuntimePanel();
    });
}

function openRuntimePanel() {
    ensureRuntimePanel();
    runtimePanel.classList.add("sb-open");
    renderRuntimePanel();
    runtimeButton?.setAttribute("aria-expanded", "true");
    positionRuntimePanel();
}

function closeRuntimePanel() {
    closeRuntimeDropdown();
    runtimePanel?.classList.remove("sb-open");
    runtimeButton?.setAttribute("aria-expanded", "false");
}

function toggleRuntimePanel() {
    if (runtimePanel?.classList.contains("sb-open")) closeRuntimePanel();
    else openRuntimePanel();
}

function ensureRuntimeButton() {
    const leftForm = document.querySelector("#nonQRFormItems > #leftSendForm");
    if (!leftForm) return null;
    runtimeButton = document.getElementById(BUTTON_ID);
    if (!runtimeButton) {
        runtimeButton = document.createElement("div");
        runtimeButton.id = BUTTON_ID;
        runtimeButton.className = "fa-solid fa-sliders interactable";
        runtimeButton.title = "Switch Binder";
        runtimeButton.setAttribute("role", "button");
        runtimeButton.setAttribute("tabindex", "0");
        runtimeButton.setAttribute("aria-haspopup", "dialog");
        runtimeButton.setAttribute("aria-expanded", "false");
        runtimeButton.addEventListener("click", toggleRuntimePanel);
        runtimeButton.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                toggleRuntimePanel();
            }
        });
    }
    if (leftForm.lastElementChild !== runtimeButton) leftForm.append(runtimeButton);

    if (!leftFormObserver) {
        leftFormObserver = new MutationObserver(() => {
            if (runtimeButton?.isConnected && leftForm.lastElementChild !== runtimeButton) {
                leftForm.append(runtimeButton);
            }
        });
        leftFormObserver.observe(leftForm, {childList: true});
    }
    updateRuntimeButton();
    return runtimeButton;
}

function updateRuntimeButton() {
    if (!runtimeButton) return;
    const count = currentDefinition.variables.length;
    runtimeButton.classList.toggle("sb-has-variables", count > 0);
    runtimeButton.title = count > 0 ? `Switch Binder · ${count}개 변수` : "Switch Binder · 설정된 변수 없음";
}

function bindStEvent(type, handler) {
    const context = getContext();
    if (!type || !context?.eventSource?.on) return;
    context.eventSource.on(type, handler);
    stEventBindings.push({type, handler});
}

function handleDocumentPointerDown(event) {
    if (openRuntimeDropdown) {
        if (openRuntimeDropdown.menu.contains(event.target)) return;
        if (!openRuntimeDropdown.trigger.contains(event.target)) closeRuntimeDropdown();
    }
    if (!runtimePanel?.classList.contains("sb-open")) return;
    if (runtimePanel.contains(event.target) || runtimeButton?.contains(event.target)) return;
    closeRuntimePanel();
}

function handleDocumentKeyDown(event) {
    if (event.key !== "Escape") return;
    if (openRuntimeDropdown) {
        closeRuntimeDropdown();
        return;
    }
    closeRuntimePanel();
}

function initialize() {
    if (initialized) return;
    initialized = true;
    ensureRuntimePanel();
    ensureRuntimeButton();
    ensureSettingsPlacementObserver();
    ensurePromptCatalogObserver();
    ensureSettingsUI();
    syncThemeWithStTheme({force: true});

    const events = getEventTypes();
    bindStEvent(events.PRESET_CHANGED, () => schedulePresetReload(50));
    bindStEvent(events.MAIN_API_CHANGED, () => schedulePresetReload(100));
    bindStEvent(events.CHAT_CHANGED, () => {
        activeFavoriteId = '';
        restoreSetvarBindings();
        renderRuntimePanel();
        schedulePresetReload(150);
    });
    bindStEvent(events.CHAT_COMPLETION_PROMPT_READY, (eventData) => {
        if (!eventData?.dryRun) return;
        releaseNativePromptRenderLock();
        refreshOpenPromptInspector();
        if (nativePromptRenderPending) scheduleSettlePromptRender();
    });
    bindStEvent(events.SETTINGS_UPDATED, () => syncThemeWithStTheme());
    document.addEventListener("pointerdown", handleDocumentPointerDown);
    document.addEventListener("keydown", handleDocumentKeyDown);
    document.addEventListener("click", handlePromptInspectorClick, true);
    document.addEventListener("change", handleStThemeSelectChange, true);
    window.addEventListener("resize", handleWindowResize);
    window.addEventListener("pagehide", cleanup, {once: true});
    loadCurrentPreset();
    console.log("[Switch Binder] Loaded.");
}

function cleanup() {
    if (!initialized) return;
    initialized = false;
    clearTimeout(reloadTimer);
    clearTimeout(nativePromptRenderTimer);
    nativePromptRenderInFlight = false;
    nativePromptRenderPending = false;
    restoreSetvarBindings();
    unregisterMacros();
    leftFormObserver?.disconnect();
    leftFormObserver = null;
    settingsPlacementObserver?.disconnect();
    settingsPlacementObserver = null;
    promptCatalogObserver?.disconnect();
    promptCatalogObserver = null;
    observedPromptCatalogList = null;
    settingsPlacementTarget = null;
    suppressCatalogSync = false;
    nativeCatalogCache = null;
    toggleableCatalogCache = null;
    pendingSave = null;
    lastPersistedPayload = "";
    lastPersistedKey = "";
    clearTimeout(promptCatalogSyncTimer);
    const context = getContext();
    for (const {type, handler} of stEventBindings.splice(0)) {
        context?.eventSource?.removeListener?.(type, handler);
    }
    document.removeEventListener("pointerdown", handleDocumentPointerDown);
    document.removeEventListener("keydown", handleDocumentKeyDown);
    document.removeEventListener("click", handlePromptInspectorClick, true);
    document.removeEventListener("change", handleStThemeSelectChange, true);
    window.removeEventListener("resize", handleWindowResize);
    if (resizeFrame) cancelAnimationFrame(resizeFrame);
    resizeFrame = 0;
    clearTimeout(nativePromptRenderWatchdog);
    nativePromptRenderWatchdog = null;
    clearTimeout(nativePromptSettleTimer);
    nativePromptSettleTimer = null;
    lightRenderInFlight = false;
    lightRenderPending = false;
    settingsVisibilityObserver?.disconnect();
    settingsVisibilityObserver = null;
    observedSettingsContainer = null;
    runtimePanelDirty = false;
    settingsEditorDirty = false;
    closeRuntimeDropdown();
    runtimePanel?.remove();
    runtimeButton?.remove();
    settingsContainer?.remove();
    runtimePanel = null;
    runtimeButton = null;
    settingsContainer = null;
    inspectedPromptIdentifier = "";
    activeStThemeName = "";
}

function boot() {
    const context = getContext();
    const appReady = getEventTypes(context).APP_READY;
    if (document.querySelector("#nonQRFormItems > #leftSendForm") && document.body) {
        initialize();
    } else if (appReady && context?.eventSource?.on) {
        context.eventSource.on(appReady, initialize);
    } else {
        setTimeout(boot, 250);
    }
}

boot();
