import { test, expect, type Page } from "@playwright/test";

const VIEWPORTS = [
  { name: "phone", width: 375, height: 667 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1280, height: 800 },
] as const;

async function readLayout(page: Page): Promise<{
  innerWidth: number;
  innerHeight: number;
  scrollWidth: number;
  scrollHeight: number;
  board: { width: number; height: number; left: number; top: number; right: number; bottom: number };
}> {
  return page.evaluate(() => {
    const board = document.querySelector(".board-2d, .board-3d-host") as HTMLElement | null;
    if (!board) throw new Error("board not mounted");
    const rect = board.getBoundingClientRect();
    return {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight,
      board: {
        width: rect.width,
        height: rect.height,
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
      },
    };
  });
}

test("2D coordinate labels do not overlap", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto("/");
  await expect(page.locator(".board-2d")).toBeVisible();

  const result = await page.evaluate(() => {
    const labels = Array.from(document.querySelectorAll<HTMLElement>(".board-2d .file-rank"));
    const rects = labels.map((label) => ({
      text: label.textContent ?? "",
      className: label.className,
      rect: label.getBoundingClientRect(),
    }));
    const overlaps: string[] = [];
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const b = rects[j];
        const xOverlap = Math.max(0, Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left));
        const yOverlap = Math.max(0, Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top));
        if (xOverlap > 0.5 && yOverlap > 0.5) {
          overlaps.push(`${a.text}/${a.className} overlaps ${b.text}/${b.className}`);
        }
      }
    }
    return { count: labels.length, overlaps };
  });

  expect(result.count).toBe(16);
  expect(result.overlaps).toEqual([]);
});

for (const viewport of VIEWPORTS) {
  test(`2D board stays square and page does not overflow on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/");
    await expect(page.locator(".board-2d")).toBeVisible();

    const layout = await readLayout(page);
    expect(Math.abs(layout.board.width - layout.board.height)).toBeLessThanOrEqual(1);
    expect(layout.board.left).toBeGreaterThanOrEqual(0);
    expect(layout.board.top).toBeGreaterThanOrEqual(0);
    expect(layout.board.right).toBeLessThanOrEqual(layout.innerWidth + 1);
    expect(layout.board.bottom).toBeLessThanOrEqual(layout.innerHeight + 1);
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.innerWidth + 1);
    expect(layout.scrollHeight).toBeLessThanOrEqual(layout.innerHeight + 1);
  });
}

test("3D renderer uses the same square board slot", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto("/");
  await expect(page.locator(".board-2d")).toBeVisible();

  await page.locator(".appbar .toggle-group").nth(1).locator('button:has-text("3D")').click();
  await expect(page.locator('.board-host canvas, .board-host .three-fallback[data-state="webgl-unavailable"], .board-host .board-2d')).toBeVisible({ timeout: 60_000 });

  const canvas = page.locator(".board-host canvas");
  if (await canvas.isVisible().catch(() => false)) {
    const host = page.locator(".board-3d-host");
    await expect(host).toHaveAttribute("data-piece-assets", "ready", { timeout: 60_000 });
    await expect(host).toHaveAttribute("data-max-piece-footprint-ratio", /0\.[0-9]+|0|1/);
    const ratio = Number(await host.getAttribute("data-max-piece-footprint-ratio"));
    expect(ratio).toBeLessThanOrEqual(0.62);
  }

  const layout = await readLayout(page);
  expect(Math.abs(layout.board.width - layout.board.height)).toBeLessThanOrEqual(1);
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.innerWidth + 1);
  expect(layout.scrollHeight).toBeLessThanOrEqual(layout.innerHeight + 1);
});
