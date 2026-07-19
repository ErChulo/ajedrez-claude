// Theme persistence — applies a theme to <html data-theme="..."> and CSS vars on root.
// v1.12 also persists piece style alongside theme.

import { THEMES, DEFAULT_THEME, THEME_NAMES } from "./themes";
import { DEFAULT_PIECE_STYLE, PIECE_STYLE_IDS, type PieceStyleId } from "@/types";
import type { ThemeName } from "@/types";

const KEY = "ajedrez:theme";
const PIECE_STYLE_KEY = "ajedrez:piece-style";

function isThemeName(v: unknown): v is ThemeName {
  return typeof v === "string" && (THEME_NAMES as readonly string[]).includes(v);
}

function isPieceStyleId(v: unknown): v is PieceStyleId {
  return typeof v === "string" && (PIECE_STYLE_IDS as readonly string[]).includes(v as PieceStyleId);
}

export function getStoredTheme(): ThemeName {
  try {
    const raw = localStorage.getItem(KEY);
    if (isThemeName(raw)) return raw;
  } catch { /* ignore */ }
  return DEFAULT_THEME;
}

export function getStoredPieceStyle(): PieceStyleId {
  try {
    const raw = localStorage.getItem(PIECE_STYLE_KEY);
    if (isPieceStyleId(raw)) return raw;
  } catch { /* ignore */ }
  return DEFAULT_PIECE_STYLE;
}

export function applyStoredTheme(): void {
  applyTheme(getStoredTheme());
}

export function applyTheme(name: ThemeName): void {
  const theme = THEMES[name] ?? THEMES[DEFAULT_THEME];
  const root = document.documentElement;
  root.setAttribute("data-theme", theme.name);
  // Apply CSS vars explicitly so JS-driven callers (game controller) can re-apply after reset.
  const style = root.style;
  for (const [k, v] of Object.entries(theme.cssVars)) {
    style.setProperty(k, v);
  }
}

export function saveTheme(name: ThemeName): void {
  try { localStorage.setItem(KEY, name); } catch { /* ignore */ }
  applyTheme(name);
}

export function savePieceStyle(id: PieceStyleId): void {
  try { localStorage.setItem(PIECE_STYLE_KEY, id); } catch { /* ignore */ }
}
