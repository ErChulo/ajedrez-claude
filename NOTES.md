# NOTES — tool availability, fallback, and asset decisions

This file logs what was actually used, what fell back, and where the build
prompt's optional/aspirational items diverged.

## Tool/MCP availability

The original build prompt asks the agent to check for these optional tools
and "fall back gracefully rather than fail." Status of each in this session:

| Skill / MCP          | Available? | Action taken                              |
|----------------------|------------|-------------------------------------------|
| `regex-chess`        | ❌ no       | Not needed — we use `chess.js` directly.   |
| `chess-best-move`    | ❌ no       | Falls back to `stockfish.wasm` per §6.    |
| `tabletopkit`        | ❌ no       | Not needed — 2D board is hand-built.      |
| `board-game-design`  | ❌ no       | Not needed.                                |
| `ux-ui-pro-max`      | ❌ no       | UI authored by hand.                      |
| `codegraph` MCP      | ❌ no       | Normal `code_search` / `read_files` work. |
| `chess.com` MCP      | ❌ no       | Not needed for the build.                 |
| `chessmata` MCP      | ❌ no       | Falls back to Stockfish, see §6.          |

For each: this is documented here so a future reader doesn't go hunting
through skill directories.

## Asset decisions

### 3D piece geometry

The prompt's preferred path ([§3.1]) calls for the MIT-licensed
**clarkerubber/Staunton-Pieces** OBJ files, converted once to `.glb` and
loaded with `GLTFLoader`.

In this build session:

- This repository has **no internet-fetchable asset pipeline** baked in.
- Converting OBJ → GLB requires either Blender (heavyweight) or
  `gltf-transform` (Node CLI), which isn't installed in this environment.
- Therefore, per the prompt's *fallback clause (c)* ("procedural geometry
  as an explicit last resort, clearly noted in `NOTES.md` as a visual
  downgrade"), `src/board3d/Board3D.ts` ships **procedural Staunton-style
  pieces** built from `THREE.LatheGeometry` with hand-tuned profiles per
  piece type, plus small cones/boxes for crenellations, crowns, and the
  knight's stylized head.

**To upgrade to real Staunton geometry:**

1. Fetch the `Source/` OBJ files from
   <https://github.com/clarkerubber/Staunton-Pieces> and vendor them into
   `src/assets/models/`.
2. Install `gltf-transform`: `npm i -D @gltf-transform/core @gltf-transform/functions`.
3. Convert each piece to `.glb`:
   `npx gltf-transform optimize src/assets/models/pawn.obj src/assets/models/pawn.glb`
   (you may need to chain through `dedup`, `weld`, `resample`).
4. In `Board3D`, replace `makePieceGeometry()` lookups with:
   ```ts
   import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
   const loader = new GLTFLoader();
   const gltf = await loader.loadAsync("/models/pawn.glb");
   // clone into each piece's group
   ```

The procedural fallback targets a recognizable Staunton silhouette at
modest poly-count and emits meaningful shadows / PBR reflections. The
knight is the most stylized (two cones for "ears" atop a lathe-revolved
neck) — obviously inferior to a sculpted mesh but plausible at game scale.

### HDRI environment lighting

The prompt asks for a CC0 HDRI from Poly Haven, loaded via `RGBELoader` +
`PMREMGenerator` for IBL.

In `src/board3d/lighting.ts`, we substitute Three.js's procedural
`RoomEnvironment`, run through `PMREMGenerator`. This gives PBR materials
realistic screen-space reflections without any external HDRI file, at
zero network cost. The visual character differs from a real indoor HDRI
(slightly softer / "neutral studio" feel) but is materially better than
no environment at all.

**To swap in a real HDRI** (recommended for production polish):

```ts
// top of Board3D.mount() after the renderer is set up:
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";
const hdr = await new RGBELoader().loadAsync("/hdri/studio_small_1k.hdr");
const envMap = pmrem.fromEquirectangular(hdr).texture;
scene.environment = envMap;
```

Poly Haven's "Studio Small 03" or "Indoor Studio" 1k files are CC0 and
~1 MB.

## Engine / fallback

Stockfish integration uses `stockfish.wasm` via a Web Worker. If the
package fails to load (offline build, missing wasm, etc.):

1. `src/ai/engine.worker.ts` posts `engine_load_failed` to the main thread.
2. `src/ai/stockfish.ts` detects this and rejects the `ensureStarted()`
   promise.
3. The `Game` controller continues to function. `FallbackAI` selects among
   the engine's `legalMovesAll()` preferring any capture, failing over
   to a uniform random move. Neither follows FIDE-strength play, but
   the game is still winnable for a beginner and loss-free for a strong
   player testing the UI.

## Audio

All sound effects are synthesized at runtime through WebAudio (filtered
noise bursts, sine/triangle envelopes). No assets shipped. CC0 by
construction. Mute toggle flips a master gain node; nothing else changes.

## Tests

Vitest covers:
- `src/engine/chess.test.ts` — 11 FIDE-rule tests including fool's mate,
  castling K/Q, en passant, promotion, stalemate, insufficient material,
  threefold repetition, and snapshot integrity.
- `src/clock/Clock.test.ts` — increment, low-time pulse, and flag fall.

Both must pass before merging.

## Real-time / online status

Database schema, RLS, and the `Supabase` SDK wrapper ship in this build.
UI wiring for create-game / join-by-code / live-move subscription lands
in a follow-up commit. Until then the supabase-configured path renders
the "Online mode: Supabase not configured" notice.

## Deviations from the build prompt

- The original prompt invited using Three.js + `chessboard.js` /
  `chessground`. We hand-built both DOM-based 2D and Three-based 3D
  boards for tighter integration with our theme system and animation
  pipeline.
- The prompt suggested, but did not require, `Howler.js`. We use
  WebAudio directly to avoid the extra dependency and to keep sound
  generation entirely runtime-side.
- The prompt's "advanced" Stockfish skill level is `15` here, not the
  default `20`, to keep move times snappy on slower laptops.
