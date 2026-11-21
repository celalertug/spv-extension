// Brand assets: writes the StarTag logo SVGs to assets/ and renders the PNG icons and README banner
// with Playwright's Chromium (no other dependencies).
// Usage: node tools/build_brand.mjs
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

export const BRAND = {
  name: 'StarTag',
  tagline: 'Texas SPV on every Marketplace car',
  navy: '#0B2A4A',
  red: '#C8102E',
  cream: '#FFF8EC',
};

const out = new URL('../assets/', import.meta.url);
const f = (n) => Number(n.toFixed(2));

// Five-point star centered on (cx, cy), point up.
function star(cx, cy, R, r = R * 0.42) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rad = i % 2 ? r : R;
    pts.push(`${f(cx + rad * Math.cos(a))},${f(cy + rad * Math.sin(a))}`);
  }
  return pts.join(' ');
}

// The mark: a price tag tilted 45° (tip up-left) with an upright star and a string through the hole.
// small: fewer details for 16-32 px.
function mark({ size = 128, small = false } = {}) {
  const tag = 'M -50 0 L -24 -30 L 40 -30 L 40 30 L -24 30 Z';
  const holeX = -28;
  const starX = 10;
  // Tag coordinates -> icon coordinates (rotated 45° around the center, scaled to leave a margin).
  const k = small ? 0.94 : 0.88;
  const at = (x, y) => [64 + k * (x - y) * Math.SQRT1_2, 64 + k * (x + y) * Math.SQRT1_2];
  const [sx, sy] = at(starX, 0);
  const [hx, hy] = at(holeX, 0);
  const frame = `translate(64 64) scale(${k}) rotate(45)`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 128 128">
  <defs><mask id="hole" maskUnits="userSpaceOnUse" x="0" y="0" width="128" height="128"><rect width="128" height="128" fill="#fff"/>${small ? '' : `<circle cx="${f(hx)}" cy="${f(hy)}" r="${f(7 * k)}" fill="#000"/>`}</mask></defs>
  <g mask="url(#hole)"><path d="${tag}" transform="${frame}" fill="none" stroke="${BRAND.cream}" stroke-width="${small ? 24 : 18}" stroke-linejoin="round"/>
  <path d="${tag}" transform="${frame}" fill="${BRAND.navy}" stroke="${BRAND.navy}" stroke-width="${small ? 14 : 10}" stroke-linejoin="round"/></g>
  ${small ? '' : `<path d="M -28 0 C -44 2, -52 14, -64 10" transform="${frame}" fill="none" stroke="${BRAND.red}" stroke-width="5" stroke-linecap="round"/>`}
  <polygon points="${star(sx, sy, k * (small ? 28 : 25))}" fill="#fff" stroke="#fff" stroke-width="${small ? 2 : 1.5}" stroke-linejoin="round"/>
  <polygon points="${star(sx, sy, k * (small ? 12.5 : 10.5))}" fill="${BRAND.red}"/>
</svg>`;
}

function banner() {
  return `<html><body style="margin:0">
<div id="b" style="width:1280px;height:400px;display:flex;align-items:center;gap:48px;padding:0 96px;box-sizing:border-box;background:${BRAND.cream};font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
  ${mark({ size: 220 })}
  <div>
    <div style="font-size:112px;font-weight:800;letter-spacing:-3px;color:${BRAND.navy};line-height:1">Star<span style="color:${BRAND.red}">Tag</span></div>
    <div style="font-size:36px;color:#4a5568;margin-top:18px">${BRAND.tagline}</div>
    <div style="font-size:24px;color:#718096;margin-top:10px">TxDMV Standard Presumptive Value · price check · similar variants</div>
  </div>
</div></body></html>`;
}

await mkdir(out, { recursive: true });
await writeFile(new URL('logo.svg', out), mark());
await writeFile(new URL('logo-small.svg', out), mark({ small: true }));

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const px of [16, 32, 48, 128]) {
  await page.setViewportSize({ width: px, height: px });
  await page.setContent(`<html><body style="margin:0;background:transparent">${mark({ size: px, small: px <= 32 })}</body></html>`);
  await page.locator('svg').screenshot({ path: new URL(`icon-${px}.png`, out).pathname, omitBackground: true });
}
await page.setViewportSize({ width: 1280, height: 400 });
await page.setContent(banner());
await page.locator('#b').screenshot({ path: new URL('banner.png', out).pathname });
await browser.close();
console.log('assets written');
