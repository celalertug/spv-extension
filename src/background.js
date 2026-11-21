import { estimate, lookupUserVin, parseTitle } from './resolver.js';

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

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'spv') return;
  let open = true;
  port.onDisconnect.addListener(() => { open = false; });
  const send = (msg) => { if (open) try { port.postMessage(msg); } catch { open = false; } };

  port.onMessage.addListener(async (msg) => {
    const [makes, seedFills] = await Promise.all([loadMakes(), loadFills()]);
    let listing = msg.listing || {};
    if (!listing.make && listing.pageTitle) listing = { ...listing, ...parseTitle(listing.pageTitle, makes) };
    const deps = { makes, seedFills, loadIndex, cache, onProgress: (p) => send({ type: 'progress', listing, ...p }) };
    try {
      if (msg.type === 'estimate') {
        if (!listing.make || !listing.year) {
          send({ type: 'result', listing, result: { ok: false, error: 'Could not read year/make from this listing' } });
          return;
        }
        send({ type: 'result', listing, result: await estimate(listing, deps) });
      } else if (msg.type === 'lookupVin') {
        send({ type: 'result', listing, result: await lookupUserVin(listing, msg.vin, deps) });
      } else if (msg.type === 'choose' && listing.id && msg.vin) {
        await cache.set(`vin:${listing.id}`, msg.vin);
      }
    } catch (e) {
      send({ type: 'result', listing, result: { ok: false, error: String(e && e.message ? e.message : e) } });
    }
  });
});
