import { estimate, findAlternatives, lookupUserVin, parseTitle, SPV_TTL, SPV_MISS_TTL } from './resolver.js';
import { politeFetch } from './polite.js';

const json = (path) => fetch(chrome.runtime.getURL(path)).then((r) => (r.ok ? r.json() : null)).catch(() => null);
let makesPromise = null;
let fillsPromise = null;
const loadMakes = () => (makesPromise ||= json('data/makes.json'));
const loadFills = () => (fillsPromise ||= json('data/fills.json').then((f) => f || {}));

const indexes = new Map();
function loadIndex(key) {
  if (!indexes.has(key)) indexes.set(key, json(`data/index/${key}.json`));
  return indexes.get(key);
}

const cache = {
  get: async (k) => (await chrome.storage.local.get(k))[k],
  set: (k, v) => chrome.storage.local.set({ [k]: v }),
};

// Every SPV query of this browser goes through one rate limit (15 a minute, bursts of 6) and
// pauses after TxDMV errors. A listing only starts asking TxDMV once it has been open for DWELL ms,
// so paging quickly through listings sends nothing; answers already cached are shown at once.
const spvFetch = politeFetch(fetch, { perMinute: 15, burst: 6 });
const DWELL = 1500;

// Set by the card once the user has read what is sent to TxDMV and clicked OK (content.js).
const CONSENT_KEY = 'consent:txdmv';
const hasConsent = async () => !!(await chrome.storage.local.get(CONSENT_KEY))[CONSENT_KEY];
const ASKS_TXDMV = new Set(['estimate', 'alternatives', 'lookupVin']);

// Expired SPV answers are dropped once a day.
async function prune() {
  const now = Date.now();
  const { 'prune:last': last = 0 } = await chrome.storage.local.get('prune:last');
  if (now - last < 86400000) return;
  const all = await chrome.storage.local.get(null);
  const old = Object.entries(all).filter(([k, e]) => k.startsWith('spv:') && (!e || now - e.t >= (e.miss ? SPV_MISS_TTL : SPV_TTL))).map(([k]) => k);
  if (old.length) await chrome.storage.local.remove(old);
  await chrome.storage.local.set({ 'prune:last': now });
}
prune().catch(() => {});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'spv') return;
  let open = true;
  // The content script disconnects when the user leaves the listing: its queries stop there.
  const ctrl = new AbortController();
  port.onDisconnect.addListener(() => { open = false; ctrl.abort(); });
  const send = (msg) => { if (open) try { port.postMessage(msg); } catch { open = false; } };

  port.onMessage.addListener(async (msg) => {
    const [makes, seedFills] = await Promise.all([loadMakes(), loadFills()]);
    let listing = msg.listing || {};
    if (!listing.make && listing.pageTitle) listing = { ...listing, ...parseTitle(listing.pageTitle, makes) };
    const deps = {
      makes, seedFills, loadIndex, cache, fetchImpl: spvFetch, signal: ctrl.signal,
      onProgress: (p) => send({ type: 'progress', listing, ...p }),
    };
    try {
      if (ASKS_TXDMV.has(msg.type) && !(await hasConsent())) {
        send({ type: msg.type === 'alternatives' ? 'alternatives' : 'result', listing, result: { ok: false, needsConsent: true, error: 'Waiting for OK on the card' } });
        return;
      }
      if (msg.type === 'estimate') {
        if (!listing.make || !listing.year) {
          send({ type: 'result', listing, result: { ok: false, error: 'Could not read year/make from this listing' } });
          return;
        }
        send({ type: 'result', listing, result: await estimate(listing, { ...deps, notBefore: (msg.openedAt || Date.now()) + DWELL }) });
      } else if (msg.type === 'alternatives') {
        send({ type: 'alternatives', listing, result: await findAlternatives(listing, deps) });
      } else if (msg.type === 'lookupVin') {
        send({ type: 'result', listing, result: await lookupUserVin(listing, msg.vin, deps) });
      } else if (msg.type === 'choose' && listing.id && msg.vin) {
        await cache.set(`vin:${listing.id}`, msg.vin);
      }
    } catch (e) {
      if (ctrl.signal.aborted) return;
      send({ type: msg.type === 'alternatives' ? 'alternatives' : 'result', listing, result: { ok: false, error: String(e && e.message ? e.message : e) } });
    }
  });
});
