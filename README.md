# Ajedrez — FIDE-rules chess in your browser

A free, single-repo chess app implementing the full FIDE rules, with both a 2D
flat board and a 3D board (Three.js), stockfish-powered AI opponent, real-time
two-player online play via Supabase, a full FIDE-style clock, three color
themes, and animated piece movement.

Made to run entirely on the free tiers of:

- **Supabase** for backend, persistence, realtime, anonymous auth
- **Vercel** for static hosting
- **GitHub** for source control

No custom server. No paid compute.

> Status: **local-first is fully playable** (milestones 1–8 from the build
> prompt). Online multiplayer is wired at the database/schema/RLS level —
> enable it by following [SETUP.md](./SETUP.md) and adding your Supabase
> URL + anon key to `.env.local`.

---

## Quick start

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # runs Vitest
npm run typecheck    # type-checks without emitting
npm run build        # produces static dist/ (deploy this)
```

To enable online play, copy `.env.example` to `.env.local` and paste your
Supabase project URL + anon key — see [SETUP.md](./SETUP.md) for the
five-minute Supabase setup.

---

## Features (current)

- ✓ Full FIDE rules: legal moves, check / checkmate / stalemate, castling
  (both sides), en passant, promotion with picker, threefold repetition,
  fifty-move rule, insufficient material, resignation, and (not required
  by the prompt) touch-move is disabled since play is mouse-driven.
- ✓ 2D board (SVG/CSS) and 3D board (Three.js, PBR + shadow + ACES tone
  mapping), toggleable mid-game without losing state.
- ✓ Three themes: classic wood, tournament green, dark/neon. 2D board and
  3D pieces re-color together. Persisted per browser.
- ✓ FIDE-style clock with Bullet / Blitz / Rapid / Classical presets and
  custom controls; low-time pulse animation.
- ✓ Single-player vs **Stockfish** in a Web Worker, with five difficulty
  presets. Graceful fallback to a random mover if the worker fails
  to spawn.
- ✓ Mouse-only: click-to-select with legal-move highlighting **and**
  drag-and-drop.
- ✓ GSAP-driven smooth piece tweens for moves, captures, castling (both
  pieces animate), en passant, and promotion.
- ✓ WebAudio-generated move / capture / check / castle / promote / illegal
  / start / end / low-time-tick sounds. Zero audio assets shipped.
- ✓ Resign, game-over modal with PGN, and move list.
- ✓ Row Level Security written in `src/net/rls.sql` so writes are bound to
  player-uid, turn, and rate-limits.

## Features (deferred to your Supabase setup)

- ⏳ Real-time online multiplayer UI: Supabase schema + RLS are already in
  `src/net/schema.sql` and `src/net/rls.sql`. UI endpoints for create/join
  game will land soon.

---

## Project layout

```
src/
  engine/chess.ts          chess.js wrapper, strict legality
  engine/chess.test.ts     FIDE rule tests (vitest)
  game/Game.ts             controller (state machine, AI orchestration)
  game/store.ts            tiny typed pub/sub
  clock/Clock.ts           FIDE clock + low-time pulse
  clock/presets.ts         time-control presets
  clock/Clock.test.ts
  ai/stockfish.ts          main-thread Stockfish facade + fallback
  ai/engine.worker.ts      worker: bootstraps stockfish.wasm
  ai/levels.ts             skill-level → UCI mapping
  board2d/Board2D.ts       DOM/SVG board + pointer + drag/drop + tweens
  board2d/piece-svg.ts     inline SVG glyphs
  board3d/Board3D.ts       Three.js board (procedural Staunton)
  board3d/materials.ts     PBR presets per theme
  board3d/lighting.ts      IBL + shadows + ACES
  anim/tween.ts            GSAP helpers (move/capture/illegal/pulse)
  audio/sounds.ts          WebAudio synth
  themes/themes.ts         3 themes (CSS + 3D specs)
  themes/persistence.ts    localStorage theme save/load
  net/supabase.ts          SDK client wrapper (graceful when unconfigured)
  net/schema.sql           Postgres schema
  net/rls.sql              Row Level Security policies
  ui/App.ts                orchestrator: top bar + board + side panel
  ui/TopBar.ts             mode/render/theme/sound toggles, name entry
  ui/GameOverModal.ts      end-of-game modal
  ui/MoveList.ts           captured-moves display
  style.css                theme variables + global styles
  main.ts                  bootstrap
  types.ts                 shared TS types
```

---

## Architecture choices

- **No framework** — vanilla TypeScript on Vite. The app is small enough
  that a framework tax isn't worth it.
- **chess.js** for all rule enforcement. We never hand-roll move legality;
  every incoming move (from human, AI, or network) is validated through
  the same `ChessEngine.isLegal` path before being applied.
- **One source of truth**: `Game` owns the engine, the clock, and the
  AI adapter. Renderers are an abstract `ChessView` interface — both
  `Board2D` and `Board3D` implement it. Switching renderers mid-game
  preserves state because the *engine* is the state, not the renderer.
- **Procedural 3D pieces** are an explicit fallback per the asset
  hierarchy in §3.1 of the build prompt. They use `THREE.LatheGeometry`
  with hand-tuned profiles to give a recognizable Staunton silhouette
  at zero asset weight. To swap in the real MIT-licensed
  clarkerubber/Staunton-Pieces, see the "Real assets" section in
  [NOTES.md](./NOTES.md).
- **No audio assets**: WebAudio generates all sounds at runtime. This
  eliminates licensing ambiguity and keeps the bundle small.
- **Stockfish in a Worker**: the engine runs in `engine.worker.ts`, never
  blocking the UI. Difficulty is mapped to Stockfish's
  `Skill Level` UCI option plus a `movetime` budget. If the worker fails
  to bootstrap (offline build, package not installed, etc.), a
  deterministic capturer-first fallback (in `FallbackAI`) keeps the
  game playable at a degraded level.

---

## Deployment

```bash
# 1) Build
npm run build          # outputs dist/

# 2) Push to GitHub (see your repo's URL in NOTES.md)
#    The remote URL for this app is:
#      https://github.com/ErChulo/ajedrez-claude
#    First-time setup:
#      git init && git add -A && git commit -m "initial"
#      git branch -M main
#      git remote add origin <your-repo-url>
#      git push -u origin main

# 3) Deploy on Vercel
#    - Connect the GitHub repo.
#    - Framework preset: Vite.
#    - Add env vars VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY.
#    - Vercel auto-builds on push to main.
```

## Security model

- The Supabase **anon** key is meant to be public. Real protection comes
  from Row Level Security on every table. See `src/net/rls.sql`:
  - Players can only update `games` rows they own a seat on.
  - `moves` are insertable only when a Security-Definer function confirms
    it's that user's turn.
  - Game creation rate-limited to 3 active games per user.
  - Display names length-validated (1..20 chars) by CHECK constraints.
- Client-side validation always re-runs through `ChessEngine.isLegal` to
  reject tampered messages from the network.
- Sanitization: display names run through `textContent` (never `innerHTML`)
  and the schema enforces a 1..20 char bound.
- Content-Security-Policy: see `vercel.json` (recommended header set in
  [SETUP.md](./SETUP.md)).

## Dev workflow

Day-to-day dev work in this repo is wired around three skills:

- **find-skills** (via `npx skills find <keyword>`): discover community skills.
- **codegraph** (system binary `codegraph`, v1.4.1 at `/home/erchulo/.local/bin/codegraph`): cross-file navigation via subcommands `callers`, `callees`, `impact`, `affected`, `files`, `node`. See [AGENTS.md](./AGENTS.md) for the full task→tool matrix and 6 model-invocable recipes.
- **Playwright** (`@playwright/test`): end-to-end browser tests in `e2e/`, run cross-browser.

The fastest "everything passes locally" command:

```bash
npm run test:ci   # typecheck + vitest + playwright (chromium)
```

Then before pushing, the husky pre-push hook runs typecheck + tests automatically.

Useful scripts (full list in [AGENTS.md](./AGENTS.md) and `dev-workflow-spec.md`):

```bash
npm run typecheck            # tsc --noEmit
npm run test:unit            # vitest
npm run test:e2e             # playwright chrome/firefox/webkit
npm run test:e2e:chromium    # just chromium for fast feedback
npm run skills:find <kw>     # community-skill discovery
npm run graph:callers <sym>  # who calls this symbol?
npm run graph:impact <path>  # transitive dependents
npm run graph:status         # is the indexer ready?
npm run e2e:codegen          # record new UI flows
```

Cross-browser CI runs on every push to `main` and every PR via `.github/workflows/ci.yml`.

## License

MIT. See `NOTES.md` for third-party asset/license notes.
