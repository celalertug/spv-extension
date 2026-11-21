// Calibration + evaluation over real Marketplace titles.
//
// Runs the resolver on a corpus of listing titles against the live SPV service, learning which
// characters SPV accepts at the VIN positions vPIC leaves open, per WMI. The learned characters
// are written to data/fills.json, which the extension uses as its starting point.
//
// Usage: node tools/calibrate.mjs corpus.json [limit] [maxQueriesPerListing]
//   corpus.json: { items: [{ title, sub? }] } (Marketplace titles such as "2014 Lexus GS · GS 350 Sedan 4D")
import { readFile, writeFile } from 'node:fs/promises';
import { estimate, parseTitle } from '../src/resolver.js';
import { makeKeys, rankVariants, listingText } from '../src/match.js';

const [corpusPath, limitArg = '100', maxArg = '50'] = process.argv.slice(2);
const root = new URL('../data/', import.meta.url);
const makes = JSON.parse(await readFile(new URL('makes.json', root), 'utf8'));
const indexes = new Map();
const loadIndex = async (k) => {
  if (!indexes.has(k)) indexes.set(k, JSON.parse(await readFile(new URL(`index/${k}.json`, root), 'utf8')));
  return indexes.get(k);
};
let seedFills = {};
try { seedFills = JSON.parse(await readFile(new URL('fills.json', root), 'utf8')); } catch {}

// In-memory cache: only fill:* entries are kept, so each listing is resolved from scratch.
const store = new Map();
const cache = {
  get: async (k) => (k.startsWith('fill:') ? store.get(k) : undefined),
  set: async (k, v) => { if (k.startsWith('fill:')) store.set(k, v); },
};

const corpus = JSON.parse(await readFile(corpusPath, 'utf8')).items;
const seen = new Set();
const listings = [];
for (const it of corpus) {
  const p = parseTitle(it.title, makes);
  if (!p.year || p.year < 1981 || !p.make) continue;
  const key = `${p.year}|${p.make}|${p.model}|${p.trim}`.toLowerCase();
  if (seen.has(key)) continue;
  seen.add(key);
  const keys = makeKeys(p.make, makes);
  if (!keys.length) continue;
  const tf = listingText({ ...p, title: it.title });
  let best = -1;
  for (const k of keys) for (const v of rankVariants(await loadIndex(k), { ...p, title: it.title }, tf).slice(0, 1)) best = Math.max(best, v.score);
  if (best < 3) continue; // not a vehicle the index knows (parts, trailers, boats)
  const miles = it.sub && it.sub.match(/([\d.]+)(K?)\s*miles/i);
  listings.push({ ...p, title: it.title, mileage: miles ? Math.round(Number(miles[1]) * (miles[2] ? 1000 : 1)) : 0 });
}
const run = listings.slice(0, Number(limitArg));
console.log(`listings: ${listings.length} candidates, running ${run.length}`);

const rows = [];
let total = 0;
for (const [n, l] of run.entries()) {
  const t0 = Date.now();
  const r = await estimate(l, { makes, loadIndex, cache, seedFills, maxQueries: Number(maxArg), parallel: 2 });
  total += r.queries || 0;
  rows.push({ title: l.title, ok: r.ok, queries: r.queries, search: r.searchQueries, real: r.fromReal, conf: r.confidence, model: r.ok ? `${r.spv.model} ${r.spv.valueText}` : r.error, label: r.label });
  console.log(`${String(n + 1).padStart(3)} ${r.ok ? 'OK ' : 'ERR'} q=${String(r.queries ?? 0).padStart(2)} s=${String(r.searchQueries ?? '-').padStart(2)}${r.fromReal ? 'R' : ' '} ${r.ok ? r.confidence.padEnd(6) : '      '} ${l.title.slice(0, 60).padEnd(60)} -> ${r.ok ? `${r.spv.model} ${r.spv.valueText} [${r.label}]` : r.error} (${Date.now() - t0}ms)`);
}

const ok = rows.filter((r) => r.ok);
const qs = ok.map((r) => r.queries).sort((a, b) => a - b);
console.log(`\nresolved ${ok.length}/${rows.length} (${Math.round((100 * ok.length) / rows.length)}%), SPV queries ${total}, median per resolved ${qs[Math.floor(qs.length / 2)]}`);
const ss = ok.map((r) => r.search).sort((a, b) => a - b);
console.log(`queries to find the first match: median ${ss[Math.floor(ss.length / 2)]}, mean ${(ss.reduce((a, b) => a + b, 0) / ss.length).toFixed(1)}; from a real prefix: ${ok.filter((r) => r.real).length}`);
console.log('confidence:', ['high', 'medium', 'low'].map((c) => `${c} ${ok.filter((r) => r.conf === c).length}`).join(', '));

// Merge learned characters into data/fills.json.
const fills = { ...seedFills };
for (const [k, counts] of store) {
  const wmi = k.slice(5);
  const learned = counts.map((c) => Object.entries(c).sort((a, b) => b[1] - a[1]).map(([ch]) => ch).join(''));
  const prev = fills[wmi] || ['', '', '', '', ''];
  fills[wmi] = learned.map((s, i) => [...new Set([...s, ...prev[i]])].join(''));
}
await writeFile(new URL('fills.json', root), JSON.stringify(fills));
console.log(`fills.json: ${Object.keys(fills).length} WMIs`);
await writeFile(new URL('../test/calibration-report.json', import.meta.url), JSON.stringify(rows, null, 1));
