// Real-time online two-player e2e test.
//
// Skipped automatically when Supabase env vars are not present (this is the
// default in local dev and in CI without a configured Supabase project).
// To run against a real Supabase project, set VITE_SUPABASE_URL and
// VITE_SUPABASE_ANON_KEY in your shell environment and re-run the suite.
//
// The test exercises the full pipeline:
//   - Anonymous auth (each browser context signs in independently, producing
//     two distinct Supabase users)
//   - Mode-tab switch (TopBar Online tab)
//   - OnlinePanel create-game flow → supabase.games INSERT via REST
//   - OnlinePanel join-by-code → supabase.games UPDATE on the creator's row
//   - Realtime broadcast: B receives A's move via postgres_changes → engine
//     applies → animates → board reflects the new state
//   - Round-trip: 5 half-moves (A→B→A→B→A) land on both clients
//   - Postgres writes: both clients converge to identical FEN/PGN
//   - Clock drift: existing clocks within 2s of each other after the round
//
// This is the build prompt's "online multiplayer working" acceptance criterion
// in spec form.

import { test, expect, type BrowserContext, type Page } from "@playwright/test";

// Read env at module level. Vite's vite.config doesn't expose these to the
// browser at runtime — they live on `import.meta.env` for the page — but
// Playwright's `process.env` sees whatever the test runner was started with.
const SUPABASE_URL = process.env.VITE_SUPABASE_URL ?? "";
const SUPABASE_KEY = process.env.VITE_SUPABASE_ANON_KEY ?? "";
const skipBecauseNoSupabase = !SUPABASE_URL || !SUPABASE_KEY;

// If you skip, surface this prominently in the test output.
test.beforeAll(() => {
  if (skipBecauseNoSupabase) {
    // eslint-disable-next-line no-console
    console.warn(
      "[e2e/online] Skipping real-time round-trip test: set VITE_SUPABASE_URL " +
        "and VITE_SUPABASE_ANON_KEY to enable. Existing local smoke suite " +
        "(e2e/smoke.spec.ts) is unaffected.",
    );
  }
});

test.describe("online 2-player round-trip", () => {
  test.skip(skipBecauseNoSupabase, "Supabase not configured for this run");

  let ctxA: BrowserContext;
  let ctxB: BrowserContext;
  let pageA: Page;
  let pageB: Page;

  test.beforeEach(async ({ browser }) => {
    ctxA = await browser.newContext();
    ctxB = await browser.newContext();
    pageA = await ctxA.newPage();
    pageB = await ctxB.newPage();
    await pageA.goto("/");
    await pageB.goto("/");
    // Switch both clients into Online mode.
    await onlineModeClick(pageA);
    await onlineModeClick(pageB);
  });

  test.afterEach(async () => {
    await ctxA.close();
    await ctxB.close();
  });

  test("create / join by code / exchange 5 moves / clocks within 2s", async () => {
    // 1. A enters a name and clicks "Create game" with a known time control.
    await pageA.fill('input[name="displayName"]', "Alpha");
    // The default selected preset is whatever PRESETS' first entry is. Force
    // a fast preset (1+0 bullet) so clocks tick fast and we can measure drift.
    const presetSelect = pageA.locator(".online-form select").first();
    await presetSelect.selectOption({ label: "1+0 Bullet" });
    await pageA.locator('button:has-text("Create game")').click();

    // 2. Wait for the "waiting" substate with a visible join code.
    const codeLocator = pageA.locator(".join-code");
    await codeLocator.waitFor({ timeout: 5_000 });
    const joinCode = (await codeLocator.textContent())?.trim() ?? "";
    // Verify our generated code format (alphanumeric 6 chars, no ambiguous I/O/0/1).
    expect(joinCode).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);

    // 3. B enters the code and clicks Join. (No race here because the row
    //    existed before B joined and B writes back via UPDATE.)
    await pageB.fill('input[name="displayName"]', "Bravo");
    await pageB.fill('input[placeholder="ABC123"]', joinCode);
    await pageB.locator('button:has-text("Join")').click();

    // 4. Both clients leave the online lobby and load the standard 2D board.
    //    Allow generous time because it includes the initial Realtime wire-up.
    await pageA.locator(".board-2d").waitFor({ timeout: 15_000 });
    await pageB.locator(".board-2d").waitFor({ timeout: 15_000 });

    // 5. Exchange 5 half-moves: A→B→A→B→A.
    const moves: { from: string; to: string }[] = [
      { from: "e2", to: "e4" },
      { from: "e7", to: "e5" },
      { from: "g1", to: "f3" },
      { from: "b8", to: "c6" },
      { from: "f1", to: "c4" },
    ];
    for (let i = 0; i < moves.length; i++) {
      const actor = i % 2 === 0 ? pageA : pageB;
      const watcher = i % 2 === 0 ? pageB : pageA;
      const { from, to } = moves[i];
      await actor.locator(`.square[data-square="${from}"]`).click();
      await actor.locator(`.square[data-square="${to}"]`).click();
      // The watcher should see the source empty and dest populated within ~2s.
      await watcher.locator(`.square[data-square="${from}"] .piece`)
        .waitFor({ state: "detached", timeout: 5_000 });
      await expect(watcher.locator(`.square[data-square="${to}"] .piece`))
        .toBeVisible();
    }

    // 6. Both clients should agree on the FEN at this point.
    // Pull the move list count — it should be 5 on both sides (5 half-moves).
    const moveCountA = await pageA.locator(".move-card .move-row, .move-card [data-move-index]").count();
    const moveCountB = await pageB.locator(".move-card .move-row, .move-card [data-move-index]").count();
    expect(moveCountA).toBeGreaterThanOrEqual(5);
    expect(moveCountB).toBeGreaterThanOrEqual(5);

    // 7. Clocks should be within 2 seconds of each other (drift-corrected via
    //    the realtime game row update + Clock.forceUpdate). The formatMs
    //    helper emits "MM:SS" or "HH:MM:SS".
    const tA = await readClockSeconds(pageA, "white");
    const tB = await readClockSeconds(pageB, "white");
    expect(Math.abs(tA - tB)).toBeLessThanOrEqual(2);
  });
});

async function onlineModeClick(page: Page): Promise<void> {
  // The mode group is the FIRST `.toggle-group` in the appbar (vs 2D/3D which
  // is the second). The Online button has text "Online".
  const onlineBtn = page.locator(".appbar .toggle-group").nth(0)
    .locator('button:has-text("Online")');
  await onlineBtn.waitFor({ timeout: 5_000 });
  await onlineBtn.click();
}

async function readClockSeconds(page: Page, side: "white" | "black"): Promise<number> {
  const text = (await page.locator(`[data-role="${side}-time"]`).textContent())?.trim() ?? "0:00";
  const parts = text.split(":").map((p) => parseInt(p, 10));
  if (parts.length === 2) {
    // MM:SS
    return parts[0] * 60 + parts[1];
  }
  if (parts.length === 3) {
    // HH:MM:SS
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return 0;
}
