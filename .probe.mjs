import { chromium } from '@playwright/test';
(async () => {
  console.log('== PROBE START ==');
  const browser = await chromium.launch();
  const page = await browser.newContext().then(c => c.newPage());
  const messages = [];
  const workerMessages = [];
  page.on('console', (msg) => { messages.push('[' + msg.type() + '] ' + msg.text()); });
  page.on('pageerror', (err) => { messages.push('[pageerror] ' + err.message); });
  await page.goto('http://localhost:5173/', { waitUntil: 'load' });

  // Poll engine-badge attribute for up to 14s
  let attr = null;
  let text = '';
  let settled = false;
  for (let i = 0; i < 28; i++) {
    await page.waitForTimeout(500);
    attr = await page.locator('#engine-badge').getAttribute('data-engine');
    text = (await page.locator('#engine-badge').textContent() ?? '').trim();
    if (attr === 'stockfish') { settled = true; break; }
  }

  const shimHttp = await page.request.get('http://localhost:5173/stockfish.js').then(r => r.status());
  const wasmHttp = await page.request.get('http://localhost:5173/stockfish.wasm').then(r => r.status());
  const bridgeHttp = await page.request.get('http://localhost:5173/stockfish-bridge.js').then(r => r.status());

  console.log('\n== ENGINE BADGE ==');
  console.log('data-engine     =', attr);
  console.log('badge text      =', text);
  console.log('settled @ tick  =', settled ? 'YES' : 'NO');
  console.log('\n== ASSET HTTP ==');
  console.log('/stockfish.js          -> HTTP', shimHttp);
  console.log('/stockfish.wasm        -> HTTP', wasmHttp);
  console.log('/stockfish-bridge.js   -> HTTP', bridgeHttp);
  console.log('\n== CONSOLE MESSAGES (last 25) ==');
  messages.slice(-25).forEach(m => console.log(m));
  await browser.close();
  console.log('\n== PROBE END ==');
})().catch(e => { console.error('PROBE_ERROR:', e.message); process.exit(1); });
