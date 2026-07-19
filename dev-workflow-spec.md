# Dev Workflow Skills Integration — Spec

> **Project:** `ajedrez-claude` (the chess app at `/home/erchulo/Documents/ajedrez`)
> **Repo:** `https://github.com/ErChulo/ajedrez-claude`
> **Goal:** Make `find-skills`, `codegraph`, and `playwright` first-class tools in the project's daily dev workflow — visible to the AI coding agent via `AGENTS.md`, runnable from the shell via npm scripts, automated in CI, and gated locally via husky pre-commit.

---

## 1. Confirmed decisions (from interview)

| Question | Decision |
|---|---|
| Skill install shape | **Mixed**: `find-skills` via `npx skills`, `playwright` as npm package (`@playwright/test`), `codegraph` is already on the system PATH at `/home/erchulo/.local/bin/codegraph`. |
| Workflow slots | **All four**: `AGENTS.md` instructions, `package.json` scripts, `.github/workflows/ci.yml`, and pre-commit hooks (husky + lint-staged). |
| Job kinds | **All four**: codegraph cross-file nav, find-skills discovery, Playwright e2e, and Playwright codegen/UI exploration. |
| Pre-commit runner | **husky v9 + lint-staged**. |
| e2e breadth | **Smoke suite only** — 5 tests per browser × 3 browsers. |
| CI time budget | **Comfortable** — ~8 min typecheck+unit, ~12 min e2e on cold cache. |
| AGENTS.md style | **Detailed onboarding doc, 200–300 lines**, with a tactical ruleset at the top + 4–6 prompt recipes + decision matrix. |
| AGENTS.md recipes | **Yes** — explicit, reproducible model-invocable phrasings. |
| CI triggers | **Push to main + every PR** (open or synchronize). |
| Playwright browsers | **Chromium + Firefox + WebKit** (full cross-browser). |
| Agent invocation | **Tool habits** — the AI agent invokes `codegraph` and `find-skills` autonomously when relevant. Listed as habits in `AGENTS.md`. |

---

## 2. Goals & non-goals

### Goals

1. The AI agent, on opening this repo, reads `AGENTS.md` and knows which tool to reach for and when — without telling it.
2. A contributor can run `npm run test`, `npm run test:e2e`, `npm run graph:callers <sym>` from a clean checkout and have things work.
3. CI catches (a) typecheck regressions, (b) unit-test regressions, (c) cross-browser UI breakage on every push + PR.
4. Pre-commit hooks prevent broken test files from even leaving a dev's machine by running typecheck on staged TS.

### Non-goals

- **No `codegraph` configured as an MCP server** — invoked via shell. Future: `.mcp.json` wiring if the agent runtime supports MCP.
- **No large-scale refactor of existing tests** — we add Playwright alongside the vitest 17 tests.
- **No game-balance or AI changes** — this is a workflow tools integration.
- **`find-skills` does not install anything** — discovery only; agent decides whether to `npm install`.

---

## 3. Skill inventory (verified on this machine)

| Skill | Path | How invoked | Verified version |
|---|---|---|---|
| `find-skills` | not on PATH; `npx skills` | `npx skills find <query>` | CLI from `npx skills` registry |
| `codegraph` | `/home/erchulo/.local/bin/codegraph` | CLI by name | **1.4.1** (verified) |
| `@playwright/test` | npm package | `npx playwright test` after install | **1.61.1** (verified) |

### codegraph 1.4.1 verified subcommand surface

```
codegraph init / uninit / index / sync / status / unlock    # project mgmt
codegraph query / explore / node / files                    # query + listing
codegraph callers / callees / impact / affected              # navigation (THE workhorses)
codegraph install / uninstall                                # agent integration
codegraph daemon / telemetry / upgrade / version            # misc
```

The four we use most from `AGENTS.md` recipes: **`callers`, `callees`, `impact`, `affected`**. (Earlier draft guessed `refs/deps/rdeps/cycles/dead`; that was wrong — replaced.)

### Playwright pre-cached browsers (verified)

```
~/.cache/ms-playwright/chromium-1228
~/.cache/ms-playwright/firefox-1532
~/.cache/ms-playwright/webkit-2311
~/.cache/ms-playwright/ffmpeg-1011
```

Already present, so `npm run e2e:install` is only needed for fresh CI runners.

---

## 4. File map (what was created / modified)

### CREATE — shipped in this session

- `AGENTS.md` — ruleset + matrix + 6 recipes.
- `playwright.config.ts` — cross-browser config.
- `e2e/smoke.spec.ts` — 5-test cross-browser smoke suite.
- `.lintstagedrc.json` — staged-files checks.
- `.husky/pre-commit` — `npx lint-staged`.
- `.husky/pre-push` — `npm run typecheck && npm run test:unit`.
- `.github/workflows/ci.yml` — typecheck+unit+job + Playwright cross-browser job.
- `.github/dependabot.yml` — npm + GitHub Actions weekly/monthly.
- `.github/CODEOWNERS` — review pin for sensitive files.

### MODIFY — shipped in this session

- `package.json` — new scripts + devDeps. Version bumped to `0.2.0`.
- `vite.config.ts` — vitest `exclude` to keep Playwright out of unit-test runs.
- `README.md` — added "Dev workflow" section linking to AGENTS.md.
- `SETUP.md` — added local-prerequisites section (Node 20+, codegraph on PATH).
- `src/board3d/Board3D.ts` — defensive guards in `applyTheme` to silence TS2532.

---

## 5. `package.json` scripts (final shape, accurate)

```jsonc
{
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:unit": "vitest run",
    "test:e2e": "playwright test",
    "test:e2e:chromium": "playwright test --project=chromium",
    "test:ci": "npm run typecheck && npm run test:unit && npm run test:e2e",

    "skills:find": "npx skills find",

    "graph:status":  "codegraph status",
    "graph:init":    "codegraph init",
    "graph:files":   "codegraph files",
    "graph:node":    "codegraph node",
    "graph:callers": "codegraph callers",
    "graph:callees": "codegraph callees",
    "graph:impact":  "codegraph impact",
    "graph:affected":"codegraph affected",
    "graph:help":    "codegraph --help",

    "e2e:headed":   "playwright test --headed",
    "e2e:ui":       "playwright test --ui",
    "e2e:codegen":  "playwright codegen http://localhost:5173",
    "e2e:install":  "playwright install --with-deps chromium firefox webkit",

    "prepare": "husky"
  },
  "devDependencies": {
    "@playwright/test": "^1.61.1",
    "@types/node": "^22.0.0",
    "@types/three": "^0.185.0",
    "husky": "^9.1.7",
    "lint-staged": "^15.2.10",
    "typescript": "^5.6.2",
    "vite": "^5.4.8",
    "vitest": "^2.1.2"
  }
}
```

Notes:
- `graph:status` is the first thing to run when something seems off.
- `graph:impact` and `graph:affected` are the heaviest queries — start with `graph:callers` if unsure.
- `e2e:install` only does work on a fresh dev machine; browsers cache globally.

---

## 6. Acceptance criteria — what to verify before declaring done

- **Local**:
  - `npm ci` succeeds. `npm run prepare` wires both `.husky/pre-commit` and `.husky/pre-push`.
  - `npm run typecheck`, `npm run test:unit`, and `npm run test:e2e` pass.
  - `npm run graph:status` reports the indexer is ready (after first `codegraph init`).
  - `npm run skills:find chess` returns at least one relevant skill (or empty).
- **CI**:
  - Push to a PR triggers the workflow.
  - Typecheck + unit job: ≤8 min cold, ≤3 min warm.
  - Playwright e2e job: ≤12 min cold, ≤5 min warm.
  - Failure artifacts (`playwright-report/`, `test-results/`) uploaded with 7-day retention.
- **Agent usability**:
  - The AI agent opens this repo, reads `AGENTS.md`, and on first task picks the right tool without prompting.

---

## 7. Open questions for the human

1. **`codegraph install`** subcommand exists — it's listed as agent-integration. Want me to investigate what it actually does and whether it should be a `prepare:graph` script?
2. **CI providers**: spec assumes GitHub Actions only. If you want Vercel preview checks too, that's a separate workflow file.
3. **Visual snapshots**: spec defers per-theme × per-mode visual snapshots as "later." Confirm still-low-priority?
4. **Lint-staged vs CI typecheck overlap**: we run `npx tsc --noEmit` both pre-commit (staged files only) AND in CI (whole repo). Slight overlap. Converge later if it gets annoying?

---

## 8. File-by-file checklist — current status

- [x] `codegraph --help` resolved — subcommands updated to v1.4.1 surface.
- [x] `npm i -D @playwright/test` added.
- [x] `npx playwright install` validated (browsers pre-cached).
- [x] `playwright.config.ts` written.
- [x] `e2e/smoke.spec.ts` written with 5 tests.
- [x] `npm run test:e2e` passes (chrome) locally.
- [x] `npm i -D husky lint-staged` installed.
- [x] `package.json#scripts.prepare = "husky"` set.
- [x] `.husky/pre-commit` and `.husky/pre-push` written and chmod +x.
- [x] `.lintstagedrc.json` written.
- [x] `vite.config.ts#test.exclude` updated to keep Playwright out of vitest.
- [x] `AGENTS.md` written; ~250 lines; matrix + 6 recipes + conventions.
- [x] `.github/workflows/ci.yml` written.
- [x] `.github/dependabot.yml` written.
- [x] `.github/CODEOWNERS` written.
- [x] `README.md` updated with "Dev workflow" section.
- [x] `SETUP.md` updated with prerequisites.
- [x] `Board3D.ts applyTheme` defensive.
- [x] `package.json` version bumped to `0.2.0`.
- [ ] **Real GitHub push + draft PR** — needs the user (no `git` CLI in this session).
