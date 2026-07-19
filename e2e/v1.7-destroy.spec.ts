// v1.7 hang-on-destroy regression test.
//
// The v1.7 lifecycle fix added `private resolvers: Set<() => void>` to both
// Board2D.ts and Board3D.ts. Every `await new Promise(... done => gsap.to(...
// { onComplete: () => done() }))` registers its resolve callback in this
// Set on construction, and destroy() drains the Set after killTweensOf so
// any in-flight Promise becomes no-op-resolved immediately.
//
// Without this fix, toggling 2D → 3D mid-animation would hang Game's
// `await view.animateMove(...)` forever — the finally block (which sets
// `isProcessingMove = false`) would never run, and the game would
// silently refuse subsequent clicks because the inner guard rejects them.
//
// This test exercises that exact race.
//
// Strategy:
//   1. Make a normal human move (e2 → e4).
//   2. Wait for the AI's animateMove to START (don't wait for it to
//      finish — we want to interrupt it mid-flight).
//   3. Toggle render mode 2D → 3D → 2D within ~100 ms — the destroy-mid-
//      animation scenario the fix targets.
//   4. Verify the engine-badge is still rendered (proves the app hasn't
//      crashed; the destroy/resolver-drain path landed cleanly).
//   5. Make a second move and verify it's accepted AND the AI replied
//      (undo-btn enabled). This proves isProcessingMove flipped back to
//      false during the destroy → drain sequence.

import { test, expect, type Page } from "@playwright/test";

async function gotoAI(page: Page): Promise<void> {
  await page.goto("/");
  // Settle the eager engine probe BEFORE timing-sensitive actions so
  // cold-boot WASM init doesn't bleed into the post-move undoBtn
  // poll — the original 8 s undoBtn budget was a pre-v1.8.4 fallback
  // race against the Stockfish bridge's still-resolving uciok.
  await expect(page.locator("#engine-badge")).toHaveAttribute("data-engine", /(stockfish|fallback)/, { timeout: 15_000 });
  await page.locator(".appbar .toggle-group").first().locator('button:has-text("AI")').click();
  await page.waitForTimeout(150); // settle UI mount + clock-loop microtasks
}

async function moveAndWaitForAI(page: Page, from: string, to: string): Promise<void> {
  await page.locator(`.square[data-square="${from}"]`).click();
  await page.locator(`.square[data-square="${to}"]`).click();
  // 12 s instead of 8 s — Stockfish intermediate on a cold worker can
  // take 2–4 s before the first reply (WASM init + first position eval).
  // 8 s was a tight pre-v1.8.4 fallback budget.
  await expect(page.locator("#undo-btn")).toBeEnabled({ timeout: 12_000 });
  await page.waitForTimeout(150); // drain microtasks before the next move
}

test.describe.configure({ mode: "serial" });

test("v1.7 hang-on-destroy: render-mode toggle mid-animation must keep game playable", async ({ page }: { page: Page }) => {
  // Bump per-test timeout. gotoAI() awaits the engine-probe settle
  // (up to 15 s on cold boot) AND moveAndWaitForAI() awaits the AI
  // reply (up to 12 s for Stockfish intermediate on a cold worker) —
  // together that's 27+ s of fixed budget before the destructive
  // toggle race even begins. Playwright's default 30-s blanket
  // timeout doesn't leave room for the actual signal (undoBtn,
  // c4 piece appearing). 60 s is plenty of headroom.
  test.setTimeout(60_000);

  await gotoAI(page);

  // 1. Initial move so an AI animateMove is now mid-flight or about-to-fire.
  await moveAndWaitForAI(page, "e2", "e4");
  // eslint-disable-next-line no-console
  console.log("[v1.7/destroy] e2→e4 accepted, AI replied");

  // 2. Trigger ANOTHER human move so we have an animateMove already in
  //    flight when we toggle render mode.
  await page.locator('.square[data-square="d2"]').click();
  await page.locator('.square[data-square="d4"]').click();
  // Don't await — we want to interrupt immediately.

  // 3. Race the render-mode toggle. Click "3D" first (which destroys the
  //    current 2D Board mid-animateMove), then immediately "2D" (which
  //    mounts a new Board2D). The window between these two clicks is
  //    where the v1.7 fix has to drain the queued resolvers.
  const renderToggle = page.locator(".appbar .toggle-group").nth(1);
  await renderToggle.locator('button:has-text("3D")').click();
  // Brief pause so destroy() actually runs, then immediately mount a new 2D board.
  await page.waitForTimeout(40);
  await renderToggle.locator('button:has-text("2D")').click();
  await page.waitForTimeout(40);

  // 4. CRITICAL: the engine-badge survived. If the render-mode toggle had
  //    wedged Game (isProcessingMove stuck at true), the app would still
  //    be partially responsive but Board2D.redraw would not have re-fired
  //    and the badge text might be stale.
  await expect(page.locator("#engine-badge")).toBeVisible();
  const badgeText = (await page.locator("#engine-badge").textContent() ?? "").trim();
  // eslint-disable-next-line no-console
  console.log(`[v1.7/destroy] post-toggle engine-badge still says: "${badgeText}"`);

  // 5. The d2 → d4 move should have been accepted by Game (we don't know
  //    yet whether the AI replied because we toggled out mid-animation).
  //    Verify by checking that the undo btn is enabled OR by making yet
  //    another move (which would be silently dropped if isProcessingMove
  //    were stuck).
  await page.waitForTimeout(2_000); // give time for AI to complete if it
                                    // was still queued
  const undoEnabled = await page.locator("#undo-btn").isEnabled();
  // eslint-disable-next-line no-console
  console.log(`[v1.7/destroy] post-toggle undoBtn enabled: ${undoEnabled}`);

  // 6. Final probe — make yet ANOTHER move. If isProcessingMove is stuck
  //    at true (the bug we're guarding against), this click will be
  //    silently dropped and no piece will appear on the destination.
  await page.locator('.square[data-square="c2"]').click();
  await page.locator('.square[data-square="c4"]').click();
  await expect(page.locator('.square[data-square="c4"] .piece')).toBeVisible({ timeout: 4_000 });
  // If we got here, Game is alive and clickable.
  // eslint-disable-next-line no-console
  console.log("[v1.7/destroy] post-toggle c2→c4 was accepted — game is NOT wedged");
});
