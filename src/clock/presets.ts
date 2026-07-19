// FIDE-style time controls.
// Reference: FIDE Laws of Chess Annex A (rapid, blitz, bullet + classical).
// Bullet: < 3 min | Blitz: 3–10 min | Rapid: 10–60 min | Classical: > 60 min

export interface Preset {
  id: string;
  label: string;
  category: "bullet" | "blitz" | "rapid" | "classical" | "custom";
  initialSeconds: number;
  incrementSeconds: number;
}

export const PRESETS: Preset[] = [
  // Bullet
  { id: "b1", label: "Bullet 1+0",  category: "bullet",    initialSeconds:   60, incrementSeconds: 0 },
  { id: "b2", label: "Bullet 2+1",  category: "bullet",    initialSeconds:  120, incrementSeconds: 1 },
  // Blitz
  { id: "bl1", label: "Blitz 3+0",  category: "blitz",     initialSeconds:  180, incrementSeconds: 0 },
  { id: "bl2", label: "Blitz 3+2",  category: "blitz",     initialSeconds:  180, incrementSeconds: 2 },
  { id: "bl3", label: "Blitz 5+0",  category: "blitz",     initialSeconds:  300, incrementSeconds: 0 },
  { id: "bl4", label: "Blitz 5+3",  category: "blitz",     initialSeconds:  300, incrementSeconds: 3 },
  // Rapid
  { id: "r1", label: "Rapid 10+0", category: "rapid",     initialSeconds:  600, incrementSeconds: 0 },
  { id: "r2", label: "Rapid 10+5", category: "rapid",     initialSeconds:  600, incrementSeconds: 5 },
  { id: "r3", label: "Rapid 15+10", category: "rapid",    initialSeconds:  900, incrementSeconds: 10 },
  // Classical
  { id: "c1", label: "Classical 30+0",  category: "classical", initialSeconds: 1800, incrementSeconds: 0  },
  { id: "c2", label: "Classical 30+20", category: "classical", initialSeconds: 1800, incrementSeconds: 20 },
];

export const DEFAULT_PRESET = PRESETS.find(p => p.id === "r2")!;

export function presetById(id: string): Preset | undefined {
  return PRESETS.find(p => p.id === id);
}

export function buildCustom(initialMinutes: number, incrementSeconds: number): Preset {
  return {
    id: "custom",
    label: `${initialMinutes}+${incrementSeconds}`,
    category: "custom",
    initialSeconds: Math.max(1, Math.round(initialMinutes * 60)),
    incrementSeconds: Math.max(0, Math.round(incrementSeconds)),
  };
}

export function categoryLabel(c: Preset["category"]): string {
  return ({ bullet: "Bullet", blitz: "Blitz", rapid: "Rapid", classical: "Classical", custom: "Custom" } as const)[c];
}
