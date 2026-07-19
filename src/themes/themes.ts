// A theme is a palette + 3D tuning, applied atomically via CSS vars + Three.js materials.

import type { ThemeData } from "@/types";

export const THEMES: Record<string, ThemeData> = {
  wood: {
    name: "wood",
    cssVars: {
      "--bg": "#1a120a",
      "--panel": "#211910",
      "--panel-2": "#2c2117",
      "--text": "#f1e7d2",
      "--text-dim": "#a99478",
      "--accent": "#e6b168",
      "--accent-2": "#8fbb6a",
      // Saturated board squares with bigger visual gap so pieces pop.
      "--light-sq": "#e3c193",
      "--dark-sq": "#8b5a2b",
      "--light-stroke": "#6a3f1f",
      "--dark-stroke": "#3a2110",
      // Warm ivory + deep ebony — the canonical Staunton wood palette,
      // matching the 3D pieceWhite/pieceBlack colors above so the 2D
      // and 3D views read as the same physical chess set.
      "--piece-fill": "#f6ecd2",
      "--piece-fill-2": "#1f1408",
      // Contrasting strokes per side — white gets a deep-brown outline,
      // black gets a light-sq matching outline so both remain defined
      // against light AND dark squares.
      "--piece-stroke": "#1a1005",
      "--piece-stroke-2": "#e3c193",
      "--highlight-from": "rgba(255,235,120,0.55)",
      "--highlight-to": "rgba(150,210,120,0.55)",
      "--highlight-last": "rgba(120,170,220,0.35)",
      "--highlight-check": "rgba(255,80,80,0.55)",
    },
    three: {
      boardLight: 0xead2a8,
      boardDark: 0xa37049,
      pieceWhite: { color: 0xf2e8d2, roughness: 0.55, metalness: 0.05 },
      pieceBlack: { color: 0x2a1f12, roughness: 0.55, metalness: 0.05 },
      squareEmissive: 0x000000,
    },
  },

  green: {
    name: "green",
    cssVars: {
      "--bg": "#0a1410",
      "--panel": "#11201a",
      "--panel-2": "#18302a",
      "--text": "#ecf2ee",
      "--text-dim": "#7fa597",
      "--accent": "#6ed4a8",
      "--accent-2": "#b9d06b",
      // Original chess.com-inspired green board: familiar tournament contrast
      // without copying proprietary assets or artwork.
      "--light-sq": "#eeeed2",
      "--dark-sq": "#769656",
      "--light-stroke": "#5e7f46",
      "--dark-stroke": "#4e6f3a",
      "--piece-fill": "#fafafa",
      "--piece-fill-2": "#312e2b",
      "--piece-stroke": "#4f4b45",
      "--piece-stroke-2": "#918b80",
      "--highlight-from": "rgba(255,235,120,0.55)",
      "--highlight-to": "rgba(140,220,160,0.55)",
      "--highlight-last": "rgba(110,180,255,0.35)",
      "--highlight-check": "rgba(255,80,80,0.55)",
    },
    three: {
      boardLight: 0xeeeed2,
      boardDark: 0x769656,
      pieceWhite: { color: 0xf7f3e8, roughness: 0.46, metalness: 0.02 },
      pieceBlack: { color: 0x2f2a26, roughness: 0.5, metalness: 0.03 },
      squareEmissive: 0x000000,
    },
  },

  neon: {
    name: "neon",
    cssVars: {
      "--bg": "#06070d",
      "--panel": "#0d1119",
      "--panel-2": "#141a26",
      "--text": "#e8f1ff",
      "--text-dim": "#6f86a8",
      "--accent": "#00e5ff",
      "--accent-2": "#ff3df0",
      "--light-sq": "#1f2742",
      "--dark-sq": "#0e1426",
      "--light-stroke": "#00e5ff",
      "--dark-stroke": "#ff3df0",
      // Cyan-glowing white + magenta-glowing black for neon legibility.
      "--piece-fill": "#e8f1ff",
      "--piece-fill-2": "#0a1426",
      // Strong dark stroke for whites; bright cyan stroke for blacks so
      // pieces stay visible against the dim squares in dark mode.
      "--piece-stroke": "#161b27",
      "--piece-stroke-2": "#00e5ff",
      "--highlight-from": "rgba(255,235,120,0.55)",
      "--highlight-to": "rgba(0,229,255,0.45)",
      "--highlight-last": "rgba(255,61,240,0.32)",
      "--highlight-check": "rgba(255,70,90,0.55)",
    },
    three: {
      boardLight: 0x2a3550,
      boardDark: 0x131a2c,
      pieceWhite: { color: 0xe8f1ff, roughness: 0.18, metalness: 0.4, emissive: 0x223355 },
      pieceBlack: { color: 0x0a1426, roughness: 0.22, metalness: 0.6, emissive: 0x661244 },
      squareEmissive: 0x223355,
    },
  },
};

export const THEME_NAMES = ["wood", "green", "neon"] as const;
export const DEFAULT_THEME: typeof THEME_NAMES[number] = "green";
