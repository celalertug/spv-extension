// E2E: load the SPV extension next to tabtape and check the card on Marketplace pages.
//  A. SPA flow: a stub Marketplace page opens the listing with pushState + XHR to
//     /ajax/route-definition/, answered with the response recorded in tabtape session
//     20261121-003647-2dff65 (2013 Lexus GS, no VIN).
//  B. Real facebook.com, logged out, hard load of the same listing.
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import path from 'node:path';

const tabtape = await import(path.join(execSync('npm root -g').toString().trim(), 'repoburg/tabtape/playwright/tabtape.mjs'));
const EXT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const ITEM = '1464033592278205';
const routeDef = await readFile(new URL('./fixtures/route-def.txt', import.meta.url), 'utf8');

const both = `${tabtape.extensionPath},${EXT}`;
const context = await tabtape.launch(chromium, {
  args: [`--disable-extensions-except=${both}`, `--load-extension=${both}`],
  viewport: { width: 1400, height: 900 },
});
const page = await context.newPage();
page.on('console', (m) => { if (m.type() === 'error' && /spv/i.test(m.text())) console.log('console:', m.text()); });

const cardText = () => page.evaluate(() => document.querySelector('#spv-ext-card')?.shadowRoot?.querySelector('.card')?.innerText || null);
const cardState = () => page.evaluate(() => document.querySelector('#spv-ext-card')?.shadowRoot?.querySelector('.card')?.dataset.state || null);
async function waitCard(timeout = 40000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const s = await cardState();
    if (s === 'done' || s === 'error') return s;
    await page.waitForTimeout(250);
  }
  return await cardState();
}

const results = {};

// ---- A. SPA flow against the recorded response
await context.route('https://www.facebook.com/marketplace/?spv-e2e=1', (route) => route.fulfill({
  contentType: 'text/html',
  body: `<!doctype html><html><head><title>Facebook Marketplace | Facebook</title></head><body>
    <h1>Marketplace (stub)</h1>
    <a id="open" href="/marketplace/item/${ITEM}/">$8,500 2013 Lexus GS 350 Sedan 4D</a>
    <script>
      document.getElementById('open').addEventListener('click', (e) => {
        e.preventDefault();
        const x = new XMLHttpRequest();
        x.open('POST', '/ajax/route-definition/?spv-e2e=1');
        x.onload = () => { history.pushState({}, '', '/marketplace/item/${ITEM}/'); document.title = 'Marketplace – 2013 Lexus GS · GS 350 Sedan 4D | Facebook'; };
        x.send('route_urls[0]=/marketplace/item/${ITEM}/');
      });
    </script></body></html>`,
}));
await context.route('https://www.facebook.com/ajax/route-definition/?spv-e2e=1', (route) => route.fulfill({ contentType: 'text/html; charset="utf-8"', body: routeDef }));

const recA = await tabtape.start(page, { name: 'SPV extension: Marketplace SPA flow (recorded Lexus GS response)' });
await page.goto('https://www.facebook.com/marketplace/?spv-e2e=1');
await tabtape.step(page, 'Open the listing from the feed');
await page.click('#open');
const t0 = Date.now();
const stateA = await waitCard();
results.A = { state: stateA, ms: Date.now() - t0, text: await cardText() };
await page.screenshot({ path: '/tmp/spv-e2e-A.png' });
await tabtape.step(page, 'SPV card shown');
const head = page.locator('#spv-ext-card .head');
await head.click();
results.A.collapsed = await page.evaluate(() => document.querySelector('#spv-ext-card').shadowRoot.querySelector('.card').classList.contains('collapsed'));
await page.screenshot({ path: '/tmp/spv-e2e-A-collapsed.png' });
await head.click();
const box = await head.boundingBox();
await page.mouse.move(box.x + 60, box.y + 10);
await page.mouse.down();
await page.mouse.move(box.x - 600, box.y + 400, { steps: 8 });
await page.mouse.up();
results.A.dragged = await page.evaluate(() => ({ pos: localStorage.getItem('spvExtCardPos'), collapsed: document.querySelector('#spv-ext-card').shadowRoot.querySelector('.card').classList.contains('collapsed') }));
await page.screenshot({ path: '/tmp/spv-e2e-A-dragged.png' });
await tabtape.step(page, 'Card collapsed, expanded and dragged');
await page.waitForTimeout(800);
await tabtape.step(page, 'Navigate back to the feed: the card goes away');
await page.goBack();
await page.waitForTimeout(1200);
results.A.afterBack = await cardState();
// Another listing, through the same XHR + pushState path, with a fixture edited to other vehicle text.
const variantOf = (id, make, model, trim, title) => routeDef.replaceAll(ITEM, id)
  .replace('"vehicle_make_display_name":"Lexus"', `"vehicle_make_display_name":"${make}"`)
  .replace('"vehicle_model_display_name":"GS"', `"vehicle_model_display_name":"${model}"`)
  .replace('"vehicle_trim_display_name":"GS 350 Sedan 4D"', `"vehicle_trim_display_name":"${trim}"`)
  .replace('"marketplace_listing_title":"2013 Lexus GS \\u00b7 GS 350 Sedan 4D"', `"marketplace_listing_title":"${title}"`)
  .replace('"custom_title":"2013 Lexus GS 350 Sedan 4D"', `"custom_title":"${title}"`);
async function openListing(n, id, body) {
  await context.route(`https://www.facebook.com/ajax/route-definition/?spv-e2e=${n}`, (route) => route.fulfill({ contentType: 'text/html; charset="utf-8"', body }));
  await page.evaluate(([n, id]) => new Promise((res) => {
    const x = new XMLHttpRequest();
    x.open('POST', `/ajax/route-definition/?spv-e2e=${n}`);
    x.onload = () => { history.pushState({}, '', `/marketplace/item/${id}/`); res(); };
    x.send('');
  }), [n, id]);
  await page.waitForTimeout(700); // the content script notices the URL change within 300 ms
}
const shadow = (sel) => page.evaluate((sel) => document.querySelector('#spv-ext-card').shadowRoot.querySelector(sel)?.innerText || null, sel);

// A 2016 Camry without trim has other variants (hybrid); picking one makes it the main value.
await tabtape.step(page, 'Open a 2016 Toyota Camry listing');
await openListing(2, '1464033592278111', variantOf('1464033592278111', 'Toyota', 'Camry', '', '2016 Toyota Camry'));
results.A.camry = { state: await waitCard(), text: await cardText() };
const altCount = await page.evaluate(() => document.querySelector('#spv-ext-card').shadowRoot.querySelectorAll('[data-alt]').length);
if (altCount) {
  const before = await shadow('.value');
  await page.locator('#spv-ext-card [data-alt="0"]').click();
  results.A.choose = { before, after: await shadow('.value'), src: await shadow('.src') };
  await page.screenshot({ path: '/tmp/spv-e2e-A-choose.png' });
  await tabtape.step(page, 'Picked another variant');
}

// A listing whose model text matches nothing: error with the VIN form; a VIN typed there is used.
const badId = '1464033592278999';
await tabtape.step(page, 'Open a listing with an unknown model');
await openListing(3, badId, variantOf(badId, 'Lexus', 'zzqq wagon thing', '', '2013 Lexus zzqq wagon thing'));
results.A.unknownModel = { state: await waitCard(), text: await cardText() };
await page.screenshot({ path: '/tmp/spv-e2e-A-error.png' });
await page.locator('#spv-ext-card details.vin summary').click();
await page.locator('#spv-ext-card details.vin input').fill('1hgcm82633a004352');
await page.locator('#spv-ext-card details.vin button').click();
await waitCard();
results.A.userVin = { value: await shadow('.value'), src: await shadow('.src') };
await page.screenshot({ path: '/tmp/spv-e2e-A-uservin.png' });
await tabtape.step(page, 'Entered a VIN by hand');

// Non-vehicle listing: no vehicle fields, title without a year -> no card.
await page.evaluate(() => { history.pushState({}, '', '/marketplace/item/999000111/'); document.title = 'Marketplace – Wooden dining table | Facebook'; });
await page.waitForTimeout(7500);
results.A.nonVehicleCard = await cardState();
const stopA = await tabtape.stop(context);
results.A.replay = stopA.url;

// ---- B. Real facebook.com, logged out, full page load
await context.unrouteAll({ behavior: 'ignoreErrors' });
const page2 = await context.newPage();
const recB = await tabtape.start(page2, { name: 'SPV extension: facebook.com listing, logged out, full load' });
await page2.goto(`https://www.facebook.com/marketplace/item/${ITEM}/`, { waitUntil: 'domcontentloaded' });
const pageB = page2;
const endB = Date.now() + 45000;
let stateB = null;
while (Date.now() < endB) {
  stateB = await pageB.evaluate(() => document.querySelector('#spv-ext-card')?.shadowRoot?.querySelector('.card')?.dataset.state || null);
  if (stateB === 'done' || stateB === 'error') break;
  await pageB.waitForTimeout(300);
}
results.B = {
  state: stateB,
  title: await pageB.title(),
  url: pageB.url(),
  text: await pageB.evaluate(() => document.querySelector('#spv-ext-card')?.shadowRoot?.querySelector('.card')?.innerText || null),
  hasData: await pageB.evaluate(() => [...document.querySelectorAll('script[type="application/json"]')].some((s) => s.textContent.includes('vehicle_make_display_name'))),
};
await pageB.screenshot({ path: '/tmp/spv-e2e-B.png' });
const stopB = await tabtape.stop(context);
results.B.replay = stopB.url;

console.log(JSON.stringify(results, null, 2));
await context.close();
