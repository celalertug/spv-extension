// Matches a listing's free text against the vPIC variants of its year and make.
//
// Sellers type model and trim freely ("2016 mercedes cls 400 twin turbo", "f-150 Lariat 4x4",
// "tsx 4 cylinder"), so instead of picking a model name first, every variant of the make/year
// (model x series x trim x drive x engine x fuel x body ...) is scored against all of the text.
// Series/trim codes such as "CLS400" or "LE/SE/XLE" often identify a car better than the model.

export const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

const MAKE_ALIASES = {
  chevy: 'chevrolet', chev: 'chevrolet', vw: 'volkswagen', volks: 'volkswagen', mercedes: 'mercedesbenz', benz: 'mercedesbenz',
  mb: 'mercedesbenz', mercedesamg: 'mercedesbenz', amg: 'mercedesbenz', rangerover: 'landrover', alfa: 'alfaromeo',
  infinity: 'infiniti', hyndai: 'hyundai', hundai: 'hyundai', mitsu: 'mitsubishi', caddy: 'cadillac', lambo: 'lamborghini',
  rollsroyce: 'rollsroyce', astonmartin: 'astonmartin', harley: 'harleydavidson', harleydavidson: 'harleydavidson', hd: 'harleydavidson',
  toyta: 'toyota', nissian: 'nissan', mazada: 'mazda', subie: 'subaru',
};

// Makes whose models were sold under another make in some years.
const MAKE_FALLBACKS = { ram: ['dodge'], dodge: ['ram'], genesis: ['hyundai'], scion: ['toyota'], mercury: ['ford'] };

const GENERIC = new Set(['class', 'series', 'pickup', 'truck', 'van', 'wagon', 'sedan', 'coupe', 'convertible', 'hatchback', 'cab', 'crew', 'chassis', 'model']);
const FOUR = /\b(awd|4wd|4x4|4matic|4-matic|quattro|xdrive|sh-awd|4motion|all[\s-]?wheel|four[\s-]?wheel|e-four|symmetrical)\b|\b4m\b/i;
const TWO = /\b(fwd|rwd|2wd|4x2|front[\s-]?wheel|rear[\s-]?wheel|sdrive)\b/i;

export function makeKeys(make, makes) {
  const k = norm(make);
  const out = [];
  const add = (x) => { if (x && makes[x] && !out.includes(x)) out.push(x); };
  add(k);
  add(MAKE_ALIASES[k]);
  for (const f of MAKE_FALLBACKS[MAKE_ALIASES[k] || k] || []) add(f);
  return out;
}

// Year/make/model/trim from a Marketplace title ("2013 Lexus GS · GS 350 Sedan 4D") when the
// structured fields are missing.
export function parseTitle(title, makes) {
  const ym = String(title).match(/\b(19[5-9]\d|20[0-4]\d)\b/);
  if (!ym) return {};
  const [main, trim = ''] = title.slice(ym.index + 4).split('·').map((s) => s.trim());
  const words = main.split(/\s+/).filter(Boolean);
  for (let n = Math.min(3, words.length); n >= 1; n--) {
    const k = norm(words.slice(0, n).join(' '));
    if (makes[k] || makes[MAKE_ALIASES[k]] || MAKE_FALLBACKS[k]) return { year: Number(ym[1]), make: words.slice(0, n).join(' '), model: words.slice(n).join(' '), trim };
  }
  return { year: Number(ym[1]), model: main, trim };
}

// ------------------------------------------------------------------ text features

function tokenize(s) {
  return String(s ?? '').toLowerCase().replace(/[·|,;:/()!?+&*"]+/g, ' ').split(/\s+/)
    .flatMap((w) => w.split('-')).map((w) => w.replace(/[^a-z0-9.]/g, '').replace(/^\.+|\.+$/g, '')).filter(Boolean);
}

// Words, their letter/digit runs, and joined neighbours: "f-450sd" -> f, 450, sd, f450, 450sd, f450sd;
// "cls 400" -> cls, 400, cls400.
function tokenSet(words) {
  const toks = new Set();
  const runs = [];
  for (const w of words) {
    toks.add(w.replace(/\./g, ''));
    if (/\d\.\d/.test(w)) toks.add(w);
    const r = w.replace(/\./g, '').match(/[a-z]+|\d+/g) || [];
    runs.push(...r);
  }
  for (let i = 0; i < runs.length; i++) for (let n = 1; n <= 4 && i + n <= runs.length; n++) toks.add(runs.slice(i, i + n).join(''));
  return toks;
}

function editDistanceAtMost(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > max) return false;
    prev = cur;
  }
  return prev[b.length] <= max;
}

export function listingText(listing) {
  const strip = (s) => String(s ?? '').replace(/\b(19[5-9]\d|20[0-4]\d)\b/g, ' ');
  const primaryRaw = `${strip(listing.model)} · ${strip(listing.trim)} · ${strip(listing.title)}`;
  const secondaryRaw = String(listing.description ?? '').slice(0, 1500);
  const primaryWords = tokenize(primaryRaw);
  const secondaryWords = tokenize(secondaryRaw);
  const all = `${primaryRaw} ${secondaryRaw}`;
  const displ = [...primaryRaw.matchAll(/\b([1-8]\.\d)\s*(?:l|t|i|liter|litre)?\b/gi)].map((m) => Number(m[1]));
  // "IS 250", "ES 350", "E 350": the number often is the displacement. A weak hint only.
  const displHint = [...primaryRaw.matchAll(/\b[a-z]{1,3}[\s-]?([1-6][0-9]0)[a-z]?\b/gi)].map((m) => Number(m[1]) / 100);
  const cyl = new Set();
  for (const m of all.matchAll(/\b[vw]-?(6|8|10|12)\b|\b([3-8]|10|12)[\s-]?cyl(?:inder)?s?\b|\bi-?([3-6])\b/gi)) cyl.add(Number(m[1] || m[2] || m[3]));
  for (const [w, n] of [['four', 4], ['six', 6], ['eight', 8]]) if (new RegExp(`\\b${w}[\\s-]cyl`, 'i').test(all)) cyl.add(n);
  const doors = (primaryRaw.match(/\b([2-5])\s*-?\s*(?:d|dr|door|doors)\b/i) || [])[1];
  const body = [];
  const bodyWords = { sedan: /\bsedan\b/i, coupe: /\bcoupe\b/i, convertible: /\b(convertible|cabrio(let)?|roadster|spyder|spider)\b/i,
    hatchback: /\b(hatchback|hatch|liftback)\b/i, wagon: /\bwagon\b/i, suv: /\b(suv|sport utility)\b/i,
    pickup: /\b(pickup|crew ?cab|supercrew|super ?cab|extended cab|ext cab|regular cab|double cab|quad cab|access cab|king cab|short bed|long bed)\b/i,
    van: /\b(van|minivan)\b/i, motorcycle: /\b(motorcycle|bike|cruiser|touring)\b/i };
  for (const [k, re] of Object.entries(bodyWords)) if (re.test(primaryRaw)) body.push(k);
  return {
    raw: primaryRaw,
    words: primaryWords.map((w) => w.replace(/[^a-z0-9]/g, '')).filter((w) => w.length >= 3),
    toks: tokenSet(primaryWords),
    toks2: tokenSet(secondaryWords),
    four: FOUR.test(primaryRaw) || FOUR.test(secondaryRaw),
    two: (TWO.exec(primaryRaw) || [])[1]?.toLowerCase() || null,
    displ,
    displHint,
    cyl,
    doors: doors ? Number(doors) : null,
    body,
    hybrid: /\b(hybrid|hev)\b/i.test(primaryRaw),
    plugin: /\b(plug[\s-]?in|phev|prime|energi|4xe)\b/i.test(primaryRaw),
    electric: /\b(ev|electric|bev)\b/i.test(primaryRaw) && !/\bhybrid\b/i.test(primaryRaw),
    diesel: /\b(diesel|tdi|bluetec|duramax|cummins|power ?stroke|ecodiesel|crd|d4d)\b/i.test(all),
  };
}

// ------------------------------------------------------------------ value matching

// How well a vPIC value ("CLS400-4M", "LE/SE/XLE", "F-150", "GS 350 F Sport") appears in the text: 0..1.
function valueStrength(value, toks) {
  let best = 0;
  const raw = String(value);
  const alts = raw.split('/');
  const noParens = raw.replace(/\([^)]*\)/g, ' ').trim();
  if (noParens && noParens !== raw) alts.push(...noParens.split('/'));
  for (const alt of alts) {
    const v = norm(alt);
    if (!v) continue;
    if (toks.has(v)) return 1;
    const parts = alt.toLowerCase().split(/[\s-]+/).map(norm).filter(Boolean);
    if (parts.length > 1) {
      let got = 0;
      let total = 0;
      for (const p of parts) {
        const w = /\d/.test(p) ? 2 : Math.min(p.length, 3);
        total += w;
        if (toks.has(p)) got += w;
      }
      if (got / total >= 0.5) best = Math.max(best, 0.8 * (got / total));
    }
  }
  return best;
}

function modelStrength(name, toks, words = []) {
  const full = norm(name);
  if (!full) return 0;
  if (toks.has(full)) return 1;
  const nameWords = name.toLowerCase().split(/[\s-]+/).map(norm).filter(Boolean);
  const core = nameWords.filter((w) => !GENERIC.has(w)).join('');
  // A bare character ("3" of "3-Series") only counts next to its generic word ("3 series"),
  // except Tesla's "Model 3".
  if (core && core !== full && toks.has(core) && (core.length > 1 || /^model\b/i.test(name))) return 0.9;
  let best = 0;
  // Most of the model's words ("Sportster 1200 Custom" for "sportster 883").
  if (nameWords.length > 1) {
    let got = 0;
    let total = 0;
    let alpha = false;
    for (const w of nameWords) {
      const wt = /\d/.test(w) ? 2 : Math.min(w.length, 3);
      total += wt;
      if (toks.has(w)) { got += wt; if (/[a-z]{2}/.test(w)) alpha = true; }
    }
    if (alpha && got / total >= 0.4) best = Math.max(best, 0.7 * (got / total));
  }
  // A word of 3+ letters that starts the model code ("vtx" -> "VTX1300C") or vice versa.
  for (const w of words) {
    if (!/[a-z]/.test(w)) continue;
    if ((full.startsWith(w) && w.length >= 3) || (w.startsWith(full) && full.length >= 3)) best = Math.max(best, 0.6);
    // Typos: "pathfander" -> "pathfinder".
    else if (w.length >= 5 && full.length >= 5 && editDistanceAtMost(w, full, w.length >= 8 ? 2 : 1)) best = Math.max(best, 0.75);
  }
  return best;
}

const DRIVE4 = new Set(['AWD', '4WD']);
const BODY_OF = (b) => (/Sedan/.test(b) ? 'sedan' : /Coupe/.test(b) ? 'coupe' : /Convertible|Roadster/.test(b) ? 'convertible'
  : /Hatchback/.test(b) ? 'hatchback' : /Wagon/.test(b) ? 'wagon' : /Sport Utility|Crossover/.test(b) ? 'suv'
  : /Pickup|Sport Utility Truck/.test(b) ? 'pickup' : /Van|Minivan/.test(b) ? 'van' : /Motorcycle/.test(b) ? 'motorcycle' : null);

// Score of one attribute label against the text, with the part of the text that matched.
export function labelScore(code, value, tf) {
  switch (code) {
    case 'S':
    case 'T': {
      const s = valueStrength(value, tf.toks);
      if (s) return 4 * s;
      const s2 = valueStrength(value, tf.toks2);
      return s2 ? 1.5 * s2 : 0;
    }
    case 'D': {
      if (value === '2WD/4WD') return 0;
      // Unstated drive: only a slight lean to 2WD; real-prefix counts decide between them.
      if (DRIVE4.has(value)) return tf.four ? 2 : tf.two ? -2 : -0.2;
      if (tf.four) return -2;
      if (tf.two) return tf.two.startsWith(value.toLowerCase()[0]) || value === '2WD' ? 2 : 0.5;
      return 0.2;
    }
    case 'L':
      // Without an engine in the text, lean slightly to the smaller (base, most common) engine.
      if (!tf.displ.length) return tf.displHint.some((d) => Math.abs(d - Number(value)) < 0.06) ? 0.8 : -0.03 * (Number(value) || 0);
      return tf.displ.some((d) => Math.abs(d - Number(value)) < 0.06) ? 2 : -1.5;
    case 'C':
      if (!tf.cyl.size) return 0;
      return tf.cyl.has(Number(value)) ? 1.5 : -1;
    case 'N':
      if (!tf.doors) return 0;
      return tf.doors === Number(value) ? 0.8 : -0.8;
    case 'B': {
      const b = BODY_OF(value);
      if (!b || !tf.body.length) return 0;
      return tf.body.includes(b) ? 1 : -0.8;
    }
    case 'E':
      if (value === 'Hybrid') return tf.hybrid ? 2.5 : -1.5;
      if (value === 'Plug-in Hybrid') return tf.plugin ? 2.5 : tf.hybrid ? 0.5 : -1.5;
      if (value === 'Electric') return tf.electric ? 2.5 : -0.5;
      return 0;
    case 'F':
      if (value === 'Diesel') return tf.diesel ? 2.5 : -0.5; // unstated: common on heavy-duty trucks
      if (value === 'Electric') return tf.electric ? 2 : -0.5;
      return 0;
    default:
      return 0;
  }
}

// Penalties for what the text says that a variant lacks (it says "hybrid", the variant has no hybrid label).
const PERF = /\b(amg|m[2-8]|rs ?\d|srt|hellcat|raptor|type ?r|nismo|trd pro|shelby|gt500|zl1|z06|trackhawk|svr?|v-?series|cts-?v)\b/i;

function absenceScore(labels, tf, model = '') {
  const has = (code, re) => labels.some(([c, v]) => c === code && re.test(v));
  let s = 0;
  // Performance versions only when the text names them (an "M5" is not a plain "5 Series").
  const perf = [model, ...labels.filter(([c]) => c === 'S' || c === 'T').map(([, v]) => v)].join(' ');
  if (PERF.test(perf) && !PERF.test(tf.raw)) s -= 0.6;
  if (tf.hybrid && !has('E', /Hybrid/) && !labels.some(([c, v]) => (c === 'S' || c === 'T') && /hybrid/i.test(v))) s -= 1.5;
  // Dually and chassis-cab trucks are the minority; prefer the regular pickup unless the text says so.
  const st = labels.filter(([c]) => c === 'S' || c === 'T' || c === 'B').map(([, v]) => v).join(' ');
  if (/dual rear|\bdrw\b/i.test(st) && !/dually|\bdrw\b|dual rear/i.test(tf.raw)) s -= 0.3;
  if (/chassis|\bc\/c\b|incomplete/i.test(st) && !/chassis|\bc\/c\b|cab.?chassis/i.test(tf.raw)) s -= 0.5;
  if (tf.diesel && !has('F', /Diesel/) && !labels.some(([c, v]) => (c === 'S' || c === 'T') && /diesel|tdi|bluetec/i.test(v))) s -= 1;
  return s;
}

// ------------------------------------------------------------------ VIN masks
// 13 sets of allowed characters: VIN positions 4-8 (index 0-4) and 10-17 (index 5-12). null = any.

export const VIN_CHARS = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789';
const YEAR_CODES = 'ABCDEFGHJKLMNPRSTVWXY123456789';
export const yearChar = (year) => YEAR_CODES[(((year - 1980) % 30) + 30) % 30];

function charSet(tok) {
  if (tok === '*') return null;
  if (tok === '#') return new Set('0123456789');
  if (tok.startsWith('[')) {
    let body = tok.slice(1, -1);
    const negate = body.startsWith('^');
    if (negate) body = body.slice(1);
    const s = new Set();
    for (let i = 0; i < body.length; i++) {
      if (body[i + 1] === '-' && i + 2 < body.length) {
        for (let c = body.charCodeAt(i); c <= body.charCodeAt(i + 2); c++) s.add(String.fromCharCode(c));
        i += 2;
      } else s.add(body[i]);
    }
    return negate ? new Set([...VIN_CHARS].filter((c) => !s.has(c))) : s;
  }
  return new Set([tok]);
}

const maskCache = new Map();
export function keyToMask(key) {
  let m = maskCache.get(key);
  if (!m) {
    const [head, tail = ''] = key.split('|');
    const toks = (s) => s.match(/\[[^\]]*\]|./g) || [];
    m = new Array(13).fill(null);
    toks(head).slice(0, 5).forEach((t, i) => { m[i] = charSet(t); });
    toks(tail).slice(0, 8).forEach((t, i) => { m[5 + i] = charSet(t); });
    maskCache.set(key, m);
  }
  return m;
}

export function mergeMasks(a, b) {
  const out = new Array(13);
  for (let i = 0; i < 13; i++) {
    if (!a[i]) out[i] = b[i];
    else if (!b[i]) out[i] = a[i];
    else {
      if (a[i] === b[i]) { out[i] = a[i]; continue; }
      const s = new Set();
      for (const c of a[i]) if (b[i].has(c)) s.add(c);
      if (!s.size) return null;
      out[i] = s;
    }
  }
  return out;
}

const maskSig = (wmi, mask) => wmi + mask.map((s) => (s ? [...s].sort().join('') : '*')).join('|');

// ------------------------------------------------------------------ ranking

// Characters the WMI's schemas of nearby years use at VIN positions 4-8 and 11, most used first.
const yearCharsCache = new Map();
// True when every VIN in region m also lies in region e.
function maskCovers(e, m) {
  return e.every((s, i) => !s || (m[i] && [...m[i]].every((c) => s.has(c))));
}

export function yearChars(index, wmi, year) {
  const key = `${index.make}|${wmi}|${year}`;
  if (yearCharsCache.has(key)) return yearCharsCache.get(key);
  const counts = [{}, {}, {}, {}, {}, {}];
  for (const [sid, y0, y1] of (index.wschemas && index.wschemas[wmi]) || []) {
    if (y0 > year + 2 || y1 < year - 2) continue;
    const pc = index.pchars && index.pchars[String(sid)];
    if (!pc) continue;
    pc.forEach(([chars, ns], pos) => {
      const n = ns ? ns.split(',').map(Number) : [];
      [...chars].forEach((c, i) => { counts[pos][c] = (counts[pos][c] || 0) + (n[i] || 1); });
    });
  }
  const out = counts.map((c) => Object.entries(c).sort((a, b) => b[1] - a[1]).map(([ch]) => ch).join(''));
  yearCharsCache.set(key, out);
  return out;
}

const ORDER = ['S', 'T', 'E', 'F', 'D', 'L', 'C', 'B', 'N'];
const BEAM = 48;

/**
 * Every variant of the make's models for this year, scored against the listing text.
 * Returns [{ wmi, model, mask, labels: [[code, value]], score, modelMatch, detail }] best first.
 */
export function rankVariants(index, listing, tf = listingText(listing)) {
  const year = listing.year;
  const yearMask = new Array(13).fill(null);
  yearMask[5] = new Set([yearChar(year)]);
  const out = [];
  for (const [name, entries] of Object.entries(index.models)) {
    const inYear = entries.filter(([, y0, y1]) => y0 <= year && year <= y1);
    if (!inYear.length) continue;
    const ms = modelStrength(name, tf.toks, tf.words);
    const modelScore = ms ? 6 * ms : modelStrength(name, tf.toks2) ? 1.5 : 0;
    for (const [wmi, , , schema, key] of inYear) {
      const base = mergeMasks(keyToMask(key), yearMask);
      if (!base) continue;
      const attrs = index.schemas[String(schema)] || [];
      let variants = [{ mask: base, labels: [], score: modelScore, excl: [] }];
      for (const code of ORDER) {
        const pats = attrs.filter((a) => a[1] === code);
        if (!pats.length) continue;
        const next = [];
        for (const v of variants) {
          const hit = [];
          let covers = false;
          for (const [k, , value] of pats) {
            const pm = keyToMask(k);
            const m = mergeMasks(v.mask, pm);
            if (!m) continue;
            if (maskSig('', m) === maskSig('', v.mask)) covers = true;
            hit.push(pm);
            // Exclusions that no longer overlap are dropped; one that covers the whole region empties it.
            const excl = v.excl.filter((e) => mergeMasks(m, e));
            if (excl.some((e) => maskCovers(e, m))) continue;
            next.push({ mask: m, labels: [...v.labels, [code, value]], score: v.score + labelScore(code, value, tf), excl });
          }
          // The part of the variant no pattern of this element covers (a gasoline Camry when only
          // the hybrid has an electrification pattern) stays, with those patterns excluded.
          if (!hit.length) next.push(v);
          else if (!covers && hit.length <= 6) next.push({ ...v, excl: [...v.excl, ...hit] });
        }
        // Keep the best few per distinct mask so the beam is not filled with label duplicates.
        const bySig = new Map();
        for (const v of next.sort((a, b) => b.score - a.score)) {
          const sig = `${maskSig('', v.mask)}#${v.excl.length}`;
          if (!bySig.has(sig)) bySig.set(sig, v);
          if (bySig.size >= BEAM) break;
        }
        variants = [...bySig.values()];
      }
      for (const v of variants) {
        // Ties go to the variant whose region vPIC describes (more labels, fewer exclusions).
        // WMIs starting with L are plants in China; few of those cars were sold in the US.
        const score = v.score + absenceScore(v.labels, tf, name) + 0.05 * v.labels.length - 0.1 * v.excl.length - (wmi[0] === 'L' ? 3 : 0);
        out.push({ wmi, model: name, mask: v.mask, excl: v.excl, labels: v.labels, score, modelMatch: ms,
          freq: index.wmis[wmi] || [], yfreq: yearChars(index, wmi, year) });
      }
    }
  }
  const seen = new Map();
  for (const v of out.sort((a, b) => b.score - a.score)) {
    const sig = `${maskSig(v.wmi, v.mask)}#${v.excl.map((m) => maskSig('', m)).sort().join(',')}`;
    if (!seen.has(sig)) seen.set(sig, v);
  }
  return [...seen.values()];
}

// Short human label of a variant: "CLS400 · 3.0L · RWD".
// ------------------------------------------------------------------ real VIN prefixes
// index.real[year] = [[prefix9, count, "MODEL|NAME"]]: VIN positions 1-8 + 10 seen on real vehicles
// (NHTSA complaints). Each one is scored like the best vPIC variant that contains it; one no
// variant contains (vPIC has gaps, mostly before 2000) is scored on its NHTSA model name alone.

const inRegion = (chars, m) => chars.every((c, i) => !m[i] || m[i].has(c));

export function realPrefixes(index, listing, tf, ranked) {
  const rows = index.real && index.real[String(listing.year)];
  if (!rows) return [];
  const byWmi = new Map();
  for (const v of ranked) {
    if (!byWmi.has(v.wmi)) byWmi.set(v.wmi, []);
    byWmi.get(v.wmi).push(v);
  }
  const nameScore = new Map();
  const out = [];
  for (const [prefix, count, names] of rows) {
    const vs = byWmi.get(prefix.slice(0, 3));
    let best = null;
    for (const n of names.split('|')) {
      if (!nameScore.has(n)) nameScore.set(n, modelStrength(n, tf.toks, tf.words));
      if (!best || nameScore.get(n) > best.ms) best = { name: n, ms: nameScore.get(n) };
    }
    const chars = [...prefix.slice(3, 8), prefix[8]];
    // Exclusions only count when they do not depend on the plant/serial positions.
    const v = vs && vs.find((u) => inRegion(chars, u.mask) && !u.excl.some((e) => e.slice(6).every((x) => !x) && inRegion(chars, e)));
    let score;
    if (v) score = v.score + 3 * Math.max(0, best.ms - (v.modelMatch || 0)); // vPIC's model name wins over NHTSA's
    else if (best.ms > 0) score = 6 * best.ms - 0.5;
    else continue;
    out.push({ prefix, count, score, variant: v || null, name: best.name, modelMatch: Math.max(best.ms, (v && v.modelMatch) || 0) });
  }
  return out.sort((a, b) => b.score - a.score || b.count - a.count);
}

// Chassis codes in vPIC's series (GSE20L, UCF30L/...) say nothing to a buyer.
const CHASSIS = /^[A-Z]{2,5}\d{2}[A-Z]?(\/[A-Z0-9]+)*$/;

export function describe(v) {
  const get = (c) => v.labels.filter(([code]) => code === c).map(([, val]) => val);
  const parts = [];
  const series = get('S')[0];
  const trim = get('T')[0];
  if (series && !CHASSIS.test(series)) parts.push(series);
  if (trim && trim !== series) parts.push(trim);
  for (const e of get('E')) parts.push(e);
  for (const f of get('F')) parts.push(f);
  const d = get('D')[0];
  if (d && d !== '2WD/4WD') parts.push(d);
  const l = get('L')[0];
  if (l && Number(l)) parts.push(`${Number(l).toFixed(1)}L`);
  return parts.join(' · ');
}

// ------------------------------------------------------------------ VIN decode for the card

/**
 * What vPIC says about one VIN: its model and, per element (S series, T trim, L displacement,
 * C cylinders, D drive, E electrification, F fuel), the value of the most specific pattern that
 * fits. An element two equally specific patterns disagree on is left out. null when no model
 * pattern of the WMI and year fits.
 */
export function decodeVin(index, vin, year) {
  const c = [...vin.slice(3, 8), ...vin.slice(9, 17)];
  const fits = (key) => keyToMask(key).every((s, i) => !s || s.has(c[i]));
  const specificity = (key) => keyToMask(key).filter(Boolean).length;
  let best = null;
  for (const [model, entries] of Object.entries(index.models)) {
    for (const [wmi, y0, y1, schema, key] of entries) {
      if (wmi !== vin.slice(0, 3) || year < y0 || year > y1 || !fits(key)) continue;
      const n = specificity(key);
      if (!best || n > best.n) best = { model, schema, n };
    }
  }
  if (!best) return null;
  const pick = {};
  for (const [key, code, value] of index.schemas[String(best.schema)] || []) {
    if (!fits(key)) continue;
    const n = specificity(key);
    const p = pick[code];
    if (!p || n > p.n) pick[code] = { n, value, tie: false };
    else if (n === p.n && p.value !== value) p.tie = true;
  }
  const labels = {};
  for (const [code, p] of Object.entries(pick)) if (!p.tie) labels[code] = p.value;
  return { model: best.model, labels };
}

const FAMILY = /(series|class)$/;

/**
 * Name, engine and AWD of a decoded VIN for the card: { name: '330i xDrive Sedan', engine:
 * '2.0L 4-cyl', awd: true }. The name is vPIC's model with its series and trim ("Silverado 1500
 * LT"); SPV's model name instead when it says more ("CT 200h" for vPIC's "CT"); a series that
 * names the car better replaces the model ("C300" for "C-Class"). Family names ("3-Series"),
 * chassis codes and lists of trims are left out.
 */
export function vinSpecs(d, spvModel = '') {
  const { S, T, L, C, D, E, F } = d.labels;
  const parts = [norm(spvModel) !== norm(d.model) && norm(spvModel).includes(norm(d.model)) ? spvModel : d.model];
  for (const raw of [S, T]) {
    const p = String(raw || '').replace(/\s*\([^)]*\)/g, '').trim();
    const k = norm(p);
    // "SE/XLE", "Sport / Limited", "Base, 4": trims sharing one VIN pattern, the VIN does not say which.
    if (!k || CHASSIS.test(p) || FAMILY.test(k) || /[/,]/.test(p)) continue;
    const core = norm(parts[0]).replace(FAMILY, '');
    if (core && k !== core && k.startsWith(core) && (core.length >= 2 || /^\d/.test(k.slice(core.length)))) { parts[0] = p; continue; }
    if (norm(parts.join(' ')).includes(k)) continue;
    parts.push(p);
  }
  const name = parts.join(' ');
  let engine = '';
  if (E === 'Electric' || F === 'Electric') engine = 'Electric';
  else {
    const kind = { Hybrid: 'hybrid', 'Plug-in Hybrid': 'plug-in hybrid', 'Fuel Cell': 'fuel cell' }[E] || { Diesel: 'diesel', CNG: 'CNG', Hydrogen: 'hydrogen' }[F];
    engine = [Number(L) ? `${Number(L).toFixed(1)}L` : '', Number(C) ? `${Number(C)}-cyl` : '', kind && !norm(name).includes(norm(kind)) ? kind : ''].filter(Boolean).join(' ');
    engine = engine.charAt(0).toUpperCase() + engine.slice(1);
  }
  return { name, engine: engine || null, awd: D === 'AWD' };
}
