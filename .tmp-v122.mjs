import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const errors = [];
page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });
page.on('pageerror', e => errors.push('PAGEERR: ' + e.message));
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle', timeout: 25000 });
await page.waitForTimeout(1500);
async function snap(label) {
  const n = await page.locator('.square .piece').count();
  console.log(label + ': ' + n + ' pieces');
  return n;
}
await snap('initial');
for (const s of ['bold','outline','filled','minimal','ornate','classic']) {
  await page.selectOption('#piece-style-select', s);
  await page.waitForTimeout(700);
  await snap(s);
  await page.screenshot({ path: '/tmp/ajedrez-v122-2d-' + s + '.png' });
}
// Wedge regression: move + immediate style swap mid-tween
const e2 = await page.$('.square[data-square="e2"]');
if (e2) {
  await e2.click();
  await page.waitForTimeout(80);
  const e4 = await page.$('.square[data-square="e4"]');
  if (e4) await e4.click();
  await page.waitForTimeout(80);
  await page.selectOption('#piece-style-select', 'bold');
  await page.waitForTimeout(900);
  await snap('after-mid-anim');
  const undoEnabled = await page.locator('#undo-btn').isEnabled();
  console.log('undo enabled after wedge test:', undoEnabled);
}
await page.selectOption('#render-mode-select', '3d');
await page.waitForTimeout(3500);
await page.selectOption('#piece-style-select', 'ornate');
await page.waitForTimeout(1500);
await page.screenshot({ path: '/tmp/ajedrez-v122-3d-ornate.png' });
await page.selectOption('#piece-style-select', 'minimal');
await page.waitForTimeout(1500);
await page.screenshot({ path: '/tmp/ajedrez-v122-3d-minimal.png' });
console.log('ERR:', errors.length ? errors.join('\n  ') : '(none)');
await browser.close();
