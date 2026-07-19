// Difficulty mapping for Stockfish.
// We translate human-facing "Beginner .. Expert" into UCI "Skill Level"
// plus a search time budget. Skill Level is Stockfish's built-in knob
// (0 = weakest, 20 = full strength). Time limit caps wall-clock delay
// so "Beginner" feels snappy and "Expert" can dominate.

import type { AIDifficulty } from "@/types";

export interface AILevel {
  label: string;
  description: string;
  skillLevel: number;       // 0–20
  moveTimeMs: number;       // time per move
  depth?: number;           // optional depth cap
}

export const AI_LEVELS: Record<AIDifficulty, AILevel> = {
  beginner:     { label: "Beginner",     description: "Plays weak moves. Great for learning.", skillLevel: 1,  moveTimeMs: 200  },
  easy:         { label: "Easy",         description: "Occasional blunders. Casual play.",    skillLevel: 5,  moveTimeMs: 400  },
  intermediate: { label: "Intermediate", description: "Solid positional play.",                skillLevel: 10, moveTimeMs: 800  },
  advanced:     { label: "Advanced",     description: "Strong tactical awareness.",            skillLevel: 15, moveTimeMs: 1500 },
  expert:       { label: "Expert",       description: "Full engine strength. Slow but lethal.", skillLevel: 20, moveTimeMs: 4000 },
};

export function levelFor(d: AIDifficulty): AILevel { return AI_LEVELS[d]; }
