// Resolver and rate limiter against a fake SPV service: caching, budgets, TxDMV errors, abort.
// Usage: node test/offline.test.mjs
import { readFile } from 'node:fs/promises';
import { estimate, findAlternatives, lookupUserVin, parseSpvHtml, patternOf } from '../src/resolver.js';
import { politeFetch } from '../src/polite.js';
import { decodeVin, vinSpecs } from '../src/match.js';

const root = new URL('../data/', import.meta.url);
const makes = JSON.parse(await readFile(new URL('makes.json', root), 'utf8'));
const loadIndex = async (k) => JSON.parse(await readFile(new URL(`index/${k}.json`, root), 'utf8'));

let failed = 0;
const assert = (cond, msg) => { if (!cond) { failed++; console.log('  FAIL', msg); } else console.log('  ok  ', msg); };

const NOW = Date.parse('2026-11-21T12:00:00Z');
const newCache = () => {
  const store = new Map();
  return { store, get: async (k) => store.get(k), set: async (k, v) => { store.set(k, v); } };
};
// Fake SPV: every VIN is a Toyota Camry of `year`, valued by its VDS (so variants differ) and mileage.
function fakeSpv({ year, make = 'Toyota', model = 'Camry', status = 200, found = () => true } = {}) {
  const f = async (url, init) => {
    f.calls++;
    if (status !== 200) return new Response('down', { status });
    const q = new URLSearchParams(init.body);
    const vin = q.get('vin');
    if (!found(vin)) return new Response(`<td>Error: Your VIN "${vin}" was not found. Please check your VIN and try again.</td>`);
    const sum = [...vin.slice(3, 8)].reduce((s, c) => s + c.charCodeAt(0), 0);
    const value = 5000 + (sum % 7) * 250 - Math.round(Number(q.get('mileage')) / 100);
    return new Response(`<td>Year:</td><td>${year}</td><td>Make:</td><td>${make}</td><td>Model:</td><td>${model}</td><td>Private Value:</td><td>$${value.toLocaleString('en-US')}</td>`);
  };
  f.calls = 0;
  return f;
}
const camry = (mileage = 0, year = 2016) => ({ id: '1', year, make: 'Toyota', model: 'Camry', trim: '', title: `${year} Toyota Camry`, mileage });
const deps = (cache, fetchImpl, extra = {}) => ({ makes, loadIndex, cache, fetchImpl, now: () => NOW, ...extra });

console.log('parse');
assert(parseSpvHtml('<td>Error: Your VIN "X" was not found. Please</td>').notFound === true, 'SPV "not found" answer');
assert(parseSpvHtml('<html>Access denied</html>').transport === true, 'a page that is not an SPV answer is a transport error');

console.log('estimate, cache, variants on request');
{
  const cache = newCache();
  const spv = fakeSpv({ year: 2016 });
  const r1 = await estimate(camry(), deps(cache, spv));
  assert(r1.ok && r1.queries === 1, `first VIN alone resolves with 1 query (q=${r1.queries})`);
  assert(r1.alternatives.length === 0 && r1.moreAlternatives, 'no variants priced without asking; more offered');
  const r2 = await estimate(camry(), deps(cache, spv));
  assert(r2.ok && r2.cached && r2.queries === 0, `same listing again: 0 queries (q=${r2.queries})`);
  const a = await findAlternatives(camry(), deps(cache, spv));
  assert(a.ok && a.alternatives.length >= 1 && a.queries <= 12, `variants on request: ${a.alternatives.length} for ${a.queries} queries`);
  assert(a.alternatives.every((x) => x.value !== a.primary.value), 'variants differ in value from the main one');
  const r3 = await estimate(camry(), deps(cache, spv));
  assert(r3.queries === 0 && r3.alternatives.length === a.alternatives.length, 'after asking, the variants come from the cache');
  const calls = spv.calls;
  const r4 = await estimate(camry(80000), deps(cache, spv));
  assert(r4.ok && r4.queries === 1 && spv.calls === calls + 1, '2016 at another mileage: the main value is asked again (1 query)');
  assert(r4.alternatives.length === 0 && r4.moreAlternatives, 'variants not cached for that mileage are left for a request');
  const a4 = await findAlternatives(camry(80000), deps(cache, spv));
  assert(a4.ok && a4.alternatives.length && a4.alternatives[0].value !== a.alternatives.find((x) => x.vin === a4.alternatives[0].vin)?.value, 'on request they are re-priced for the mileage');
  assert(r1.specs && /^Camry/.test(r1.specs.name) && /^\d\.\dL 4-cyl/.test(r1.specs.engine || '') && !r1.specs.awd, `model and engine from the VIN: ${r1.specs && `${r1.specs.name} · ${r1.specs.engine}`}`);
  assert(a.primary.specs && a.alternatives.every((x) => x.specs && x.specs.name), 'similar variants carry their model and engine');
  const later = await estimate(camry(), deps(cache, spv, { now: () => NOW + 8 * 86400000 }));
  assert(later.queries === 1, 'answers expire after 7 days');
}
{
  const cache = newCache();
  const spv = fakeSpv({ year: 2010 });
  await estimate(camry(0, 2010), deps(cache, spv));
  const r = await estimate({ ...camry(150000, 2010), id: '2' }, deps(cache, spv));
  assert(r.ok && r.queries === 0, '2010 (no mileage adjustment): another mileage is answered from the cache');
}

console.log('not found, budget');
{
  const cache = newCache();
  const spv = fakeSpv({ year: 2016, found: () => false });
  const noStop = { stopAfterMisses: Infinity, stopWithoutReal: Infinity };
  const r1 = await estimate(camry(), deps(cache, spv, noStop));
  assert(!r1.ok && r1.queries === 24 && r1.tried === 24, `nothing found, no early stop: the 24-candidate budget (q=${r1.queries})`);
  const r2 = await estimate(camry(), deps(cache, spv, noStop));
  assert(!r2.ok && r2.queries === 0 && r2.tried === 24, 'again: the same candidates, all from the cache (0 queries)');
  const u = await lookupUserVin(camry(), '4T1BF1FK0GU000000', deps(cache, spv));
  assert(!u.ok && /not found/.test(u.error), 'a typed VIN SPV does not know: its error');
}
{
  const trace = [];
  const r = await estimate(camry(), deps(newCache(), fakeSpv({ year: 2016, found: () => false }), { trace }));
  const reals = trace.filter((t) => t.real).length;
  assert(!r.ok && r.queries === 3 && reals === 3 && /does not seem to have/.test(r.error), `2016 Camry, nothing found: stops after 3 real builds (q=${r.queries})`);
  // 1981: no NHTSA complaint data, so no real builds to try.
  const old = { id: '3', year: 1981, make: 'Cadillac', model: 'Eldorado', trim: 'Touring Coupe 2D', title: '1981 Cadillac Eldorado · Touring Coupe 2D' };
  const t2 = [];
  const r2 = await estimate(old, deps(newCache(), fakeSpv({ year: 1981, make: 'Cadillac', model: 'Eldorado', found: () => false }), { trace: t2 }));
  assert(!r2.ok && r2.queries === 10 && !t2.some((t) => t.real), `1981 Eldorado, nothing found, no real builds: stops after 10 (q=${r2.queries})`);
  const seventh = t2[6].pattern; // the 1981 Eldorado of the calibration was found at the 7th candidate
  const r3 = await estimate(old, deps(newCache(), fakeSpv({ year: 1981, make: 'Cadillac', model: 'Eldorado', found: (vin) => patternOf(vin) === seventh })));
  assert(r3.ok && r3.queries === 7, `a hit at the 7th candidate is still found (q=${r3.queries})`);
}

console.log('TxDMV errors, abort, dwell');
{
  const cache = newCache();
  const spv = fakeSpv({ year: 2016, status: 503 });
  const r = await estimate(camry(), deps(cache, spv));
  assert(!r.ok && r.retry && r.queries === 1 && spv.calls === 1, 'HTTP 503: one query, then the listing stops asking');
  assert(![...cache.store.keys()].some((k) => k.startsWith('spv:')), 'errors are not cached');
}
{
  let calls = 0;
  const slow = (u, init) => new Promise((res, rej) => {
    calls++;
    const t = setTimeout(() => res(new Response('<td>Error: Your VIN "X" was not found.</td>')), 200);
    init.signal.addEventListener('abort', () => { clearTimeout(t); rej(init.signal.reason); });
  });
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 300);
  let threw = null;
  try { await estimate(camry(), deps(newCache(), slow, { signal: ctrl.signal })); } catch (e) { threw = e.name; }
  assert(threw === 'AbortError' && calls <= 4, `leaving the listing aborts its queries (${calls} sent)`);
  calls = 0;
  const c2 = new AbortController();
  setTimeout(() => c2.abort(), 50);
  try { await estimate(camry(), deps(newCache(), slow, { signal: c2.signal, notBefore: Date.now() + 1500 })); } catch {}
  assert(calls === 0, 'leaving within the dwell time sends nothing');
  const cache = newCache();
  const spv = fakeSpv({ year: 2016 });
  await estimate(camry(), deps(cache, spv));
  const t0 = Date.now();
  const r = await estimate(camry(), deps(cache, spv, { notBefore: Date.now() + 1500 }));
  assert(r.ok && Date.now() - t0 < 500, 'cached answers do not wait for the dwell time');
}

console.log('rate limit');
{
  const ok = async () => new Response('ok');
  const pf = politeFetch(ok, { perMinute: 600, burst: 2 });
  const t0 = Date.now();
  const times = [];
  await Promise.all([0, 1, 2, 3].map(() => pf('x', {}).then(() => times.push(Date.now() - t0))));
  times.sort((a, b) => a - b);
  assert(times[1] < 50 && times[2] >= 80 && times[3] >= 180, `burst of 2, then 10/s (${times.join(', ')} ms)`);
  const bad = politeFetch(async () => new Response('x', { status: 429, headers: { 'retry-after': '3' } }), { perMinute: 600, burst: 5 });
  await bad('x', {});
  let busy = false;
  try { await bad('x', {}); } catch (e) { busy = !!e.busy; }
  assert(busy && bad.pausedFor() > 2000, '429 with Retry-After pauses all queries');
  const flaky = politeFetch(async () => { throw new TypeError('network'); }, { perMinute: 600, burst: 5 });
  await flaky('x', {}).catch(() => {});
  assert(flaky.pausedFor() > 25000, 'network failure pauses for 30 s');
}

console.log('VIN decode for the card');
{
  const specs = async (vin, year, make, spvModel) => {
    const d = decodeVin(await loadIndex(make), vin, year);
    if (!d) return null;
    const s = vinSpecs(d, spvModel);
    return `${s.name} | ${s.engine || ''}${s.awd ? ' | AWD' : ''}`;
  };
  const cases = [
    ['WBA5R7C00LFH12345', 2020, 'bmw', '3-Series', '330i xDrive Sedan | 2.0L 4-cyl | AWD'], // family name "3-Series" left out
    ['4T1BF1FK0EU123456', 2014, 'toyota', 'Camry', 'Camry | 2.5L 4-cyl'], // chassis code left out
    ['4T1B21HK0KU123456', 2019, 'toyota', 'Camry', 'Camry | 2.5L 4-cyl hybrid'], // "SE/XLE Hybrid": the VIN does not say which trim
    ['JTHBE1BL0D5123456', 2013, 'lexus', 'GS 350', 'GS 350 | 3.5L 6-cyl'],
    ['1GCVKREC0HZ123456', 2017, 'chevrolet', 'Silverado 1500', 'Silverado 1500 LT | 5.3L 8-cyl'], // 4WD is not shown
    ['5YJ3E1EA0LF123456', 2020, 'tesla', 'Model 3', 'Model 3 | Electric'],
  ];
  for (const [vin, year, make, spvModel, want] of cases) {
    const got = await specs(vin, year, make, spvModel);
    assert(got === want, `${year} ${vin}: ${got}`);
  }
  assert(await specs('WBA5R7C00LFH12345', 2009, 'bmw', '') === null, 'no pattern of the year fits: null');
}

// A pattern is the VIN without check digit, plant and serial.
assert(patternOf('4T1BF1FK0GU000000') === '4T1BF1FKG', 'pattern');
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
