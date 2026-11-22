// Texas SPV lookup and VIN resolution. Runs in the extension service worker and in Node (tests).
//
// SPV (tools.txdmv.gov) only takes a VIN + mileage. It matches on the VIN pattern (WMI, VDS and
// model-year character) and ignores the check digit, plant and serial; mileage changes the value of
// recent model years only (0 = the value at average mileage). So when a listing
// has no VIN we build one: match.js ranks every vPIC variant of the year/make against the listing
// text, and the best ones are turned into VINs (open positions filled with the characters that
// worked before for that WMI, then the ones vPIC uses most) until SPV recognizes one. Real VIN
// prefixes seen on vehicles in NHTSA complaints go first: they are builds that exist, and their
// counts say which build of a model is most common.
//
// TxDMV is a public service, so queries are kept few: every answer is cached per VIN pattern
// (found and not found), the search stops early when SPV turns down the real builds of the model,
// similar variants are only priced from answers already known unless the user asks for them, and
// a TxDMV error ends the listing's queries.

import { rankVariants, realPrefixes, describe, decodeVin, vinSpecs, listingText, makeKeys, parseTitle, norm, yearChar, VIN_CHARS } from './match.js';
import { sleep } from './polite.js';

export { norm, parseTitle };
export const SPV_URL = 'https://tools.txdmv.gov/tools/SPV/spv_lookup.php';

const DIGITS = '0123456789';
const TRANSLIT = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9 };
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
const MIN_SCORE = 3; // below this the text did not identify any model of the make

export { yearChar };

export function checkDigit(vin) {
  let sum = 0;
  for (let i = 0; i < 17; i++) if (i !== 8) sum += (/\d/.test(vin[i]) ? Number(vin[i]) : TRANSLIT[vin[i]]) * WEIGHTS[i];
  const r = sum % 11;
  return r === 10 ? 'X' : String(r);
}

export function isValidVin(vin) {
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(vin) && checkDigit(vin) === vin[8];
}

// VINs written in a listing description. Only check-digit-valid ones count, so that 17-character
// runs of other text are not mistaken for a VIN.
export function findVinInText(text) {
  const found = String(text ?? '').toUpperCase().match(/\b[A-HJ-NPR-Z0-9]{17}\b/g) || [];
  return found.find(isValidVin) || null;
}

// ---------------------------------------------------------------- SPV

const cellText = (s) => s.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

// { ok: true, ... } | { ok: false, notFound } for SPV's own "not found" | { ok: false, transport }
// when the page is not an SPV answer (changed page, block page).
export function parseSpvHtml(html) {
  const err = html.match(/Error:\s*([^<]+)/);
  if (err) {
    const error = cellText(err[1]);
    return { ok: false, error, notFound: /was not found/i.test(error) };
  }
  const field = (label) => {
    const m = html.match(new RegExp(`${label}:\\s*</td>\\s*<td[^>]*>([\\s\\S]*?)</td>`, 'i'));
    return m ? cellText(m[1]) : null;
  };
  const value = field('Private Value');
  if (!value) return { ok: false, error: 'Unexpected SPV response', transport: true };
  return {
    ok: true,
    year: Number(field('Year')),
    make: field('Make'),
    model: field('Model'),
    vin: field('VIN'),
    mileage: Number((field('Mileage') || '').replace(/[^\d]/g, '')),
    value: Number(value.replace(/[^\d.]/g, '')),
    valueText: value,
  };
}

export async function spvLookup(vin, mileage, fetchImpl = fetch, signal) {
  const body = new URLSearchParams({ vin, mileage: String(Math.min(999999, Math.max(0, Math.round(mileage || 0)))) });
  const res = await fetchImpl(SPV_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal,
  });
  if (!res.ok) return { ok: false, error: `SPV HTTP ${res.status}`, transport: true };
  return parseSpvHtml(await res.text());
}

// ---------------------------------------------------------------- SPV answers, cached per VIN pattern

const DAY = 86400000;
export const SPV_TTL = 7 * DAY; // values: TxDMV revises them over time
export const SPV_MISS_TTL = 30 * DAY; // "VIN not found"
export const patternOf = (vin) => vin.slice(0, 8) + vin[9];

// SPV adjusts recent model years for mileage (2017 and newer as of 2026); one more year is treated
// as mileage-dependent to be safe. Older years have one value at any mileage.
export const mileageMatters = (year, now = Date.now()) => year >= new Date(now).getFullYear() - 10;

const notFoundText = (vin) => `Your VIN "${vin}" was not found. Please check your VIN and try again.`;

// Cache entry `spv:<pattern>`: { t, miss: 1 } or { t, year, make, model, v: { <miles>|any: [value, text] } }.
function readSpv(e, vin, miles, now) {
  if (!e || typeof e.t !== 'number') return null;
  if (e.miss) return now - e.t < SPV_MISS_TTL ? { ok: false, notFound: true, error: notFoundText(vin), cached: true } : null;
  if (now - e.t >= SPV_TTL) return null;
  const v = e.v && e.v[mileageMatters(e.year, now) ? String(miles) : 'any'];
  return v ? { ok: true, year: e.year, make: e.make, model: e.model, vin, mileage: miles, value: v[0], valueText: v[1], cached: true } : null;
}

function writeSpv(e, r, miles, now) {
  if (!r.ok) return { t: now, miss: 1 };
  const keep = e && !e.miss && now - e.t < SPV_TTL && e.year === r.year && e.model === r.model;
  const key = mileageMatters(r.year, now) ? String(miles) : 'any';
  return { t: keep ? e.t : now, year: r.year, make: r.make, model: r.model, v: { ...(keep ? e.v : {}), [key]: [r.value, r.valueText] } };
}

/**
 * SPV queries for one listing. Answers are read from and written to deps.cache per VIN pattern
 * (positions 1-8 and 10, all SPV reads), so a pattern asked once, by any listing, is not asked again
 * until it expires. `st.queries` counts the queries that went to TxDMV. Network queries wait until
 * deps.notBefore (the user stayed on the listing for a moment), and stop for this listing after
 * the first transport failure.
 */
function spvClient(deps, mileage) {
  const { fetchImpl = fetch, cache, signal } = deps;
  const now = deps.now || Date.now;
  const miles = Math.min(999999, Math.max(0, Math.round(mileage || 0)));
  const st = { queries: 0, down: null };
  // network = false: only an answer already cached, or null.
  const lookup = async (vin, network = true) => {
    if (signal) signal.throwIfAborted();
    const key = `spv:${patternOf(vin)}`;
    const entry = cache ? await cache.get(key) : null;
    const known = readSpv(entry, vin, miles, now());
    if (known || !network) return known;
    if (st.down) return st.down;
    if (deps.notBefore) await sleep(deps.notBefore - Date.now(), signal);
    if (st.down) return st.down;
    st.queries++;
    let r;
    try {
      r = await spvLookup(vin, miles, fetchImpl, signal);
    } catch (e) {
      if (signal) signal.throwIfAborted();
      r = { ok: false, transport: true, error: e && e.busy ? e.message : `TxDMV did not answer (${(e && e.message) || e})` };
    }
    if (r.transport) { st.down = r; return r; }
    if (cache && (r.ok || r.notFound)) await cache.set(key, writeSpv(entry, r, miles, now()));
    return r;
  };
  return { lookup, st };
}

const DOWN = 'TxDMV is not answering right now; try again in a few minutes';

// ---------------------------------------------------------------- VIN candidates

const inMask = (chars, mask) => mask.every((s, i) => !s || s.has(chars[i]));

/**
 * Candidate VINs for one variant, most likely first. Positions vPIC leaves open take, in order,
 * the characters that SPV accepted before for this WMI (learned), then those vPIC uses most.
 * Regions excluded by the variant (variant.excl) are skipped.
 */
export function vinsFor(variant, year, max = 12, learned = null) {
  const order = (i, allowed) => {
    const pos = i < 5 ? i : i === 6 ? 5 : -1; // VIN positions 4-8 and 11
    const pool = allowed ? [...allowed] : [...VIN_CHARS];
    const ranked = [];
    const push = (c) => { if (pool.includes(c) && !ranked.includes(c)) ranked.push(c); };
    if (pos >= 0 && learned && learned[pos]) [...learned[pos]].forEach(push);
    if (pos >= 0 && variant.yfreq) [...(variant.yfreq[pos] || '')].forEach(push);
    if (pos >= 0) [...(variant.freq[pos] || '')].forEach(push);
    for (const c of i >= 7 ? DIGITS + VIN_CHARS : VIN_CHARS) push(c);
    return ranked;
  };
  const choices = variant.mask.map((s, i) => order(i, s));
  const open = [0, 1, 2, 3, 4].filter((i) => choices[i].length > 1);
  // Plant (11) and serial (12-17) do not matter to SPV: first allowed character not excluded.
  const maxRank = open.length <= 1 ? 33 : open.length === 2 ? 10 : open.length === 3 ? 5 : 4;
  const combos = [];
  const walk = (k, picked, sum) => {
    if (k === open.length) { combos.push({ picked: [...picked], sum }); return; }
    for (let r = 0; r < Math.min(choices[open[k]].length, maxRank); r++) { picked.push(r); walk(k + 1, picked, sum + r); picked.pop(); }
  };
  walk(0, [], 0);
  combos.sort((a, b) => a.sum - b.sum);
  const out = [];
  for (const { picked, sum } of combos) {
    if (out.length >= max) break;
    const c = choices.map((ch) => ch[0]);
    open.forEach((pos, k) => { c[pos] = choices[pos][picked[k]]; });
    if (variant.excl && variant.excl.some((m) => inMask(c, m))) continue;
    const chars = [...variant.wmi, c[0], c[1], c[2], c[3], c[4], '0', ...c.slice(5)];
    const vin = chars.join('');
    out.push({ vin: vin.slice(0, 8) + checkDigit(vin) + vin.slice(9), chars: c, open, sum });
  }
  return out;
}

// ---------------------------------------------------------------- estimate

const estKey = (l) => `est3:${l.year}|${norm(l.make)}|${norm(l.model)}|${norm(l.trim)}`;
const seenKey = (l) => `seen:${l.year}|${norm(l.make)}|${norm(l.model)}|${norm(l.trim)}`;
const fillKey = (wmi) => `fill:${wmi}`;

function sameMake(a, b) {
  const x = norm(a);
  const y = norm(b);
  return !!x && !!y && (x.startsWith(y) || y.startsWith(x) || (x.length >= 4 && y.includes(x.slice(0, 4))));
}

const matcher = (listing) => (r) => !!r && r.ok && r.year === listing.year && sameMake(r.make, listing.make);
const labelOf = (v) => describe(v) || (v.pseudo ? v.model : '');

async function learnFill(cache, wmi, hit) {
  if (!cache) return;
  const counts = (await cache.get(fillKey(wmi))) || [{}, {}, {}, {}, {}];
  for (const pos of hit.open) counts[pos][hit.chars[pos]] = (counts[pos][hit.chars[pos]] || 0) + 1;
  await cache.set(fillKey(wmi), counts);
}

// Characters SPV accepted before at each open position for this WMI: this browser's own successes
// first, then the shipped calibration (data/fills.json).
async function learnedFill(cache, wmi, seeds) {
  const counts = cache && (await cache.get(fillKey(wmi)));
  const own = counts ? counts.map((c) => Object.entries(c).sort((a, b) => b[1] - a[1]).map(([ch]) => ch).join('')) : null;
  const seed = seeds && seeds[wmi];
  if (!own && !seed) return null;
  return [0, 1, 2, 3, 4].map((i) => [...new Set([...((own && own[i]) || ''), ...((seed && seed[i]) || '')])].join(''));
}

function confidence(primary, top) {
  const v = primary.v;
  const strong = v.labels.some(([c]) => c === 'S' || c === 'T') && v.score >= 9;
  if (v.score < top - 2) return 'low'; // SPV knew none of the builds that fit the text best
  if (v.score >= top - 0.01 && v.modelMatch >= 0.9 && (strong || v.score >= 8)) return 'high';
  if (v.score >= 6 || (primary.real && v.modelMatch >= 0.9)) return 'medium';
  return 'low';
}

// Ranks vPIC variants and real VIN prefixes of the make(s) against the listing text and builds the
// queue of candidate VINs, cheapest first.
async function plan(listing, deps) {
  const keys = makeKeys(listing.make, deps.makes);
  if (!keys.length) return { error: `Unknown make "${listing.make}"` };
  const tf = listingText(listing);
  const indexes = [];
  let ranked = [];
  for (const k of keys) {
    const index = await deps.loadIndex(k);
    if (index) { indexes.push(index); ranked = ranked.concat(rankVariants(index, listing, tf)); }
  }
  ranked.sort((a, b) => b.score - a.score);
  let real = [];
  for (const index of indexes) real = real.concat(realPrefixes(index, listing, tf, ranked));
  const top = Math.max(ranked.length ? ranked[0].score : -Infinity, ...real.map((r) => r.score));
  if (!(top >= MIN_SCORE)) return { error: `Could not tell which ${listing.make} model this is from the listing text` };

  const learnedByWmi = new Map();
  const learnedFor = async (wmi) => {
    if (!learnedByWmi.has(wmi)) learnedByWmi.set(wmi, await learnedFill(deps.cache, wmi, deps.seedFills));
    return learnedByWmi.get(wmi);
  };

  // Only candidates close to the best score are worth SPV queries. Real prefixes go first, the
  // common ones before rare ones; then VINs built from vPIC patterns, ordered by how far the
  // variant is from the best score and how deep the fill characters are, spread over tied variants
  // and WMIs so one wrong WMI cannot use up the budget.
  const floor = Math.max(MIN_SCORE, top - 4);
  const pool = ranked.filter((v) => v.score >= floor).slice(0, 24);
  const realOf = new Map(); // variant -> its real prefixes, most common first
  const maxCount = new Map();
  for (const r of real) maxCount.set(r.name, Math.max(maxCount.get(r.name) || 0, r.count));
  const queue = [];
  for (const r of real) {
    if (r.score < floor) continue;
    let v = r.variant;
    if (!v) { v = pseudoVariant(r); pool.push(v); }
    if (!realOf.has(v)) realOf.set(v, []);
    realOf.get(v).push(r);
    const rare = r.count < 0.02 * maxCount.get(r.name) ? 1 : 0;
    queue.push({ vin: realVin(r.prefix, v), v, real: r, cost: (top - r.score) * 1.5 - 0.4 * Math.log10(1 + r.count) - 0.2 + rare });
  }
  // Real builds seen per vPIC model: a variant of a well-documented model with none of them is
  // probably rare (a chassis cab, a fleet trim), so its built VINs wait.
  const modelReal = new Map();
  for (const r of real) if (r.variant) modelReal.set(r.variant.model, (modelReal.get(r.variant.model) || 0) + r.count);
  const groups = new Map();
  for (let i = 0; i < pool.length; i++) {
    const v = pool[i];
    if (v.pseudo) continue;
    const g = `${v.wmi}|${v.model}`;
    if (!groups.has(g)) groups.set(g, groups.size);
    const tie = pool.slice(0, i).filter((u) => Math.abs(u.score - v.score) < 0.01).length;
    // Real builds of this variant are already queued; without any, how well the model is documented.
    const known = realOf.has(v) ? 1 : Math.min(1.5, 0.5 * Math.log10(1 + (modelReal.get(v.model) || 0)));
    for (const c of vinsFor(v, listing.year, 24, await learnedFor(v.wmi))) {
      queue.push({ ...c, v, cost: (top - v.score) * 1.5 + c.sum + tie * 0.35 + groups.get(g) * 0.5 + known });
    }
  }
  queue.sort((a, b) => a.cost - b.cost);
  return { top, pool, realOf, queue, learnedFor };
}

/**
 * Other likely variants (drive, engine, trim) with a different SPV value: the range a buyer might
 * see. With network = false only answers already known count (this listing's search, the cache);
 * `more` says whether variants were left that a query could still price. With network = true,
 * up to `budget` TxDMV queries in all (spv.st.queries), 3 VINs per variant.
 */
async function similar(listing, p, spv, answers, primary, { network, budget = Infinity, start = [], parallel = 2, onProgress = () => {} }) {
  const matches = matcher(listing);
  const alternatives = [];
  const seenLabels = new Set([primary.label]);
  const seenValues = new Set([`${primary.spv.model}|${primary.spv.value}`]);
  let more = false;
  const add = (vin, label, r) => {
    const sig = `${r.model}|${r.value}`;
    if (seenValues.has(sig)) return;
    seenValues.add(sig);
    alternatives.push({ vin, label, model: r.model, value: r.value });
  };

  // The variants found before (asked again only on request: their value may move with mileage).
  for (const a of start) {
    if (alternatives.length >= 4) break;
    seenLabels.add(a.label);
    if (network && spv.st.queries >= budget) { more = true; continue; }
    const r = await spv.lookup(a.vin, network);
    if (r && r.transport) return { down: r };
    if (matches(r)) add(a.vin, a.label, r);
    else if (!r) more = true;
  }

  // A few VINs of one variant: its real prefixes, then built ones.
  const tryVariant = async (v) => {
    const cands = [
      ...(p.realOf.get(v) || []).slice(0, 3).map((r) => ({ vin: realVin(r.prefix, v), real: r })),
      ...(v.pseudo ? [] : vinsFor(v, listing.year, 3, await p.learnedFor(v.wmi))),
    ].slice(0, 3);
    const pending = [];
    for (const c of cands) {
      const key = patternOf(c.vin);
      let r = answers.get(key);
      if (!r) { r = await spv.lookup(c.vin, false); if (r) answers.set(key, r); }
      if (matches(r)) return { alt: { ...c, spv: r } };
      if (!r) pending.push(c);
    }
    if (!pending.length) return {};
    if (!network) return { unknown: true };
    for (let i = 0; i < pending.length; ) {
      if (spv.st.queries >= budget) return { unknown: true };
      const batch = pending.slice(i, i + Math.min(parallel, budget - spv.st.queries));
      i += batch.length;
      onProgress({ step: 'alternatives', label: labelOf(v), tried: spv.st.queries + batch.length });
      const results = await Promise.all(batch.map((c) => spv.lookup(c.vin)));
      batch.forEach((c, j) => answers.set(patternOf(c.vin), results[j]));
      const down = results.find((r) => r.transport);
      if (down) return { down };
      const k = results.findIndex(matches);
      if (k >= 0) return { alt: { ...batch[k], spv: results[k] } };
    }
    return {};
  };

  const others = p.pool.filter((v) => v.score >= primary.score - 3).sort((a, b) => b.score - a.score);
  for (const v of others) {
    if (alternatives.length >= 4) break;
    const label = labelOf(v);
    if (seenLabels.has(label)) continue;
    seenLabels.add(label);
    const t = await tryVariant(v);
    if (t.down) return { down: t.down };
    if (t.unknown) more = true;
    if (!t.alt) continue;
    if (t.alt.open) await learnFill(spv.cache, v.wmi, t.alt);
    add(t.alt.vin, label, t.alt.spv);
  }
  return { alternatives, more: more && alternatives.length < 4 };
}

/**
 * listing: { id, year, make, model, trim, title, mileage, vin, description }
 * deps: { makes, loadIndex(makeKey), seedFills, fetchImpl, cache: {get,set}, onProgress, signal,
 *         notBefore, maxSearch, parallel, stopAfterMisses, stopWithoutReal, trace }
 * `queries` in the result: queries that went to TxDMV (cached answers are free).
 */
export async function estimate(listing, deps) {
  return withSpecs(await estimateValue(listing, deps), listing, deps);
}

async function estimateValue(listing, deps) {
  const { cache, onProgress = () => {} } = deps;
  const spv = spvClient(deps, listing.mileage || 0);
  spv.cache = cache;
  const out = (r) => ({ ...r, queries: spv.st.queries });
  const down = (r) => out({ ok: false, error: DOWN, detail: r.error, retry: true });

  // 1. A VIN the user entered for this listing, the listing's own, or one in the description.
  const userVin = listing.id && cache ? await cache.get(`vin:${listing.id}`) : null;
  const ownVin = (listing.vin && String(listing.vin).toUpperCase().trim()) || null;
  const descVin = findVinInText(listing.description);
  for (const [source, vin] of [['user', userVin], ['listing', ownVin], ['description', descVin]]) {
    if (!vin) continue;
    onProgress({ step: 'spv', vin });
    const r = await spv.lookup(vin);
    if (r.transport) return down(r);
    if (r.ok) {
      if (source !== 'user' && cache && listing.year && listing.make) await cache.set(seenKey(listing), vin);
      return out({ ok: true, source, vin, spv: r, alternatives: [], confidence: 'exact' });
    }
  }

  if (!listing.year) return out({ ok: false, error: 'No model year in the listing' });
  if (listing.year < 1981) return out({ ok: false, error: 'Vehicles before 1981 have no standard 17-character VIN, which SPV needs' });
  if (!listing.make) return out({ ok: false, error: 'No make in the listing' });

  // 2. Earlier result for the same text, or a real VIN seen on another listing of it. Its variants
  // keep only the values already cached for this mileage; the others are asked again on request.
  for (const key of [estKey(listing), seenKey(listing)]) {
    const hit = cache && (await cache.get(key));
    const vin = hit && (typeof hit === 'string' ? hit : hit.vin);
    if (!vin) continue;
    onProgress({ step: 'spv', vin });
    const r = await spv.lookup(vin);
    if (r.transport) return down(r);
    if (!r.ok) continue;
    if (typeof hit === 'string') return out({ ok: true, source: 'seen', vin, spv: r, alternatives: [], cached: true });
    const alternatives = [];
    for (const a of hit.alternatives || []) {
      const p = await spv.lookup(a.vin, false);
      if (p && p.ok) alternatives.push({ ...a, model: p.model, value: p.value });
    }
    const more = !!hit.more || alternatives.length < (hit.alternatives || []).length;
    return out({ ok: true, source: 'estimated', vin, label: hit.label, spv: r, alternatives, moreAlternatives: more, confidence: hit.confidence, fromReal: hit.fromReal, cached: true });
  }

  // 3. Build candidate VINs from the listing text and ask SPV, cheapest first.
  const p = await plan(listing, deps);
  if (p.error) return out({ ok: false, error: p.error });
  const { top, pool, queue } = p;

  // SPV ignores the check digit, plant and serial, so one query per VIN pattern. The budget counts
  // every candidate looked at, cached or asked, so a listing seen again walks the same candidates
  // (free from the cache) instead of going deeper. The first VIN goes alone: it is usually right.
  // Early stop, when SPV most likely does not have the model (exotics, ATVs): it did not find
  // `stopAfterMisses` real builds of the best-matching models, or no real build is left to try and
  // `stopWithoutReal` candidates were not found. On 100 Marketplace titles every hit came from a
  // real build or within the first 8 candidates, and no hit followed a real build SPV did not find.
  const maxSearch = deps.maxSearch ?? 24;
  const stopAfterMisses = deps.stopAfterMisses ?? 3;
  const stopWithoutReal = deps.stopWithoutReal ?? 10;
  const parallel = deps.parallel ?? 2;
  const answers = new Map(); // pattern -> SPV result
  const matches = matcher(listing);
  let tried = 0;
  let primary = null;
  let stopped = null;
  const realMisses = new Set(); // real prefixes (builds that exist) SPV did not find
  for (let k = 0; k < queue.length && !primary && tried < maxSearch; ) {
    const batch = [];
    const size = Math.min(tried ? parallel : 1, maxSearch - tried, tried < stopWithoutReal ? stopWithoutReal - tried : Infinity);
    while (batch.length < size && k < queue.length) {
      const c = queue[k++];
      if (!answers.has(patternOf(c.vin))) { answers.set(patternOf(c.vin), null); batch.push(c); }
    }
    if (!batch.length) break;
    tried += batch.length;
    onProgress({ step: 'search', vin: batch[0].vin, label: labelOf(batch[0].v), tried });
    const results = await Promise.all(batch.map((c) => spv.lookup(c.vin)));
    batch.forEach((c, i) => answers.set(patternOf(c.vin), results[i]));
    if (deps.trace) batch.forEach((c, i) => deps.trace.push(traceRow(c, results[i], top, matches)));
    const fail = results.find((r) => r.transport);
    if (fail) return down(fail);
    const hit = results.findIndex(matches);
    if (hit >= 0) { primary = { ...batch[hit], spv: results[hit], label: labelOf(batch[hit].v) }; break; }
    batch.forEach((c, i) => { if (c.real && results[i].notFound && c.v.score >= top - 1) realMisses.add(c.real.prefix); });
    if (realMisses.size >= stopAfterMisses) { stopped = 'real'; break; }
    if (tried >= stopWithoutReal && !queue.slice(k).some((c) => c.real && !answers.has(patternOf(c.vin)))) { stopped = 'built'; break; }
  }
  if (!primary) {
    const error = stopped === 'real'
      ? 'SPV does not seem to have this model: it did not recognize VINs of real vehicles of it'
      : 'SPV did not recognize any VIN built for this vehicle';
    return out({ ok: false, error, tried, candidates: pool.slice(0, 5).map(labelOf) });
  }
  const searchQueries = spv.st.queries;
  if (primary.open) await learnFill(cache, primary.v.wmi, primary);

  const s = await similar(listing, p, spv, answers, { label: primary.label, score: primary.v.score, spv: primary.spv }, { network: false });
  const conf = confidence(primary, top);
  const entry = { vin: primary.vin, source: 'estimated', label: primary.label, score: primary.v.score, alternatives: s.alternatives, more: s.more, confidence: conf, fromReal: !!primary.real };
  if (cache) await cache.set(estKey(listing), entry);
  return out({ ok: true, source: 'estimated', vin: primary.vin, label: primary.label, spv: primary.spv, alternatives: s.alternatives, moreAlternatives: s.more, confidence: conf, tried, searchQueries, fromReal: !!primary.real });
}

const traceRow = (c, r, top, matches) => ({
  pattern: patternOf(c.vin),
  real: c.real ? c.real.count : 0,
  gap: Math.round((top - c.v.score) * 100) / 100,
  res: matches(r) ? 'hit' : r.ok ? 'other' : r.notFound ? 'miss' : 'err',
  cached: !!r.cached,
});

/**
 * Similar variants for an estimated listing, asked when the user wants them: the ones found
 * before (re-priced for this mileage), then other likely variants, up to deps.maxAltQueries
 * TxDMV queries (12).
 */
export async function findAlternatives(listing, deps) {
  return withSpecs(await alternativesOf(listing, deps), listing, deps);
}

async function alternativesOf(listing, deps) {
  const { cache, onProgress = () => {} } = deps;
  const spv = spvClient(deps, listing.mileage || 0);
  spv.cache = cache;
  const out = (r) => ({ ...r, queries: spv.st.queries });
  const entry = cache && (await cache.get(estKey(listing)));
  if (!entry || !entry.vin) return out({ ok: false, error: 'No estimate for this listing yet' });
  const p = await plan(listing, deps);
  if (p.error) return out({ ok: false, error: p.error });
  onProgress({ step: 'alternatives', tried: 0 });
  const main = await spv.lookup(entry.vin);
  if (main.transport) return out({ ok: false, error: DOWN, detail: main.error, retry: true });
  if (!main.ok) return out({ ok: false, error: main.error });
  const s = await similar(listing, p, spv, new Map(), { label: entry.label, score: entry.score, spv: main }, {
    network: true, start: entry.alternatives || [], budget: deps.maxAltQueries ?? 12, parallel: deps.parallel ?? 2, onProgress,
  });
  if (s.down) return out({ ok: false, error: DOWN, detail: s.down.error, retry: true });
  await cache.set(estKey(listing), { ...entry, alternatives: s.alternatives, more: s.more });
  return out({ ok: true, primary: { vin: entry.vin, label: entry.label, model: main.model, value: main.value }, alternatives: s.alternatives, moreAlternatives: s.more });
}

// A real prefix no vPIC variant contains, as a variant of its own.
function pseudoVariant(r) {
  const mask = new Array(13).fill(null);
  [...r.prefix.slice(3, 8), r.prefix[8]].forEach((c, i) => { mask[i] = new Set([c]); });
  const model = r.name.toLowerCase().replace(/(^|[\s-])([a-z])/g, (m) => m.toUpperCase());
  return { pseudo: true, wmi: r.prefix.slice(0, 3), model, mask, excl: [], labels: [], score: r.score, modelMatch: r.modelMatch, freq: [], yfreq: [] };
}

// Full VIN for a real prefix: plant and serial from the variant's pattern where it has one.
function realVin(prefix, v) {
  const tail = [6, 7, 8, 9, 10, 11, 12].map((i) => {
    const allowed = v.mask[i] ? [...v.mask[i]] : null;
    if (!allowed) return i === 6 ? 'A' : '0';
    return allowed.find((c) => DIGITS.includes(c)) || allowed[0];
  });
  const vin = prefix.slice(0, 8) + '0' + prefix[8] + tail.join('');
  return vin.slice(0, 8) + checkDigit(vin) + vin.slice(9);
}


// A VIN the user typed on the card: checked with SPV, then remembered for that listing.
export async function lookupUserVin(listing, vin, deps) {
  return withSpecs(await userVinValue(listing, vin, deps), listing, deps);
}

async function userVinValue(listing, vin, deps) {
  const clean = String(vin || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean.length !== 17) return { ok: false, error: 'A VIN has 17 characters' };
  const spv = spvClient(deps, listing.mileage || 0);
  const r = await spv.lookup(clean);
  if (r.transport) return { ok: false, error: DOWN, detail: r.error, retry: true, queries: spv.st.queries };
  if (!r.ok) return { ok: false, error: r.error, queries: spv.st.queries };
  if (deps.cache && listing.id) await deps.cache.set(`vin:${listing.id}`, clean);
  return { ok: true, source: 'user', vin: clean, spv: r, alternatives: [], confidence: 'exact', queries: spv.st.queries };
}

// ---------------------------------------------------------------- model and engine from the VIN

// { name, engine, awd } of a VIN from the vPIC index of its make (vinSpecs), or null.
async function specsOf(vin, year, makeNames, spvModel, deps) {
  if (!vin || vin.length !== 17 || !year) return null;
  const keys = [];
  for (const m of makeNames) for (const k of m ? makeKeys(m, deps.makes) : []) if (!keys.includes(k)) keys.push(k);
  for (const k of keys) {
    const index = await deps.loadIndex(k);
    const d = index && decodeVin(index, vin, year);
    if (d) return vinSpecs(d, spvModel);
  }
  return null;
}

// Adds the card's model and engine (`specs`) to a result's VIN and to each similar variant.
async function withSpecs(r, listing, deps) {
  if (!r || !r.ok || !deps.makes || !deps.loadIndex) return r;
  const year = (r.spv && r.spv.year) || listing.year;
  const makes = [listing.make, r.spv && r.spv.make];
  const one = (vin, model) => specsOf(vin, year, makes, model, deps).catch(() => null);
  const out = { ...r };
  if (r.vin) out.specs = await one(r.vin, r.spv && r.spv.model);
  if (r.primary) out.primary = { ...r.primary, specs: await one(r.primary.vin, r.primary.model) };
  if (r.alternatives) out.alternatives = await Promise.all(r.alternatives.map(async (a) => ({ ...a, specs: await one(a.vin, a.model) })));
  return out;
}
