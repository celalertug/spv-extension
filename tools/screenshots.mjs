// Chrome Web Store screenshots (1280x800): the card on a real Marketplace listing, opened logged
// out on facebook.com with the extension loaded in Playwright Chromium. The run is recorded with
// tabtape (Repoburg); the replay link is printed at the end.
//   store/screenshot-1-notice.png    first-run notice (what is sent to TxDMV)
//   store/screenshot-2-card.png      the value, price vs SPV
//   store/screenshot-3-variants.png  similar variants priced on request
// Usage: node tools/screenshots.mjs [listingId]   (a vehicle listing without a VIN in it)
// Facebook's logged-out prompts (the login form in the header, the "Log in or sign up" bar) are
// hidden before each shot. Check the shots before uploading: retake anything that identifies the seller.
import { chromium } from 'playwright';
import { execSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const tabtape = await import(path.join(execSync('npm root -g').toString().trim(), 'repoburg/tabtape/playwright/tabtape.mjs'));
const EXT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const out = new URL('../store/', import.meta.url).pathname;
const ITEM = process.argv[2] || '1464033592278205';

await mkdir(out, { recursive: true });
const both = `${tabtape.extensionPath},${EXT}`;
const context = await tabtape.launch(chromium, {
  args: [`--disable-extensions-except=${both}`, `--load-extension=${both}`],
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
});
const page = await context.newPage();
const card = (sel = '.card') => page.locator('#spv-ext-card').locator(sel);
const state = () => page.evaluate(() => document.querySelector('#spv-ext-card')?.shadowRoot?.querySelector('.card')?.dataset.state || null);
async function waitState(want, ms = 45000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const s = await state();
    if (want.includes(s)) return s;
    await page.waitForTimeout(250);
  }
  throw new Error(`card state ${await state()}, wanted ${want.join('/')}`);
}
// Facebook's logged-out overlays (login dialog, cookie banner) cover the listing.
async function clearOverlays() {
  await page.keyboard.press('Escape').catch(() => {});
  for (const name of [/close/i, /decline optional cookies/i, /allow all cookies/i]) {
    const b = page.getByRole('button', { name }).first();
    if (await b.isVisible().catch(() => false)) await b.click({ timeout: 2000 }).catch(() => {});
  }
}

// Hides the login form in the header and the fixed "Log in or sign up" bar at the bottom.
async function hideLoginPrompts() {
  return page.evaluate(() => {
    let hidden = 0;
    const hide = (el) => { if (el && el.style.visibility !== 'hidden') { el.style.setProperty('visibility', 'hidden', 'important'); hidden++; } };
    const pass = document.querySelector('input[name="pass"], input[type="password"]');
    if (pass) {
      // The smallest ancestor holding the password field and the "Forgotten account?" link.
      let el = pass.parentElement;
      while (el && !/forgotten account|forgot/i.test(el.innerText || '')) el = el.parentElement;
      hide(el && el !== document.body ? el : pass.closest('form'));
    }
    for (const el of document.querySelectorAll('body *')) {
      if (getComputedStyle(el).position !== 'fixed' || el.closest('#spv-ext-card')) continue;
      if (/log in or sign up/i.test(el.innerText || '')) { el.style.setProperty('display', 'none', 'important'); hidden++; }
    }
    return hidden;
  });
}
async function shot(name) {
  await clearOverlays();
  await hideLoginPrompts();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${out}${name}` });
}

await tabtape.start(page, { name: 'StarTag store screenshots' });
await page.goto(`https://www.facebook.com/marketplace/item/${ITEM}/`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
await clearOverlays();
await tabtape.step(page, 'First-run notice');
await waitState(['consent']);
await shot('screenshot-1-notice.png');

await tabtape.step(page, 'OK: look up the value');
await card('button.ok').click();
if ((await waitState(['done', 'error'])) !== 'done') throw new Error(`no value: ${await card().innerText()}`);
await shot('screenshot-2-card.png');

const more = card('.more-alts');
if (await more.count()) {
  await tabtape.step(page, 'Similar variants');
  await more.click();
  await page.waitForTimeout(300);
  const end = Date.now() + 60000;
  while (Date.now() < end && (await card('.loading.small').count())) await page.waitForTimeout(250);
  await shot('screenshot-3-variants.png');
}
const rec = await tabtape.stop(context);
console.log(`screenshots in store/; replay: ${rec.url}`);
await context.close();
