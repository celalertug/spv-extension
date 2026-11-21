// Content script: finds the vehicle data of the open Marketplace listing and shows its Texas SPV.
//
// Listing data comes from (1) responses the page hook (hook.js) forwards when a listing is opened
// from the feed, (2) the JSON <script> blocks Facebook embeds on a full page load, and (3) as a last
// resort the page title ("2013 Lexus GS · GS 350 Sedan 4D") and "Driven N miles" text.
(() => {
  const MARK = 'vehicle_make_display_name';
  const ITEM_RE = /\/marketplace\/item\/(\d+)/;
  const listings = new Map();
  const scanned = new WeakSet();
  const dismissed = new Set();
  let current = null; // { id, port }
  let host = null;

  // ------------------------------------------------------------ listing extraction

  function parseChunks(text) {
    const out = [];
    for (const chunk of text.split(/for \(;;\);/)) {
      const t = chunk.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t));
      } catch {
        for (const line of t.split(/\r?\n/)) {
          const s = line.trim();
          if (!s) continue;
          try { out.push(JSON.parse(s)); } catch {}
        }
      }
    }
    return out;
  }

  function slim(o) {
    const title = o.marketplace_listing_title || o.custom_title || '';
    const year = Number((title.match(/\b(19[5-9]\d|20[0-4]\d)\b/) || [])[1]) || null;
    const odo = o.vehicle_odometer_data;
    let mileage = odo && Number(odo.value);
    if (mileage && /KILO/i.test(odo.unit || '')) mileage = Math.round(mileage * 0.621371);
    const price = o.listing_price && Number(o.listing_price.amount);
    return {
      id: String(o.id),
      title,
      year,
      make: o.vehicle_make_display_name || null,
      model: o.vehicle_model_display_name || null,
      trim: o.vehicle_trim_display_name || '',
      mileage: mileage || null,
      vin: o.vehicle_identification_number || null,
      description: (o.redacted_description && o.redacted_description.text) || '',
      price: Number.isFinite(price) ? price : null,
      currency: (o.listing_price && o.listing_price.currency) || null,
      sellerType: o.vehicle_seller_type || null,
    };
  }

  function collect(text) {
    if (!text || !text.includes(MARK)) return;
    for (const root of parseChunks(text)) {
      const stack = [root];
      while (stack.length) {
        const o = stack.pop();
        if (!o || typeof o !== 'object') continue;
        if (Array.isArray(o)) { for (const v of o) if (v && typeof v === 'object') stack.push(v); continue; }
        if (MARK in o && o.id) merge(slim(o));
        for (const k in o) { const v = o[k]; if (v && typeof v === 'object') stack.push(v); }
      }
    }
  }

  function merge(l) {
    const prev = listings.get(l.id) || {};
    const next = { ...prev };
    for (const [k, v] of Object.entries(l)) if (v !== null && v !== '' && v !== undefined) next[k] = v;
    listings.set(l.id, next);
  }

  function scanScripts() {
    for (const s of document.querySelectorAll('script[type="application/json"]')) {
      if (scanned.has(s)) continue;
      scanned.add(s);
      const t = s.textContent;
      if (t && t.includes(MARK)) collect(t);
    }
  }

  function fromPage(id) {
    // "(1) Marketplace – 2013 Lexus GS · GS 350 Sedan 4D | Facebook" (logged in) or
    // "2013 Lexus GS · GS 350 Sedan 4D – Cars & Trucks – Stafford, Texas | Facebook Marketplace | Facebook"
    const parts = document.title.replace(/^\(\d+\)\s*/, '').split(/\s+[–|]\s+/);
    const title = (parts.find((p) => /\b(19[5-9]\d|20[0-4]\d)\b/.test(p)) || '').trim();
    const text = document.body ? document.body.innerText : '';
    const m = text.match(/Driven\s+([\d,]+)\s+(miles|kilometers|km)/i);
    let mileage = m ? Number(m[1].replace(/,/g, '')) : null;
    if (mileage && !/mile/i.test(m[2])) mileage = Math.round(mileage * 0.621371);
    const price = (text.match(/\$\s?([\d,]+)/) || [])[1];
    return { id, pageTitle: title, title, mileage, price: price ? Number(price.replace(/,/g, '')) : null, fromPage: true };
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__spvExt !== 'response') return;
    collect(e.data.text);
  });

  // ------------------------------------------------------------ navigation

  function itemId() {
    const m = location.pathname.match(ITEM_RE);
    return m ? m[1] : null;
  }

  async function waitForListing(id, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (itemId() !== id) return null;
      scanScripts();
      const l = listings.get(id);
      if (l && l.make && l.year) return l;
      await new Promise((r) => setTimeout(r, 250));
    }
    return listings.get(id) || null;
  }

  async function onRoute() {
    const id = itemId();
    if (current && current.id === id) return;
    if (current && current.port) try { current.port.disconnect(); } catch {}
    current = id ? { id } : null;
    if (!id || dismissed.has(id)) { removeCard(); return; }
    render({ state: 'loading', text: 'Reading listing…' });
    let listing = await waitForListing(id, 6000);
    if (!current || current.id !== id) return;
    if (!listing || !listing.make) {
      // Not found in the page data: fall back to the visible title. Not a vehicle -> no card.
      const page = fromPage(id);
      if (!/\b(19[5-9]\d|20[0-4]\d)\b/.test(page.pageTitle)) { removeCard(); return; }
      listing = { ...page, ...(listing || {}) };
    }
    requestEstimate(listing);
  }

  function requestEstimate(listing) {
    const port = chrome.runtime.connect({ name: 'spv' });
    current.port = port;
    current.listing = listing;
    const id = listing.id;
    port.onMessage.addListener((msg) => {
      if (!current || current.id !== id) return;
      if (msg.type === 'progress') {
        const text = msg.step === 'search' ? `Finding a VIN SPV knows… (${msg.tried} tried)` : 'Asking TxDMV…';
        render({ state: 'loading', text, listing: msg.listing || listing });
      } else if (msg.type === 'result') {
        current.listing = msg.listing || listing;
        if (msg.result.ok || !current.result || !current.result.ok) current.result = msg.result;
        render({ state: current.result.ok ? 'done' : 'error', listing: current.listing, result: current.result, notice: msg.result.ok ? null : msg.result.error });
      }
    });
    port.postMessage({ type: 'estimate', listing });
  }

  // Facebook navigates with history.pushState; poll the URL rather than patching history.
  let lastPath = null;
  setInterval(() => {
    if (location.pathname !== lastPath) { lastPath = location.pathname; onRoute(); }
  }, 300);

  // ------------------------------------------------------------ card

  const money = (n) => (Number.isFinite(n) ? `$${Math.round(n).toLocaleString('en-US')}` : '—');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const SOURCE = {
    user: 'VIN you entered',
    chosen: 'Variant you picked',
    listing: 'VIN from the listing',
    description: 'VIN found in the description',
    seen: 'VIN from an earlier listing of this model',
    estimated: 'No VIN in the listing: estimated with a VIN built for this model',
  };

  function removeCard() {
    if (host) { host.remove(); host = null; }
  }

  // Label parts the SPV model name already says ("350" in "GS 350") are dropped.
  function cleanLabel(label, model) {
    const m = String(model || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return String(label || '').split(' · ').filter((p) => p && !m.includes(p.toLowerCase().replace(/[^a-z0-9]/g, ''))).join(' · ');
  }

  const POS_KEY = 'spvExtCardPos';
  const ui = { collapsed: localStorage.getItem('spvExtCollapsed') === '1' };
  function savedPos() {
    try { return JSON.parse(localStorage.getItem(POS_KEY)) || null; } catch { return null; }
  }

  function makeDraggable(card, handle) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const r = card.getBoundingClientRect();
      const dx = e.clientX - r.left;
      const dy = e.clientY - r.top;
      let moved = false;
      const move = (ev) => {
        moved = true;
        const left = Math.max(0, Math.min(window.innerWidth - r.width, ev.clientX - dx));
        const top = Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - dy));
        Object.assign(card.style, { left: `${left}px`, top: `${top}px`, right: 'auto' });
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        if (moved) localStorage.setItem(POS_KEY, JSON.stringify({ left: parseFloat(card.style.left), top: parseFloat(card.style.top) }));
        else { ui.collapsed = !ui.collapsed; localStorage.setItem('spvExtCollapsed', ui.collapsed ? '1' : '0'); card.classList.toggle('collapsed', ui.collapsed); }
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }

  const CONFIDENCE = {
    high: 'Model and trim match the listing text.',
    medium: 'Model matches the listing; trim or engine is a guess.',
    low: 'Model guessed from partial listing text: check the variant.',
  };

  function send(msg) {
    if (current && current.port) try { current.port.postMessage({ ...msg, listing: current.listing }); } catch {}
  }

  // An alternative becomes the main value; the choice is remembered for this listing.
  function choose(i) {
    const r = current && current.result;
    if (!r || !r.alternatives || !r.alternatives[i]) return;
    const alt = r.alternatives[i];
    const prev = { vin: r.vin, label: r.label, model: r.spv.model, value: r.spv.value };
    const alternatives = [prev, ...r.alternatives.filter((_, k) => k !== i)];
    current.result = { ...r, source: 'chosen', vin: alt.vin, label: alt.label, spv: { ...r.spv, model: alt.model, value: alt.value }, alternatives };
    send({ type: 'choose', vin: alt.vin });
    render({ state: 'done', listing: current.listing, result: current.result });
  }

  function vinForm() {
    return `<details class="vin"><summary>Have the VIN?</summary>
      <form><input name="vin" maxlength="17" placeholder="17-character VIN" spellcheck="false" autocomplete="off"><button>Check</button></form></details>`;
  }

  function render({ state, text, listing, result, notice }) {
    if (!host) {
      host = document.createElement('div');
      host.id = 'spv-ext-card';
      host.attachShadow({ mode: 'open' });
      document.documentElement.appendChild(host);
    }
    const dark = document.documentElement.classList.contains('__fb-dark-mode');
    const vehicle = listing ? [listing.year, listing.make, listing.model].filter(Boolean).join(' ') + (listing.trim ? ` · ${listing.trim}` : '') : '';
    let body = '';
    if (state === 'loading') {
      body = `<div class="muted">${esc(vehicle)}</div><div class="loading"><span class="spin"></span>${esc(text)}</div>`;
    } else if (state === 'error') {
      body = `<div class="muted">${esc(vehicle)}</div><div class="err">${esc(result.error)}</div>${vinForm()}`;
    } else {
      const spv = result.spv;
      const price = listing && listing.price;
      let compare = '';
      if (Number.isFinite(price) && price > 0) {
        const diff = price - spv.value;
        const pct = spv.value ? Math.round((Math.abs(diff) / spv.value) * 100) : 0;
        const cls = diff > 0 ? 'up' : 'down';
        compare = `<div class="row"><span>Listing price</span><b>${money(price)}</b></div>
          <div class="row"><span></span><span class="${cls}">${money(Math.abs(diff))} (${pct}%) ${diff >= 0 ? 'above' : 'below'} SPV</span></div>`;
        const basis = Math.max(price, 0.8 * spv.value);
        const bySpv = 0.8 * spv.value > price;
        compare += `<div class="row"><span>Sales tax (6.25%)</span><b>≈ ${money(basis * 0.0625)}</b></div>
          <div class="row note"><span></span><span>on ${money(basis)}${bySpv ? ', 80% of SPV (higher than the price)' : ', the price'}</span></div>`;
      }
      const alts = (result.alternatives || []).map((a, i) => {
        const lbl = cleanLabel(a.label, a.model);
        return `<div class="row alt" data-alt="${i}" title="Use this variant"><span>${esc(a.model)}${lbl ? ` <i>${esc(lbl)}</i>` : ''}</span><b>${money(a.value)}</b></div>`;
      }).join('');
      const srcText = result.source === 'estimated' && result.fromReal
        ? 'No VIN in the listing: estimated with a VIN pattern seen on real vehicles of this model'
        : SOURCE[result.source] || result.source;
      const src = esc(srcText) +
        (result.source === 'estimated' && CONFIDENCE[result.confidence] ? `<br><span class="conf ${result.confidence}">${esc(CONFIDENCE[result.confidence])}</span>` : '');
      const label = cleanLabel(result.label, spv.model);
      body = `
        <div class="value">${money(spv.value)}</div>
        <div class="more">
        <div class="muted">${esc(spv.year)} ${esc(spv.make)} ${esc(spv.model)}${label ? ` <i>${esc(label)}</i>` : ''}</div>
        <div class="sep"></div>
        ${compare}
        <div class="row"><span>VIN</span><code>${esc(result.vin)}</code></div>
        <div class="src ${result.source}">${src}</div>
        ${notice ? `<div class="err">${esc(notice)}</div>` : ''}
        ${alts ? `<div class="sep"></div><div class="label">Other variants · click to use</div>${alts}` : ''}
        ${result.source === 'listing' || result.source === 'description' ? '' : vinForm()}
        </div>`;
    }
    host.shadowRoot.innerHTML = `
      <style>
        :host { all: initial; }
        .card { position: fixed; top: 72px; right: 16px; z-index: 2147483000; width: 300px; box-sizing: border-box;
          font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
          color: ${dark ? '#e4e6eb' : '#1c1e21'}; background: ${dark ? '#242526' : '#fff'};
          border: 1px solid ${dark ? '#3e4042' : '#dddfe2'}; border-radius: 10px; padding: 12px 14px;
          box-shadow: 0 4px 16px rgba(0,0,0,.15); }
        .head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
        .title { font-weight: 600; font-size: 12px; letter-spacing: .02em; color: ${dark ? '#b0b3b8' : '#65676b'}; }
        .x { cursor: pointer; border: 0; background: none; color: inherit; font-size: 16px; line-height: 1; padding: 2px 4px; opacity: .6; }
        .x:hover { opacity: 1; }
        .value { font-size: 26px; font-weight: 700; }
        .muted { color: ${dark ? '#b0b3b8' : '#65676b'}; }
        i { font-style: normal; color: ${dark ? '#b0b3b8' : '#65676b'}; font-size: 12px; }
        .sep { height: 1px; background: ${dark ? '#3e4042' : '#e4e6eb'}; margin: 8px 0; }
        .row { display: flex; justify-content: space-between; gap: 8px; margin: 2px 0; }
        .row.note { font-size: 11px; color: ${dark ? '#b0b3b8' : '#65676b'}; margin-top: -2px; }
        .row.alt span { min-width: 0; }
        .up { color: #d93025; } .down { color: #188038; }
        code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; user-select: all; }
        .src { margin-top: 6px; font-size: 11px; padding: 4px 6px; border-radius: 6px; background: ${dark ? '#3a3b3c' : '#f0f2f5'}; }
        .src.estimated, .src.seen { background: ${dark ? '#4a3f1d' : '#fff4d6'}; }
        .label { font-size: 11px; font-weight: 600; color: ${dark ? '#b0b3b8' : '#65676b'}; margin-bottom: 2px; }
        .loading { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
        .spin { width: 12px; height: 12px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: s .8s linear infinite; opacity: .6; }
        @keyframes s { to { transform: rotate(360deg); } }
        .err { color: #d93025; margin-top: 6px; }
        a { color: ${dark ? '#4599ff' : '#0064d1'}; text-decoration: none; font-size: 12px; }
        .foot { margin-top: 8px; display: flex; justify-content: space-between; }
        .head { cursor: grab; user-select: none; }
        .card.collapsed .more, .card.collapsed .foot { display: none; }
        .card.collapsed .value { font-size: 20px; }
        .row.alt { cursor: pointer; border-radius: 4px; padding: 1px 2px; margin: 1px -2px; }
        .row.alt:hover { background: ${dark ? '#3a3b3c' : '#f0f2f5'}; }
        .conf.low { color: #b3261e; } .conf.medium { color: ${dark ? '#e3b341' : '#8a5a00'}; }
        details.vin { margin-top: 8px; font-size: 12px; }
        details.vin summary { cursor: pointer; color: ${dark ? '#4599ff' : '#0064d1'}; }
        details.vin form { display: flex; gap: 6px; margin-top: 6px; }
        details.vin input { flex: 1; min-width: 0; font: 12px ui-monospace, Menlo, monospace; text-transform: uppercase; padding: 4px 6px;
          border: 1px solid ${dark ? '#3e4042' : '#ccd0d5'}; border-radius: 6px; background: ${dark ? '#3a3b3c' : '#fff'}; color: inherit; }
        details.vin button { font: 600 12px inherit; padding: 4px 10px; border-radius: 6px; border: 0; background: #0866ff; color: #fff; cursor: pointer; }
      </style>
      <div class="card${ui.collapsed ? ' collapsed' : ''}" data-state="${state}">
        <div class="head" title="Drag to move, click to collapse"><span class="title">TEXAS SPV · PRIVATE VALUE</span><button class="x" title="Hide for this listing">×</button></div>
        ${body}
        <div class="foot"><a href="https://www.txdmv.gov/standard-presumptive-calculator" target="_blank" rel="noopener">TxDMV SPV calculator ↗</a></div>
      </div>`;
    const card = host.shadowRoot.querySelector('.card');
    const pos = savedPos();
    if (pos) Object.assign(card.style, { left: `${Math.min(pos.left, window.innerWidth - 300)}px`, top: `${Math.min(pos.top, window.innerHeight - 40)}px`, right: 'auto' });
    makeDraggable(card, host.shadowRoot.querySelector('.head'));
    host.shadowRoot.querySelectorAll('[data-alt]').forEach((el) => el.addEventListener('click', () => choose(Number(el.dataset.alt))));
    const form = host.shadowRoot.querySelector('details.vin form');
    if (form) form.addEventListener('submit', (e) => {
      e.preventDefault();
      const vin = form.vin.value.trim();
      if (!vin) return;
      render({ state: 'loading', text: 'Checking the VIN with TxDMV…', listing: current.listing });
      send({ type: 'lookupVin', vin });
    });
    host.shadowRoot.querySelector('.x').addEventListener('click', () => {
      if (current) dismissed.add(current.id);
      removeCard();
    });
  }
})();
