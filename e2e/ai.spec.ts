// Engine-kind + AI mode smoke test.
//
// Verifies the v1.1 surface:
//   1. The engine-kind badge is honest ("Stockfish" or "⚠ Random") within 5s
//      of page load — this is the user-facing answer to "which engine am I
//      playing against?".
//   2. Click-click on e2 → e4 makes a white pawn move.
//   3. The AI responds within 8 s — signalled by the #undo-btn becoming
//      enabled (history.length ≥ 2 means our move + one AI reply were both
//      committed). We deliberately don't use the clock-card "black active"
//      badge because that fires after the user's move but *before* the AI
//      is done thinking — looking at it would race with the AI move.
//   4. The Hint button (when enabled) surfaces the .hint-square class on
//      exactly two squares — both the from and the to of the recommended
//      move.
//   5. The Undo button restores the position two ply back: e2 has a pawn
//      again, e4 is empty.
//
// If the eager probe took the fallback branch (Stockfish binary missing,
// COOP/COEP headers wrong, offline), the assertion in step 1 falls back to
// "⚠ Random" without failing — that's by design, the surface still works.

import { test, expect, type Page } from "@playwright/test";

test("AI mode: badge is honest, AI responds, hint and undo work", async ({ page }: { page: Page }) => {
  await page.goto("/");

  // Wait for the eager AI probe to resolve (up to 5s for the Stockfish
  // worker bootstrap and the 2.5 s fallback timeout).
  const badge = page.locator("#engine-badge");
  await expect(badge).toBeVisible();
  // v1.8: tighten to require Stockfish — the static-asset loader in
  // src/ai/engine.worker.ts (public/stockfish.js + public/stockfish.wasm
  // via importScripts + locateFile) reliably boots within 5 s in dev. If
  // the env can't load it (offline, blocked CDN), the worker posts
  // engine_load_failed and the page falls back to FallbackAI; this
  // assertion then FAILS LOUDLY. That's intentional — the regression
  // tests guard the Stockfish-on-Stockfish badge honesty.
  await expect(badge).toHaveAttribute("data-engine", "stockfish", { timeout: 5_000 });
  const badgeText = (await badge.textContent())?.trim() ?? "";
  // eslint-disable-next-line no-console
  console.log(`[e2e/ai] engine kind is: "${badgeText}" (data-engine=${await badge.getAttribute("data-engine")})`);

  // Ensure we're in AI mode (the default tab is AI already, but be explicit).
  await page.locator(".appbar .toggle-group").first().locator('button:has-text("AI")').click();

  // Click-click e2 → e4.
  await page.locator('.square[data-square="e2"]').click();
  await page.locator('.square[data-square="e4"]').click();
  await expect(page.locator('.square[data-square="e2"] .piece')).toHaveCount(0);
  await expect(page.locator('.square[data-square="e4"] .piece')).toBeVisible();

  // Wait for the AI to finish its reply. Use the undo-btn enabled state as
  // the signal: it flips to enabled only when history.length ≥ 2 *and*
  // isAiThinking === false, both of which hold only after the AI committed.
  const undoBtn = page.locator("#undo-btn");
  await expect(undoBtn).toBeEnabled({ timeout: 8_000 });

  // Hint smoke: only valid when Stockfish is loaded.
  const engineKind = await badge.getAttribute("data-engine");
  if (engineKind === "stockfish") {
    const hintBtn = page.locator("#hint-btn");
    await expect(hintBtn).toBeEnabled({ timeout: 1_000 });
    await hintBtn.click();
    // Expert-level Stockfish move can take up to 4 s. Wait generously.
    await expect(page.locator(".hint-square")).toHaveCount(2, { timeout: 8_000 });
    // eslint-disable-next-line no-console
    console.log(`[e2e/ai] hint highlighted ${await page.locator(".hint-square").count()} squares`);
  } else {
    // eslint-disable-next-line no-console
    console.log("[e2e/ai] skipping hint assertion because engine is fallback");
  }

  // Undo smoke: works regardless of engine kind (rebuilds from history).
  await undoBtn.click();
  await expect(page.locator('.square[data-square="e2"] .piece')).toBeVisible({ timeout: 2_000 });
  await expect(page.locator('.square[data-square="e4"] .piece')).toHaveCount(0);
  // eslint-disable-next-line no-console
  console.log("[e2e/ai] undo restored e2 pawn, e4 cleared");
});
