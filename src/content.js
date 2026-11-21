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
    render({ state: 'loading', text: 'Reading the listing…' });
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
        const hint = msg.step === 'search' ? `${msg.tried} VIN patterns tried` : 'Asking TxDMV';
        render({ state: 'loading', text: 'Looking up the Texas value…', hint, listing: msg.listing || listing });
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

  // StarTag mark (assets/logo-small.svg without the mask wrapper; tools/build_brand.mjs) and brand colors.
  const LOGO = '<svg viewBox="0 0 128 128" aria-hidden="true"><path d="M -50 0 L -24 -30 L 40 -30 L 40 30 L -24 30 Z" transform="translate(64 64) scale(0.94) rotate(45)" fill="none" stroke="#FFF8EC" stroke-width="24" stroke-linejoin="round"/><path d="M -50 0 L -24 -30 L 40 -30 L 40 30 L -24 30 Z" transform="translate(64 64) scale(0.94) rotate(45)" fill="#0B2A4A" stroke="#0B2A4A" stroke-width="14" stroke-linejoin="round"/><polygon points="70.65,44.33 77.14,61.7 95.68,62.51 81.16,74.06 86.12,91.94 70.65,81.7 55.18,91.94 60.13,74.06 45.61,62.51 64.15,61.7" fill="#fff" stroke="#fff" stroke-width="2" stroke-linejoin="round"/><polygon points="70.65,58.9 73.55,66.65 81.82,67.02 75.34,72.17 77.55,80.15 70.65,75.58 63.74,80.15 65.95,72.17 59.47,67.02 67.75,66.65" fill="#C8102E"/></svg>';
  const NAVY = '#0B2A4A';
  const RED = '#C8102E';

  // Source of the value: a short chip on the card, the explanation in its tooltip.
  const SOURCE = {
    user: ['Your VIN', 'VIN you entered'],
    chosen: ['Picked', 'Variant you picked'],
    listing: ['VIN', 'VIN from the listing'],
    description: ['VIN', 'VIN found in the description'],
    seen: ['VIN', 'VIN from an earlier listing of this model'],
    estimated: ['Estimate', 'No VIN in the listing: estimated with a VIN built for this model'],
  };

  function removeCard() {
    if (host) { host.remove(); host = null; }
  }

  // Label parts the SPV model name already says ("350" in "GS 350") and repeats are dropped.
  function cleanLabel(label, model) {
    const key = (p) => p.toLowerCase().replace(/[^a-z0-9]/g, '');
    const m = key(String(model || ''));
    const seen = new Set();
    return String(label || '').split(' · ').filter((p) => {
      const k = key(p);
      if (!k || m.includes(k) || seen.has(k)) return false;
      seen.add(k);
      return true;
    }).join(' · ');
  }
  const shortLabel = (label) => label.split(' · ').slice(0, 2).join(' · ');

  const POS_KEY = 'spvExtCardPos';
  const ui = { collapsed: localStorage.getItem('spvExtCollapsed') === '1' };
  function savedPos() {
    try { return JSON.parse(localStorage.getItem(POS_KEY)) || null; } catch { return null; }
  }

  function makeDraggable(card, handle) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button, a')) return;
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
    high: 'High confidence: model and trim match the listing text.',
    medium: 'Medium confidence: the model matches; trim or engine is a guess.',
    low: 'Low confidence: the model is a guess from partial listing text.',
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

  function render({ state, text, hint, listing, result, notice }) {
    if (!host) {
      host = document.createElement('div');
      host.id = 'spv-ext-card';
      host.attachShadow({ mode: 'open' });
      document.documentElement.appendChild(host);
    }
    const dark = document.documentElement.classList.contains('__fb-dark-mode');
    const muted = dark ? '#b0b3b8' : '#65676b';
    const line = dark ? '#3e4042' : '#e4e6eb';
    const vehicle = listing ? [listing.year, listing.make, listing.model].filter(Boolean).join(' ') : '';
    let body = '';
    let foot = '';
    if (state === 'loading') {
      body = `<div class="sub">${esc(vehicle)}</div><div class="loading" title="${esc(hint || '')}"><span class="spin"></span>${esc(text)}</div>`;
    } else if (state === 'error') {
      body = `<div class="sub">${esc(vehicle)}</div><div class="err" title="${esc(result.error)}">No value for this listing <span class="i">ⓘ</span></div>`;
      foot = vinForm();
    } else {
      const spv = result.spv;
      const [chip, srcText] = SOURCE[result.source] || [result.source, result.source];
      const how = result.source === 'estimated' && result.fromReal
        ? 'No VIN in the listing: estimated from a VIN pattern seen on real vehicles of this model'
        : srcText;
      const conf = result.source === 'estimated' ? CONFIDENCE[result.confidence] : '';
      const srcTip = [how, conf, `VIN: ${result.vin}`].filter(Boolean).join('\n');
      const dot = result.source === 'estimated' ? `<span class="dot ${esc(result.confidence)}"></span>` : '';
      const label = cleanLabel(result.label, spv.model);
      const nameTip = [`${spv.year} ${spv.make} ${spv.model}`, label, 'Texas Standard Presumptive Value (TxDMV)'].filter(Boolean).join('\n');

      let rows = '';
      const price = listing && listing.price;
      if (Number.isFinite(price) && price > 0) {
        const diff = price - spv.value;
        const pct = spv.value ? Math.round((diff / spv.value) * 100) : 0;
        rows = `<div class="row" title="${esc(`${money(Math.abs(diff))} ${diff >= 0 ? 'above' : 'below'} SPV`)}"><span>Price</span><span><b>${money(price)}</b> <span class="${diff > 0 ? 'up' : 'down'}">${pct > 0 ? '+' : pct < 0 ? '−' : '±'}${Math.abs(pct)}%</span></span></div>`;
      }
      const alts = result.alternatives || [];
      // Similar variants with their SPV; clicking one makes it the main value.
      const altBlock = alts.length ? `<div class="alts"><div class="label">Similar variants</div>${alts.map((a, i) => {
        const lbl = cleanLabel(a.label, a.model);
        return `<div class="row alt" data-alt="${i}" title="${esc([a.model, lbl].filter(Boolean).join(' · '))}\nClick to use"><span class="t">${esc(a.model)}${lbl ? ` <i>${esc(shortLabel(lbl))}</i>` : ''}</span><b>${money(a.value)}</b></div>`;
      }).join('')}</div>` : '';
      body = `
        <div class="top"><div class="value">${money(spv.value)}</div><span class="src ${esc(result.source)}" title="${esc(srcTip)}">${dot}${esc(chip)}</span></div>
        <div class="more">
          <div class="sub" title="${esc(nameTip)}">${esc(spv.year)} ${esc(spv.make)} ${esc(spv.model)}${label ? ` <i>${esc(shortLabel(label))}</i>` : ''}</div>
          ${rows ? `<div class="sep"></div>${rows}` : ''}
          ${notice ? `<div class="err">${esc(notice)}</div>` : ''}
          ${altBlock}
        </div>`;
      foot = result.source === 'listing' || result.source === 'description' ? '' : vinForm();
    }
    host.shadowRoot.innerHTML = `
      <style>
        :host { all: initial; }
        .card { position: fixed; top: 72px; right: 16px; z-index: 2147483000; width: 264px; box-sizing: border-box;
          font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
          color: ${dark ? '#e4e6eb' : '#1c1e21'}; background: ${dark ? '#242526' : '#fff'};
          border: 1px solid ${dark ? '#3e4042' : '#dddfe2'}; border-top: 3px solid ${dark ? '#3b5b85' : NAVY}; border-radius: 10px; padding: 8px 14px 12px;
          box-shadow: 0 4px 16px rgba(0,0,0,.15); }
        .head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; cursor: grab; user-select: none; }
        .brand { display: flex; align-items: center; gap: 6px; }
        .brand svg { width: 18px; height: 18px; flex: none; }
        .brand b { font-size: 13px; font-weight: 800; letter-spacing: -.01em; color: ${dark ? '#e4e6eb' : NAVY}; }
        .brand .r { color: ${dark ? '#ff6b7d' : RED}; }
        .tools { display: flex; align-items: center; gap: 2px; }
        .tools a, .x { color: ${muted}; text-decoration: none; border: 0; background: none; cursor: pointer; font-size: 14px; line-height: 1; padding: 2px 4px; border-radius: 4px; }
        .tools a:hover, .x:hover { color: inherit; background: ${dark ? '#3a3b3c' : '#f0f2f5'}; }
        .top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        .value { font-size: 26px; font-weight: 700; letter-spacing: -.01em; }
        .src { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; cursor: help;
          color: ${muted}; background: ${dark ? '#3a3b3c' : '#f0f2f5'}; }
        .dot { width: 7px; height: 7px; border-radius: 50%; background: ${muted}; }
        .dot.high { background: #1e8e3e; } .dot.medium { background: #e0a100; } .dot.low { background: #d93025; }
        .sub { color: ${muted}; margin-top: 1px; }
        .more .sub { cursor: help; }
        i { font-style: normal; color: ${muted}; }
        .sep { height: 1px; background: ${line}; margin: 8px 0 6px; }
        .row { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin: 3px 0; }
        .row > span:first-child { color: ${muted}; }
        .up { color: #d93025; font-size: 12px; font-weight: 600; } .down { color: #1e8e3e; font-size: 12px; font-weight: 600; }
        details { margin-top: 6px; }
        summary { cursor: pointer; list-style: none; font-size: 12px; color: ${muted}; }
        summary::-webkit-details-marker { display: none; }
        summary:hover { color: inherit; }
        .alts { border-top: 1px solid ${line}; padding-top: 6px; margin-top: 8px; }
        .alts .label { font-size: 11px; color: ${muted}; margin-bottom: 2px; }
        .row.alt { cursor: pointer; border-radius: 4px; padding: 2px 4px; margin: 1px -4px; font-size: 12px; }
        .row.alt .t { color: inherit; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .row.alt:hover { background: ${dark ? '#3a3b3c' : '#f0f2f5'}; }
        .loading { display: flex; align-items: center; gap: 8px; margin-top: 6px; color: ${muted}; }
        .spin { width: 12px; height: 12px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: s .8s linear infinite; }
        @keyframes s { to { transform: rotate(360deg); } }
        .err { color: #d93025; margin-top: 6px; font-size: 12px; }
        .err[title] { cursor: help; }
        .err .i { font-size: 11px; opacity: .8; }
        .card.collapsed .more, .card.collapsed .foot { display: none; }
        .card.collapsed .value { font-size: 20px; }
        details.vin summary { color: ${dark ? '#4599ff' : '#0064d1'}; }
        details.vin form { display: flex; gap: 6px; margin-top: 6px; }
        details.vin input { flex: 1; min-width: 0; font: 12px ui-monospace, Menlo, monospace; text-transform: uppercase; padding: 4px 6px;
          border: 1px solid ${dark ? '#3e4042' : '#ccd0d5'}; border-radius: 6px; background: ${dark ? '#3a3b3c' : '#fff'}; color: inherit; }
        details.vin button { font: 600 12px inherit; padding: 4px 10px; border-radius: 6px; border: 0; background: ${dark ? '#3b5b85' : NAVY}; color: #fff; cursor: pointer; }
      </style>
      <div class="card${ui.collapsed ? ' collapsed' : ''}" data-state="${state}">
        <div class="head" title="Drag to move, click to collapse"><span class="brand">${LOGO}<b>Star<span class="r">Tag</span></b></span>
          <span class="tools"><a href="https://www.txdmv.gov/standard-presumptive-calculator" target="_blank" rel="noopener" title="TxDMV SPV calculator">↗</a><button class="x" title="Hide for this listing">×</button></span></div>
        ${body}
        ${foot ? `<div class="foot">${foot}</div>` : ''}
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
