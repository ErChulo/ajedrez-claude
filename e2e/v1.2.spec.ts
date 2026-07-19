// v1.2 full-feature playtest.
//
// Exercises every v1.2 surface end-to-end and prints per-feature results
// so the test output reads as a playtest report rather than a cryptic
// pass/fail. Run with: `npx playwright test --project=chromium e2e/v1.2.spec.ts`
//
// What it covers:
//   1. Status-strip layout: engine-badge is in #status-strip (not in
//      settings card); side/hint/undo collapse on Online tab and restore
//      on AI tab.
//   2. Engine badge: text + data-engine attribute are honest.
//   3. Hint button: disabled when fallback, enabled (with .hint-square)
//      when Stockfish loaded.
//   4. Undo button: enabled after ≥2 ply; restores position; hidden in
//      Online mode.
//   5. Resign button: fires GameOverModal (status flips to "resigned"
//      and modal renders).

import { test, expect, type Page } from "@playwright/test";

// Each describe is serial so steps track each other, but tests are
// independent enough that they can re-bootstrap a fresh browser context.
test.describe.configure({ mode: "serial" });

async function waitForProbe(page: Page): Promise<"stockfish" | "fallback"> {
  const badge = page.locator("#engine-badge");
  // The dev server auto-spawns if the URL isn't reachable; the eager probe
  // resolves in ~0–2.5 s. Give it 5 s.
  await expect(badge).toHaveAttribute("data-engine", /(stockfish|fallback)/, { timeout: 5_000 });
  const value = await badge.getAttribute("data-engine");
  return (value === "stockfish" ? "stockfish" : "fallback");
}

test("v1.2 [1/5] engine-badge lives in the status strip, not the Settings card", async ({ page }) => {
  await page.goto("/");
  await waitForProbe(page);
  const inStrip = await page.locator("#status-strip #engine-badge").count();
  const inCard = await page.locator(".card #engine-badge").count();
  // eslint-disable-next-line no-console
  console.log(`[v1.2/strip] engine-badge in strip: ${inStrip}; in any card: ${inCard}`);
  expect(inStrip).toBe(1);
  expect(inCard).toBe(0);
});

test("v1.2 [2/5] status strip controls collapse on Online tab and restore on AI tab", async ({ page }) => {
  await page.goto("/");
  await waitForProbe(page);

  // Baseline AI mode: all controls visible.
  await page.locator(".appbar .toggle-group").first().locator('button:has-text("AI")').click();
  await page.waitForTimeout(300);
  const sideAI = await page.locator("#human-side-select").isVisible();
  const hintAI = await page.locator("#hint-btn").isVisible();
  const undoAI = await page.locator("#undo-btn").isVisible();
  // eslint-disable-next-line no-console
  console.log(`[v1.2/strip] AI mode → sideVisible=${sideAI} hintVisible=${hintAI} undoVisible=${undoAI}`);
  expect(sideAI).toBe(true);
  expect(hintAI).toBe(true);
  expect(undoAI).toBe(true);

  // Online mode: strip collapses (online-not-configured branch still flips
  // statusStrip into .mode-online via setStatusStripMode).
  await page.locator(".appbar .toggle-group").first().locator('button:has-text("Online")').click();
  await page.waitForTimeout(500);
  const sideOn = await page.locator("#human-side-select").isVisible().catch(() => false);
  const hintOn = await page.locator("#hint-btn").isVisible().catch(() => false);
  const undoOn = await page.locator("#undo-btn").isVisible().catch(() => false);
  const engineOn = await page.locator("#engine-badge").isVisible();
  // eslint-disable-next-line no-console
  console.log(`[v1.2/strip] Online mode → engineVisible=${engineOn} sideVisible=${sideOn} hintVisible=${hintOn} undoVisible=${undoOn}`);
  expect(engineOn).toBe(true);
  expect(sideOn).toBe(false);
  expect(hintOn).toBe(false);
  expect(undoOn).toBe(false);

  // Switch back to AI to ensure toggle round-trip works.
  await page.locator(".appbar .toggle-group").first().locator('button:has-text("AI")').click();
  await page.waitForTimeout(300);
  const sideBack = await page.locator("#human-side-select").isVisible();
  // eslint-disable-next-line no-console
  console.log(`[v1.2/strip] AI restored → sideVisible=${sideBack}`);
  expect(sideBack).toBe(true);
});

test("v1.2 [3/5] engine badge is honest (text matches data-engine)", async ({ page }) => {
  await page.goto("/");
  const kind = await waitForProbe(page);
  const text = (await page.locator("#engine-badge").textContent())?.trim() ?? "";
  // eslint-disable-next-line no-console
  console.log(`[v1.2/engine] kind=${kind} text="${text}"`);
  if (kind === "stockfish") {
    expect(text.toLowerCase()).toContain("stockfish");
  } else {
    // fallback: text should be the warning label, NOT "Probing…" anymore
    // (the latter would mean the probe hasn't resolved).
    expect(text.toLowerCase()).toContain("random");
    expect(text.toLowerCase()).not.toContain("probing");
  }
});

test("v1.2 [4/5] hint button is disabled when fallback; enabled with 2 .hint-square when Stockfish", async ({ page }) => {
  await page.goto("/");
  const kind = await waitForProbe(page);
  const hintBtn = page.locator("#hint-btn");
  if (kind === "fallback") {
    const isDisabled = await hintBtn.isDisabled();
    // eslint-disable-next-line no-console
    console.log(`[v1.2/hint] fallback → hint disabled: ${isDisabled}`);
    expect(isDisabled).toBe(true);
  } else {
    expect(await hintBtn.isEnabled()).toBe(true);
    // After clicking, two `.hint-square` elements should appear (from→to).
    await hintBtn.click();
    await expect(page.locator(".hint-square")).toHaveCount(2, { timeout: 8_000 });
    // eslint-disable-next-line no-console
    console.log(`[v1.2/hint] Stockfish → highlighted ${await page.locator(".hint-square").count()} squares`);
    // After autohide, the highlights should clear.
    await page.waitForTimeout(3_000);
    const after = await page.locator(".hint-square").count();
    // eslint-disable-next-line no-console
    console.log(`[v1.2/hint] after 3s autohide → ${after} hint squares (expected 0)`);
    expect(after).toBe(0);
  }
});

test("v1.2 [5/5] undo + resign end-to-end", async ({ page }) => {
  await page.goto("/");
  // Settle the eager engine probe BEFORE interactive moves so
  // undoBtn's undoBtn.disabled formula (s.isAiThinking === false)
  // isn't racing the bridge's uciok handshake.
  await waitForProbe(page);
  await page.locator(".appbar .toggle-group").first().locator('button:has-text("AI")').click();

  // 1. Move e2 → e4.
  await page.locator('.square[data-square="e2"]').click();
  await page.locator('.square[data-square="e4"]').click();
  // 12 s instead of 8 s — Stockfish intermediate on a cold worker
  // can take 2–4 s before the first reply (WASM init + first eval);
  // 8 s was a tight pre-v1.8.4 fallback budget.
  await expect(page.locator("#undo-btn")).toBeEnabled({ timeout: 12_000 });
  // eslint-disable-next-line no-console
  console.log(`[v1.2/play] e2→e4 accepted; AI replied; undoBtn enabled`);

  // 2. Undo: position should rewind 2 ply to a fresh starting position.
  await page.locator("#undo-btn").click();
  await expect(page.locator('.square[data-square="e2"] .piece')).toBeVisible({ timeout: 2_000 });
  await expect(page.locator('.square[data-square="e4"] .piece')).toHaveCount(0);
  // eslint-disable-next-line no-console
  console.log(`[v1.2/play] undo → e2 pawn restored, e4 cleared`);

  // 3. Replay the move + resign so we get a GameOverModal.
  await page.locator('.square[data-square="e2"]').click();
  await page.locator('.square[data-square="e4"]').click();
  await expect(page.locator("#undo-btn")).toBeEnabled({ timeout: 8_000 });

  // Click top-bar Resign (red button).
  await page.locator('button:has-text("Resign")').click();
  await page.waitForTimeout(500);
  const modal = page.locator(".modal");
  const modalVisible = await modal.isVisible().catch(() => false);
  // eslint-disable-next-line no-console
  console.log(`[v1.2/play] resign → modal visible: ${modalVisible}`);
  if (modalVisible) {
    const text = (await modal.textContent())?.trim().slice(0, 120) ?? "";  // eslint-disable-next-line no-console
  console.log(`[v1.2/play] modal text (truncated): "${text}"`);
  }
  expect(modalVisible).toBe(true);
});

test("v1.2 [6/6] white and black pieces render with distinguishable 2D art", async ({ page }) => {
  await page.goto("/");
  await waitForProbe(page);

  const readPiece = (square: string) => page
    .locator(`.square[data-square="${square}"] .piece`)
    .first()
    .evaluate((el) => {
      const svg = el.querySelector("svg g");
      if (svg) {
        const cs = getComputedStyle(svg);
        return { kind: "svg", fill: cs.fill, stroke: cs.stroke, src: "" };
      }
      const img = el.querySelector("img") as HTMLImageElement | null;
      return {
        kind: "img",
        fill: "",
        stroke: "",
        src: img?.getAttribute("src") ?? "",
        width: img?.naturalWidth ?? 0,
        height: img?.naturalHeight ?? 0,
      };
    });

  const whitePiece = await readPiece("e1");
  const blackPiece = await readPiece("e8");

  if (whitePiece.kind === "img" || blackPiece.kind === "img") {
    expect(whitePiece.kind).toBe("img");
    expect(blackPiece.kind).toBe("img");
    expect(whitePiece.src).toContain("w_King.png");
    expect(blackPiece.src).toContain("b_King.png");
    expect(whitePiece.src).not.toEqual(blackPiece.src);
    expect(whitePiece.width).toBeGreaterThan(0);
    expect(whitePiece.height).toBeGreaterThan(0);
    expect(blackPiece.width).toBeGreaterThan(0);
    expect(blackPiece.height).toBeGreaterThan(0);
    return;
  }

  const { fill: whiteKindFill, stroke: whiteKindStroke } = whitePiece;
  const { fill: blackKindFill, stroke: blackKindStroke } = blackPiece;
  // eslint-disable-next-line no-console
  console.log(`[v1.2/colors] white king (e1) fill=${whiteKindFill} stroke=${whiteKindStroke}`);
  // eslint-disable-next-line no-console
  console.log(`[v1.2/colors] black king (e8) fill=${blackKindFill} stroke=${blackKindStroke}`);

  // 1. Fill colors must visually separate the two sides.
  expect(whiteKindFill).not.toEqual(blackKindFill);

  // Convert rgb()/rgba() to a normalized lightness in [0, 1].
  const lightness = (rgb: string): number => {
    const m = rgb.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (!m) return -1;
    return ((+m[1] + +m[2] + +m[3]) / 3) / 255;
  };
  const wFill = lightness(whiteKindFill);
  const bFill = lightness(blackKindFill);
  // eslint-disable-next-line no-console
  console.log(`[v1.2/colors] fill lightness — white=${wFill.toFixed(3)} black=${bFill.toFixed(3)}`);
  // Chess convention: at least ~30 % lightness delta so a player can tell
  // them apart at a glance. (Without the v1.2 piece-color fix, both kings
  // ended up in the same dark-brown range, ~0.15 — this would fail.)
  expect(Math.abs(wFill - bFill)).toBeGreaterThan(0.30);

  // 2. Stroke colors must come from the per-side CSS vars, so each piece
  //    carries its own contrasting outline against ANY square color.
  //    The strokes should NOT be the same hardcoded #000 we used before —
  //    they should be from --piece-stroke (white) and --piece-stroke-2
  //    (black), which the theme intentionally picks to invert per side.
  expect(whiteKindStroke).not.toEqual("rgb(0, 0, 0)");
  expect(blackKindStroke).not.toEqual("rgb(0, 0, 0)");
  // Stroke vs fill should contrast (white piece gets a DARK stroke; black
  // piece gets a LIGHT stroke in every theme the project ships).
  expect(lightness(whiteKindStroke)).toBeLessThan(wFill + 0.05);  // white stroke ≤ fill
  expect(lightness(blackKindStroke)).toBeGreaterThan(bFill - 0.05); // black stroke ≥ fill
});
