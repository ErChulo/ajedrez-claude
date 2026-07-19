import { chromium } from 'playwright';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await ctx.newPage();
const errs = [];
page.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE: ' + m.text()); });
page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle', timeout: 25000 });
await page.waitForTimeout(1500);
async function snap(s) { const n = await page.locator('.square .piece').count(); console.log(s + ': ' + n + ' pieces'); return n; }
await snap('initial');
for (const style of ['bold','outline','filled','minimal','ornate','classic']) {
  await page.selectOption('#piece-style-select', style);
  await page.waitForTimeout(600);
  await snap(style);
  await page.screenshot({ path: '/tmp/ajedrez-v12f-2d-' + style + '.png' });
}
console.log('ERR:', errs.length ? errs.join('\n  ') : '(none)');
await browser.close();
