// A fetch for TxDMV shared by every listing in this browser: at most `perMinute` SPV queries a
// minute (short bursts up to `burst`), a timeout per query, and a pause after TxDMV fails or answers
// 429/5xx (Retry-After when it sends one, else 30 s doubling up to 15 min). While paused, queries
// fail at once with a `busy` error instead of reaching TxDMV.

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) { reject(signal.reason); return; }
    const t = setTimeout(() => { if (signal) signal.removeEventListener('abort', stop); resolve(); }, Math.max(0, ms));
    const stop = () => { clearTimeout(t); reject(signal.reason); };
    if (signal) signal.addEventListener('abort', stop, { once: true });
  });
}

function retryAfter(res) {
  const h = res.headers && res.headers.get && res.headers.get('retry-after');
  if (!h) return null;
  const s = Number(h);
  if (Number.isFinite(s)) return s * 1000;
  const t = Date.parse(h);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : null;
}

export function politeFetch(fetchImpl = fetch, { perMinute = 15, burst = 6, timeoutMs = 15000 } = {}) {
  let tokens = burst;
  let last = Date.now();
  let pausedUntil = 0;
  let failures = 0;
  let queue = Promise.resolve();

  const refill = () => {
    const t = Date.now();
    tokens = Math.min(burst, tokens + ((t - last) * perMinute) / 60000);
    last = t;
  };
  // One waiter at a time, in arrival order.
  const take = (signal) => {
    const turn = queue.then(async () => {
      if (signal) signal.throwIfAborted();
      refill();
      while (tokens < 1) { await sleep(((1 - tokens) * 60000) / perMinute, signal); refill(); }
      tokens -= 1;
    });
    queue = turn.catch(() => {});
    return turn;
  };
  const busy = () => Object.assign(new Error(`TxDMV paused after errors, retrying in ${Math.ceil((pausedUntil - Date.now()) / 1000)} s`), { busy: true });
  const trip = (ms) => {
    failures++;
    pausedUntil = Date.now() + (ms ?? Math.min(15 * 60000, 30000 * 2 ** (failures - 1)));
  };

  const politely = async (url, init = {}) => {
    const { signal } = init;
    if (Date.now() < pausedUntil) throw busy();
    await take(signal);
    if (Date.now() < pausedUntil) throw busy();
    const timeout = AbortSignal.timeout(timeoutMs);
    let res;
    try {
      res = await fetchImpl(url, { ...init, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    } catch (e) {
      if (signal && signal.aborted) throw e;
      trip();
      throw e;
    }
    if (res.status === 429 || res.status >= 500) trip(retryAfter(res));
    else failures = 0;
    return res;
  };
  politely.pausedFor = () => Math.max(0, pausedUntil - Date.now());
  return politely;
}
