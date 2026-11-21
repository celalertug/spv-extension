// Texas SPV lookup and VIN resolution. Runs in the extension service worker and in Node (tests).
//
// SPV (tools.txdmv.gov) only takes a VIN + mileage. It matches on the VIN pattern (WMI, VDS and
// model-year character) and ignores the check digit, plant, serial and mileage. So when a listing
// has no VIN we build one: match.js ranks every vPIC variant of the year/make against the listing
// text, and the best ones are turned into VINs (open positions filled with the characters that
// worked before for that WMI, then the ones vPIC uses most) until SPV recognizes one. Real VIN
// prefixes seen on vehicles in NHTSA complaints go first: they are builds that exist, and their
// counts say which build of a model is most common.

import { rankVariants, realPrefixes, describe, listingText, makeKeys, parseTitle, norm, yearChar, VIN_CHARS } from './match.js';

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

export function parseSpvHtml(html) {
  const err = html.match(/Error:\s*([^<]+)/);
  if (err) return { ok: false, error: cellText(err[1]) };
  const field = (label) => {
    const m = html.match(new RegExp(`${label}:\\s*</td>\\s*<td[^>]*>([\\s\\S]*?)</td>`, 'i'));
    return m ? cellText(m[1]) : null;
  };
  const value = field('Private Value');
  if (!value) return { ok: false, error: 'Unexpected SPV response' };
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

export async function spvLookup(vin, mileage, fetchImpl = fetch) {
  const body = new URLSearchParams({ vin, mileage: String(Math.max(0, Math.round(mileage || 0))).slice(0, 6) });
  const res = await fetchImpl(SPV_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) return { ok: false, error: `SPV HTTP ${res.status}` };
  return parseSpvHtml(await res.text());
}

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

const estKey = (l) => `est2:${l.year}|${norm(l.make)}|${norm(l.model)}|${norm(l.trim)}`;
const seenKey = (l) => `seen:${l.year}|${norm(l.make)}|${norm(l.model)}|${norm(l.trim)}`;
const fillKey = (wmi) => `fill:${wmi}`;

function sameMake(a, b) {
  const x = norm(a);
  const y = norm(b);
  return !!x && !!y && (x.startsWith(y) || y.startsWith(x) || (x.length >= 4 && y.includes(x.slice(0, 4))));
}

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

/**
 * listing: { id, year, make, model, trim, title, mileage, vin, description }
 * deps: { makes, loadIndex(makeKey), seedFills, fetchImpl, cache: {get,set}, onProgress, maxQueries, maxSearch, parallel }
 */
export async function estimate(listing, deps) {
  const { fetchImpl = fetch, cache, onProgress = () => {} } = deps;
  const mileage = listing.mileage || 0;
  const maxQueries = deps.maxQueries ?? 40; // all SPV queries for one listing
  const maxSearch = Math.min(maxQueries, deps.maxSearch ?? 24); // to find the first match
  const parallel = deps.parallel ?? 3;
  let queries = 0;
  const lookup = async (vin) => { queries++; return spvLookup(vin, mileage, fetchImpl).catch((e) => ({ ok: false, error: String(e) })); };

  // 1. A VIN the user entered for this listing, the listing's own, or one in the description.
  const userVin = listing.id && cache ? await cache.get(`vin:${listing.id}`) : null;
  const ownVin = (listing.vin && String(listing.vin).toUpperCase().trim()) || null;
  const descVin = findVinInText(listing.description);
  for (const [source, vin] of [['user', userVin], ['listing', ownVin], ['description', descVin]]) {
    if (!vin) continue;
    onProgress({ step: 'spv', vin });
    const spv = await lookup(vin);
    if (spv.ok) {
      if (source !== 'user' && cache && listing.year && listing.make) await cache.set(seenKey(listing), vin);
      return { ok: true, source, vin, spv, alternatives: [], confidence: 'exact', queries };
    }
  }

  if (!listing.year) return { ok: false, error: 'No model year in the listing' };
  if (listing.year < 1981) return { ok: false, error: 'Vehicles before 1981 have no standard 17-character VIN, which SPV needs' };
  if (!listing.make) return { ok: false, error: 'No make in the listing' };

  // 2. Earlier result for the same text, or a real VIN seen on another listing of it.
  for (const key of [estKey(listing), seenKey(listing)]) {
    const hit = cache && (await cache.get(key));
    const vin = hit && (typeof hit === 'string' ? hit : hit.vin);
    if (!vin) continue;
    onProgress({ step: 'spv', vin });
    const spv = await lookup(vin);
    if (spv.ok) {
      const prev = typeof hit === 'string' ? { source: 'seen' } : hit;
      return { ok: true, ...prev, source: prev.source || 'seen', vin, spv, queries, cached: true };
    }
  }

  // 3. Rank vPIC variants and real VIN prefixes of the make(s) against the text.
  const keys = makeKeys(listing.make, deps.makes);
  if (!keys.length) return { ok: false, error: `Unknown make "${listing.make}"` };
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
  if (!(top >= MIN_SCORE)) {
    return { ok: false, error: `Could not tell which ${listing.make} model this is from the listing text`, queries };
  }

  const learnedByWmi = new Map();
  const learnedFor = async (wmi) => {
    if (!learnedByWmi.has(wmi)) learnedByWmi.set(wmi, await learnedFill(cache, wmi, deps.seedFills));
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

  // SPV ignores the check digit, plant and serial, so one query per VIN pattern. Every answer is
  // kept: a batch queried in parallel often holds the VIN of another likely variant.
  const answers = new Map(); // pattern -> SPV result
  const pattern = (vin) => vin.slice(0, 8) + vin[9];
  const matches = (spv) => spv.ok && spv.year === listing.year && sameMake(spv.make, listing.make);
  const labelOf = (v) => describe(v) || (v.pseudo ? v.model : '');
  let primary = null;
  for (let k = 0; k < queue.length && !primary && queries < maxSearch; ) {
    const batch = [];
    while (batch.length < Math.min(parallel, maxSearch - queries) && k < queue.length) {
      const c = queue[k++];
      if (!answers.has(pattern(c.vin))) { answers.set(pattern(c.vin), null); batch.push(c); }
    }
    if (!batch.length) break;
    onProgress({ step: 'search', vin: batch[0].vin, label: labelOf(batch[0].v), tried: queries + batch.length });
    const results = await Promise.all(batch.map((c) => lookup(c.vin)));
    batch.forEach((c, i) => answers.set(pattern(c.vin), results[i]));
    const hit = results.findIndex(matches);
    if (hit >= 0) primary = { ...batch[hit], spv: results[hit], label: labelOf(batch[hit].v) };
  }
  if (!primary) return { ok: false, error: 'SPV did not recognize any VIN built for this vehicle', queries, candidates: pool.slice(0, 5).map(labelOf) };
  const searchQueries = queries;
  if (primary.open) await learnFill(cache, primary.v.wmi, primary);

  // A few VINs of one variant: its real prefixes, then built ones; answers SPV already gave are reused.
  const tryVariant = async (v, perVariant) => {
    const all = [
      ...(realOf.get(v) || []).slice(0, perVariant).map((r) => ({ vin: realVin(r.prefix, v), real: r })),
      ...(v.pseudo ? [] : vinsFor(v, listing.year, perVariant, await learnedFor(v.wmi))),
    ].slice(0, perVariant);
    const known = all.find((c) => answers.get(pattern(c.vin)) && matches(answers.get(pattern(c.vin))));
    if (known) return { ...known, spv: answers.get(pattern(known.vin)), label: labelOf(v) };
    const cands = all.filter((c) => !answers.has(pattern(c.vin)));
    for (let i = 0; i < cands.length && queries < maxQueries; i += parallel) {
      const batch = cands.slice(i, i + Math.min(parallel, maxQueries - queries));
      batch.forEach((c) => answers.set(pattern(c.vin), null));
      onProgress({ step: 'search', vin: batch[0].vin, label: labelOf(v), tried: queries + batch.length });
      const results = await Promise.all(batch.map((c) => lookup(c.vin)));
      batch.forEach((c, j) => answers.set(pattern(c.vin), results[j]));
      const k = results.findIndex(matches);
      if (k >= 0) return { ...batch[k], spv: results[k], label: labelOf(v) };
    }
    return null;
  };

  // Other likely variants (drive, engine, trim) give the range a buyer might see.
  const alternatives = [];
  const seenLabels = new Set([primary.label]);
  const seenValues = new Set([`${primary.spv.model}|${primary.spv.value}`]);
  const others = pool.filter((v) => v !== primary.v && v.score >= primary.v.score - 3).sort((a, b) => b.score - a.score);
  for (const v of others) {
    if (alternatives.length >= 4 || queries >= maxQueries) break;
    const label = labelOf(v);
    if (seenLabels.has(label)) continue;
    seenLabels.add(label);
    const alt = await tryVariant(v, 3);
    const sig = alt && `${alt.spv.model}|${alt.spv.value}`;
    if (alt && !seenValues.has(sig)) {
      seenValues.add(sig);
      if (alt.open) await learnFill(cache, v.wmi, alt);
      alternatives.push({ vin: alt.vin, label: alt.label, model: alt.spv.model, value: alt.spv.value });
    }
  }

  const conf = confidence(primary, top);
  const result = { ok: true, source: 'estimated', vin: primary.vin, label: primary.label, spv: primary.spv, alternatives, confidence: conf, queries, searchQueries, fromReal: !!primary.real };
  if (cache) await cache.set(estKey(listing), { vin: primary.vin, source: 'estimated', label: primary.label, alternatives, confidence: conf, fromReal: !!primary.real });
  return result;
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
  const clean = String(vin || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean.length !== 17) return { ok: false, error: 'A VIN has 17 characters' };
  const spv = await spvLookup(clean, listing.mileage || 0, deps.fetchImpl || fetch);
  if (!spv.ok) return { ok: false, error: spv.error };
  if (deps.cache && listing.id) await deps.cache.set(`vin:${listing.id}`, clean);
  return { ok: true, source: 'user', vin: clean, spv, alternatives: [], confidence: 'exact', queries: 1 };
}
