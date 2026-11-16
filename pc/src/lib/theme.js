/**
 * [Input] The user's appearance preference (auto/light/dark) persisted in localStorage
 * and the OS `prefers-color-scheme` media query.
 * [Output] Resolved theme state on `document.documentElement.dataset.theme` plus a
 * subscribable store for React; "auto" tracks the OS live and persists nothing.
 * [Pos] theme node in pc/src/lib
 * [Sync] If this file changes, update `pc/src/.folder.md`.
 */

const THEME_STORAGE_KEY = "pet-manager.theme-preference";
const THEMES = ["auto", "light", "dark"];

function safeLocalStorage() {
  try {
    return window.localStorage || null;
  } catch {
    return null;
  }
}

function normalizePreference(value) {
  return THEMES.includes(value) ? value : "auto";
}

function readStoredPreference() {
  const storage = safeLocalStorage();
  return normalizePreference(storage ? storage.getItem(THEME_STORAGE_KEY) : "");
}

function systemPrefersDark() {
  return Boolean(
    typeof window !== "undefined"
      && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

function resolveTheme(preference) {
  return preference === "auto" ? (systemPrefersDark() ? "dark" : "light") : preference;
}

function applyTheme(theme) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
}

let currentPreference = "auto";
let currentTheme = "light";
const listeners = new Set();

function notify() {
  for (const listener of listeners) {
    try {
      listener({ preference: currentPreference, theme: currentTheme });
    } catch (error) {
      console.warn("[theme]", "listener_failed", error?.name);
    }
  }
}

const systemDarkQuery = typeof window !== "undefined" && typeof window.matchMedia === "function"
  ? window.matchMedia("(prefers-color-scheme: dark)")
  : null;

function handleSystemChange() {
  if (currentPreference !== "auto") return;
  const next = resolveTheme("auto");
  if (next === currentTheme) return;
  currentTheme = next;
  applyTheme(currentTheme);
  notify();
}

if (systemDarkQuery) {
  const add = typeof systemDarkQuery.addEventListener === "function"
    ? systemDarkQuery.addEventListener.bind(systemDarkQuery)
    : null;
  if (add) add("change", handleSystemChange);
}

export function getThemeState() {
  return { preference: currentPreference, theme: currentTheme };
}

export function setThemePreference(preference) {
  const next = normalizePreference(preference);
  currentPreference = next;
  const storage = safeLocalStorage();
  try {
    if (next === "auto") storage && storage.removeItem(THEME_STORAGE_KEY);
    else storage && storage.setItem(THEME_STORAGE_KEY, next);
  } catch (error) {
    console.warn("[theme]", "persist_failed", error?.name);
  }
  currentTheme = resolveTheme(next);
  applyTheme(currentTheme);
  notify();
  return getThemeState();
}

export function subscribeTheme(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Apply the persisted choice immediately so first paint matches; the inline
// script in index.html already set data-theme to avoid a light flash — this
// reconciles store state with whatever that script found.
currentPreference = readStoredPreference();
currentTheme = resolveTheme(currentPreference);
applyTheme(currentTheme);
