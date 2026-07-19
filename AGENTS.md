# AGENTS — ajedrez-claude

> Tactical rules + recipes for any AI coding agent working on this repo.
> Read this top-to-bottom on first open. Lines are intentionally short;
> every command below is meant to fit in a single context block.

## TL;DR

- **Engine rules** — never hand-roll move legality. Use `ChessEngine.apply` / `isLegal` (in `src/engine/chess.ts`).
- **Renderer** — use the abstract `ChessView`; both `Board2D` and `Board3D` implement it. Don't pick a renderer in non-View code.
- **State** — never mutate outside the `Game` controller. Subscribe via `game.subscribe`.
- **Tests** — chess rules tests in `engine/chess.test.ts`, clock in `clock/Clock.test.ts`, end-to-end browser tests in `e2e/`.
- **Tool habits** — see the table below. Reach for the right tool; do not reach for ripgrep when `codegraph` fits.

## Codebase orientation (60-second map)

| Area | Path | Use it for |
|---|---|---|
| Chess rules | `src/engine/chess.ts` | Move legality, FEN/PGN, snapshots. Wraps `chess.js`. |
| Game loop | `src/game/Game.ts` | Single source of truth. Coordinates engine, clock, AI, view. |
| AI | `src/ai/stockfish.ts` | Stockfish adapter + deterministic `FallbackAI`. |
| AI worker | `src/ai/engine.worker.ts` | Loads `stockfish.wasm`. Posts `engine_load_failed` on fail. |
| Clock | `src/clock/Clock.ts` | FIDE clock, RAF-driven, increment, low-time pulse, flag fall. |
| 2D view | `src/board2d/Board2D.ts` | DOM/SVG board, pointer events, FLIP-style tweens. |
| 3D view | `src/board3d/Board3D.ts` | Three.js, procedural Staunton, IBL + shadows, PBR. |
| Themes | `src/themes/themes.ts` | Three palettes: wood / green / neon. |
| Audio | `src/audio/sounds.ts` | WebAudio synth (no assets). |
| Supabase | `src/net/{supabase.ts,schema.sql,rls.sql}` | Stub + SQL. RLS targets `authenticated`. |
| Tests (unit) | `src/**/*.test.ts` | vitest, jsdom. |
| Tests (browser) | `e2e/*.spec.ts` | Playwright, cross-browser. |

## Task → tool decision matrix

| Task | Tool | When |
|---|---|---|
| Find what references symbol X | `codegraph callers X` | Before modifying any exported symbol. |
| Find what symbol X depends on | `codegraph callees X` | When X is being touched and you need blast-radius. |
| What callers/transitive uses module M | `codegraph impact src/M` | Before deleting, renaming, or major refactoring. |
| Which files mention a string | `codegraph affected <term>` | For "every place this appears" searches. |
| List project files (filterable) | `codegraph files` | When grep is too broad. |
| Show a node's metadata | `codegraph node <id>` | For symbol-table lookups. |
| Decide whether to add a new dep | `npx skills find <keyword>` | **Before** adding any new library. Do not skip. |
| Verify UI after renderer change | `npm run test:e2e` | After any `Board2D`/`Board3D` change. |
| Manually record a UI flow | `npm run e2e:codegen` | Humans only. |
| Check chess rules correctness | `npm run test:unit -- engine` | After engine changes. |
| Check clock correctness | `npm run test:unit -- clock` | After clock changes. |
| Pre-commit gate | `npx lint-staged` (auto) | Every commit. |
| Pre-push gate | `npm run typecheck && npm run test:unit` (auto) | Every push. |

## Skill integration recipes (model-invocable phrasings)

### Recipe 1 — "Add a new dependency X"
1. Run `npx skills find X` — see if a community skill already covers it.
2. If no skill, `npm install <pkg>` and add the import in the right `src/<area>/`.
3. Run `codegraph affected <pkg-name-or-symbol>` to find risky call sites.
4. Run `npm run typecheck && npm run test:unit`.

### Recipe 2 — "Refactor module M"
1. Run `codegraph impact src/M` — see all transitive dependents.
2. Run `codegraph callees src/M` — see what M depends on (so you don't break it).
3. If M is exported, write a regression test (`*.test.ts` if logic, `e2e/*.spec.ts` if UI).
4. Make changes; re-run impacts/calls to verify nothing regressed.

### Recipe 3 — "Bug report on the board showing X"
1. Run `codegraph affected X` — find the rendering path.
2. Run `npm run test:e2e` to reproduce; if no test covers it, write one.
3. Fix in the responsible module; commit test + fix together.

### Recipe 4 — "Verify before pushing"
1. `npm run test:ci` locally — typecheck + vitest + Playwright (chromium).
2. If green, push a draft PR; CI runs the full matrix including firefox + webkit.
3. Inspect the `playwright-report/` artifact on CI failure.

### Recipe 5 — "Add a new E2E flow"
1. `npm run dev` in one terminal; `npm run e2e:codegen` in another.
2. Click through the new flow until the recorder is satisfied.
3. Save the generated test under `e2e/` next to `smoke.spec.ts`; trim to stable selectors.
4. Run `npm run test:e2e` to confirm it passes locally.

### Recipe 6 — "Investigate a FIDE-rule edge case"
1. Add a failing test in `src/engine/chess.test.ts` with the canonical FEN.
2. Run `npm run test:unit -- engine` — confirm it fails for the right reason.
3. Decide: chess.js bug → wrap or work around; our wrapper bug → fix in `engine/chess.ts`.
4. Re-run unit tests; add the case to the canonical-positions comment block in the test file.

## Conventions

- File naming: `kebab-case.ts`; classes `PascalCase`; functions `camelCase`.
- Tests live next to the unit (`*.test.ts`) or under `e2e/` for browser.
- Imports: named-only exports, no default exports, paths via `@/`.
- One commit = one logical change. Don't bundle refactor + feature.
- Keep `package.json` scripts pure (no inline shell gymnastics).

## Forbidden patterns

- Hand-rolled move legality / FEN parsing outside `chess.js`.
- Direct DOM manipulation outside the View classes.
- Mutating `engine`, `clock`, or `view` from outside `Game.ts`.
- `as any` to bypass TypeScript errors — use a real fix or a typed shim.
- `void (...)` in `*.ts` to silence "unused" — delete the unused code instead.
- Skip CI on a PR; the linter will fail the merge gate.
- Adding any new external service (auth/payments/analytics) without confirming with the human (then immediately update `SETUP.md`).

## Tool details

### codegraph (v1.4.1 on this machine, `/home/erchulo/.local/bin/codegraph`)

```bash
codegraph --help                # full subcommand list
codegraph status               # is the indexer ready?
codegraph init                  # one-time setup for a project
codegraph callers <symbol>      # who calls X?
codegraph callees <symbol>      # what does X call?
codegraph impact <path|name>    # transitive dependents of M
codegraph affected <term>       # files containing a mention
codegraph files                 # indexed file list
codegraph node <id>             # symbol metadata
```

If `codegraph status` says it isn't ready, run `codegraph init` once at the repo root. If `codegraph --help` errors or the subcommand surface differs from above, surface to the human — the `package.json` scripts assume these names.

### find-skills (via `npx skills`)

```bash
npx skills find chess           # community skills about chess
npx skills find playwright      # about Playwright specifically
npx skills find <any-keyword>   # general discovery
```

`find-skills` does NOT install anything. It's a discovery step; you decide whether to `npm install` a community package based on the result.

### Playwright

```bash
npm run test:e2e                # full suite (chromium/firefox/webkit)
npm run test:e2e:chromium       # just chromium for fast feedback
npm run e2e:headed              # run with a visible browser
npm run e2e:ui                  # run with the interactive test runner
npm run e2e:codegen             # record new flows
```

Browser binaries cached at `~/.cache/ms-playwright/` after first install. CI installs on first run only (cached afterward).

## Switching the renderer (2D ↔ 3D)

The abstract `ChessView` keeps the game state intact when the user toggles renderers. To swap renderers:

1. `currentBoard: { view, destroy }` holds the live renderer.
2. `mountBoard("3d")` calls `currentBoard.destroy()` then mounts the new view.
3. `Game.ts` is unaware; only the App layer knows the toggle.

When adding new renderers (e.g. an "ASCII board"), implement the `ChessView` interface in `src/board-ascii/` and add it to the toggle in `src/ui/TopBar.ts`.

## Troubleshooting

- **`codegraph` not found** — install: the binary is at `/home/erchulo/.local/bin/codegraph`; verify with `which codegraph`. If missing, ask the human to install (the spec calls this a dev prerequisite).
- **`npx skills`** high latency on first call — normal; sub-second afterwards.
- **Vitest ERR_MODULE_NOT_FOUND** — usually means `playwright.config.ts` was dragged into vitest's module graph; fix `vite.config.ts#test.exclude` to include `./playwright.config.ts`.
- **Playwright flakes on CI only** — open the `playwright-report/` artifact in the failed workflow; the failing assertion is in there.
- **`stockfish.wasm` fails to boot** — the worker posts `engine_load_failed` and `Game` falls back to `FallbackAI`. Verify by running `npm run test:unit -- stockfish` (none yet — defer).
- **Typecheck error in `Board3D.ts` after theme switch** — add `if (mat)` guards on every `boardMaterials[i]` access.

## When to ask the human

- Adding any new external service (auth provider, payment, analytics).
- Changing RLS policies in `src/net/rls.sql` — Supabase needs a human review.
- Replacing the chess engine — affects every rule case.
- Bumping major deps (React, Three.js, Vite).
- Changing deployment target away from Vercel + Supabase free tiers.
- Change of repo URL or transfer of ownership.
