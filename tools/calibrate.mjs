// Calibration + evaluation over real Marketplace titles.
//
// Runs the resolver on a corpus of listing titles against the live SPV service, learning which
// characters SPV accepts at the VIN positions vPIC leaves open, per WMI. The learned characters
// are written to data/fills.json, which the extension uses as its starting point.
//
// Usage: node tools/calibrate.mjs corpus.json [limit] [maxSearch] [--alts] [--no-stop] [--trace out.json]
//   corpus.json: { items: [{ title, sub? }] } (Marketplace titles such as "2014 Lexus GS · GS 350 Sedan 4D";
//                test/calibration-corpus.json holds the 100 titles of test/calibration-report.json)
//   --alts       also ask for the similar variants of each listing, as a user clicking for them
//   --no-stop    search up to maxSearch candidates without the early stop (to re-check its thresholds
//                with --trace: where hits come in the queue, and what precedes them)
//   --trace f    write every candidate looked at per listing to f
//   SPV_ANSWERS=file  record TxDMV answers to file and replay them on later runs (one query per
//                VIN pattern and mileage reaches TxDMV across runs). Queries are counted either way.
// Each listing starts with an empty cache (only the learned fill characters carry over), so the
// query counts are those of a browser that has not seen the vehicle before.
import { readFile, writeFile } from 'node:fs/promises';
import { estimate, findAlternatives, parseTitle, patternOf } from '../src/resolver.js';
import { makeKeys, rankVariants, listingText } from '../src/match.js';
import { politeFetch } from '../src/polite.js';

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); if (i < 0) return null; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const has = (name) => { const i = argv.indexOf(name); if (i >= 0) argv.splice(i, 1); return i >= 0; };
const alts = has('--alts');
const noStop = has('--no-stop') ? { stopAfterMisses: Infinity, stopWithoutReal: Infinity } : {};
const tracePath = flag('--trace');
const [corpusPath, limitArg = '100', maxArg = '24'] = argv;

const root = new URL('../data/', import.meta.url);
const makes = JSON.parse(await readFile(new URL('makes.json', root), 'utf8'));
const indexes = new Map();
const loadIndex = async (k) => {
  if (!indexes.has(k)) indexes.set(k, JSON.parse(await readFile(new URL(`index/${k}.json`, root), 'utf8')));
  return indexes.get(k);
};
let seedFills = {};
try { seedFills = JSON.parse(await readFile(new URL('fills.json', root), 'utf8')); } catch {}

// Learned fill:* entries carry over between listings; everything else is per listing.
const fills = new Map();
let local = new Map();
const cache = {
  get: async (k) => (k.startsWith('fill:') ? fills : local).get(k),
  set: async (k, v) => { (k.startsWith('fill:') ? fills : local).set(k, v); },
};

// TxDMV at most 60 queries a minute; answers recorded per VIN pattern + mileage when SPV_ANSWERS is set.
const answersPath = process.env.SPV_ANSWERS;
let recorded = {};
if (answersPath) try { recorded = JSON.parse(await readFile(answersPath, 'utf8')); } catch {}
const live = politeFetch(fetch, { perMinute: 60, burst: 4 });
let liveQueries = 0;
const asHtml = (a) => (a.error
  ? `<td>Error: ${a.error}</td>`
  : `<table><tr><td>Year:</td><td>${a.year}</td></tr><tr><td>Make:</td><td>${a.make}</td></tr><tr><td>Model:</td><td>${a.model}</td></tr><tr><td>Private Value:</td><td>${a.valueText}</td></tr></table>`);
const fetchImpl = async (url, init) => {
  const q = new URLSearchParams(init.body);
  const key = `${patternOf(q.get('vin'))}|${q.get('mileage')}`;
  if (!recorded[key]) {
    liveQueries++;
    const res = await live(url, init);
    if (!res.ok) return res;
    const html = await res.text();
    const err = html.match(/Error:\s*([^<]+)/);
    const f = (l) => { const m = html.match(new RegExp(`${l}:\\s*</td>\\s*<td[^>]*>([\\s\\S]*?)</td>`, 'i')); return m ? m[1].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : null; };
    if (!err && !f('Private Value')) return new Response(html);
    recorded[key] = err ? { error: err[1].trim() } : { year: f('Year'), make: f('Make'), model: f('Model'), valueText: f('Private Value') };
  }
  return new Response(asHtml(recorded[key]));
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
const traces = [];
for (const [n, l] of run.entries()) {
  local = new Map();
  const t0 = Date.now();
  const trace = [];
  const deps = { makes, loadIndex, cache, seedFills, fetchImpl, maxSearch: Number(maxArg), ...noStop, trace };
  const r = await estimate(l, deps);
  const row = { title: l.title, ok: r.ok, queries: r.queries, search: r.searchQueries, tried: r.tried, real: r.fromReal, conf: r.confidence, model: r.ok ? `${r.spv.model} ${r.spv.valueText}` : r.error, label: r.label, alts: r.ok ? r.alternatives.length : 0, more: !!r.moreAlternatives };
  if (alts && r.ok && r.moreAlternatives) {
    const a = await findAlternatives(l, deps);
    Object.assign(row, { altQueries: a.queries, altsOnRequest: a.ok ? a.alternatives.length : a.error });
  }
  rows.push(row);
  traces.push({ title: l.title, ok: r.ok, trace });
  if (answersPath) await writeFile(answersPath, JSON.stringify(recorded));
  console.log(`${String(n + 1).padStart(3)} ${r.ok ? 'OK ' : 'ERR'} q=${String(r.queries ?? 0).padStart(2)} s=${String(r.searchQueries ?? '-').padStart(2)}${r.fromReal ? 'R' : ' '} a=${row.alts}${row.more ? '+' : ' '}${row.altQueries !== undefined ? ` aq=${String(row.altQueries).padStart(2)}/${row.altsOnRequest}` : ''} ${r.ok ? r.confidence.padEnd(6) : '      '} ${l.title.slice(0, 50).padEnd(50)} -> ${r.ok ? `${r.spv.model} ${r.spv.valueText} [${r.label}]` : r.error} (${Date.now() - t0}ms)`);
}

const ok = rows.filter((r) => r.ok);
const total = rows.reduce((s, r) => s + (r.queries || 0), 0);
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
console.log(`\nresolved ${ok.length}/${rows.length} (${Math.round((100 * ok.length) / rows.length)}%), SPV queries ${total} (mean ${(total / rows.length).toFixed(1)}, median ${med(rows.map((r) => r.queries || 0))}, max ${Math.max(...rows.map((r) => r.queries || 0))}); ${liveQueries} sent to TxDMV in this run`);
console.log(`queries to find the first match: median ${med(ok.map((r) => r.search))}, mean ${(ok.reduce((a, r) => a + r.search, 0) / ok.length).toFixed(1)}; from a real prefix: ${ok.filter((r) => r.real).length}`);
console.log('confidence:', ['high', 'medium', 'low'].map((c) => `${c} ${ok.filter((r) => r.conf === c).length}`).join(', '));
console.log(`similar variants without asking: ${ok.filter((r) => r.alts).length} listings have some (${ok.reduce((s, r) => s + r.alts, 0)} in all), ${ok.filter((r) => r.more).length} offer more on request`);
if (alts) {
  const asked = rows.filter((r) => r.altQueries !== undefined);
  const aq = asked.reduce((s, r) => s + r.altQueries, 0);
  console.log(`on request: ${asked.length} listings, ${aq} queries (mean ${(aq / Math.max(1, asked.length)).toFixed(1)}), ${asked.reduce((s, r) => s + (Number(r.altsOnRequest) || 0), 0)} variants found`);
}

// Merge learned characters into data/fills.json.
const merged = { ...seedFills };
for (const [k, counts] of fills) {
  const wmi = k.slice(5);
  const learned = counts.map((c) => Object.entries(c).sort((a, b) => b[1] - a[1]).map(([ch]) => ch).join(''));
  const prev = merged[wmi] || ['', '', '', '', ''];
  merged[wmi] = learned.map((s, i) => [...new Set([...s, ...prev[i]])].join(''));
}
await writeFile(new URL('fills.json', root), JSON.stringify(merged));
console.log(`fills.json: ${Object.keys(merged).length} WMIs`);
await writeFile(new URL('../test/calibration-report.json', import.meta.url), JSON.stringify(rows, null, 1));
if (tracePath) await writeFile(tracePath, JSON.stringify(traces, null, 1));
