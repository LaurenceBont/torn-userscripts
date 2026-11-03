// ==UserScript==
// @name         Torn Trade Basket
// @namespace    laurence.torn
// @version      0.4.1
// @description  Pick items on the Items page into a basket, sum market (TornTools) and TornExchange trader buy prices per line and in total, compare with what you receive.
// @match        https://www.torn.com/item.php*
// @match        https://www.torn.com/profiles.php*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      tornexchange.com
// @connect      www.tornexchange.com
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/LaurenceBont/torn-userscripts/main/torn-trade-basket.user.js
// @downloadURL  https://raw.githubusercontent.com/LaurenceBont/torn-userscripts/main/torn-trade-basket.user.js
// ==/UserScript==

(function () {
  'use strict';

  const KEY = 'ttb_basket_v1';
  const KEY_RECV = 'ttb_received_v1';
  const KEY_OPEN = 'ttb_open_v1';
  const KEY_TRADER = 'ttb_te_trader_v1';
  const KEY_TE = 'ttb_te_list_v1';
  const TE_STALE_MS = 30 * 60 * 1000;

  // ---------- hand-over between the normal script and the live loader ----------
  // Each Tampermonkey script has its own storage. The normal script leaves a copy of its data in
  // torn.com localStorage; the loader version imports it once while its own storage is still empty.
  const HANDOVER = 'ttb_handover_v1';
  const ALL_KEYS = [KEY, KEY_RECV, KEY_OPEN, KEY_TRADER, KEY_TE, 'ttb_te_on_v1'];
  const viaLoader = typeof TTB_LOADER !== 'undefined';
  try {
    if (viaLoader) {
      const raw = localStorage.getItem(HANDOVER);
      if (raw && GM_getValue(KEY, null) === null) {
        const data = JSON.parse(raw);
        ALL_KEYS.forEach((k) => { if (k in data && data[k] !== null) GM_setValue(k, data[k]); });
        localStorage.removeItem(HANDOVER);
      }
    } else if (GM_getValue(KEY, null) !== null) {
      const data = {};
      ALL_KEYS.forEach((k) => { data[k] = GM_getValue(k, null); });
      localStorage.setItem(HANDOVER, JSON.stringify(data));
    }
  } catch (e) { /* storage blocked, start fresh */ }

  let basket = GM_getValue(KEY, {});        // id -> { id, itemId, name, price, maxQty, qty }
  let received = GM_getValue(KEY_RECV, 0);
  let open = GM_getValue(KEY_OPEN, true);
  let trader = GM_getValue(KEY_TRADER, '04doolant');
  let te = GM_getValue(KEY_TE, null);       // { trader, ts, byId: {id: price}, byName: {name: price} }
  let teOn = GM_getValue('ttb_te_on_v1', false); // master switch: no TornExchange requests at all while off
  let teStatus = '';
  let bestResult = null; // last "Find best traders" run (session only)

  const fmt = (n) => '$' + Math.round(n || 0).toLocaleString('en-US');
  const toInt = (s) => parseInt(String(s || '').replace(/[^\d]/g, ''), 10) || 0;
  const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const save = () => {
    GM_setValue(KEY, basket);
    GM_setValue(KEY_RECV, received);
    GM_setValue(KEY_OPEN, open);
    GM_setValue(KEY_TRADER, trader);
    GM_setValue(KEY_TE, te);
    GM_setValue('ttb_te_on_v1', teOn);
  };

  // ---------- profile page: read username, load their TE list ----------
  if (location.pathname.startsWith('/profiles.php')) {
    if (teOn) profileMode(); // only look up the profile owner when the TE switch in the basket is on
    return;
  }

  function profileName() {
    const t = document.title.match(/^\s*(.+?)\s*\[\d+\]/);
    if (t) return t[1];
    const h = document.querySelector('#skip-to-content, .content-title h4');
    const m = h && h.textContent.trim().match(/^(.+?)'s\s+Profile/i);
    return m ? m[1] : null;
  }

  function profileMode() {
    const toast = document.createElement('div');
    toast.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:99999;background:#222;color:#ddd;'
      + 'border:1px solid #444;border-radius:6px;padding:8px 10px;font:12px Arial,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.5)';
    const show = (html) => { toast.innerHTML = html; if (!toast.isConnected) document.body.appendChild(toast); };

    let tries = 0;
    const timer = setInterval(() => {
      const name = profileName();
      if (!name && ++tries < 20) return;
      clearInterval(timer);
      if (!name) return;
      show(`TE: checking <b>${esc(name)}</b>…`);
      loadTE(name,
        (list) => {
          trader = name; te = list; save();
          show(`TE: <b>${esc(name)}</b> loaded (${Object.keys(list.byName).length} items), now used in your basket`);
          setTimeout(() => toast.remove(), 6000);
        },
        (msg) => {
          show(`${esc(msg)}<br><span style="color:#888">Basket keeps using <b>${esc(trader)}</b></span>`);
          setTimeout(() => toast.remove(), 4000);
        });
    }, 500);
  }

  // ---------- reading a Torn item row ----------
  function rowId(li) {
    return li.dataset.armoryid || li.dataset.item || rowName(li);
  }

  function rowName(li) {
    const el = li.querySelector('.name-wrap .name, .name');
    return (el ? el.textContent : li.dataset.sort || 'Unknown').trim();
  }

  function rowQty(li) {
    if (li.dataset.qty) return toInt(li.dataset.qty) || 1;
    const wrap = li.querySelector('.name-wrap');
    const m = (wrap ? wrap.textContent : '').match(/x\s*([\d,]+)/i);
    return m ? toInt(m[1]) : 1;
  }

  function rowPrice(li) {
    // TornTools injects ".tt-item-price" like "$480 | 400x = $192,000"; first $ value is the unit price
    const tt = li.querySelector('.tt-item-price');
    const src = tt ? tt.textContent : textWithoutOurUi(li);
    const m = src.match(/\$\s*([\d,]+)/);
    return m ? toInt(m[1]) : 0;
  }

  function textWithoutOurUi(li) {
    const clone = li.cloneNode(true);
    clone.querySelectorAll('.ttb-add').forEach((b) => b.remove());
    return clone.textContent || '';
  }

  // ---------- TornExchange price list ----------
  function fetchTE() {
    teStatus = 'Loading ' + trader + '…';
    render();
    loadTE(trader,
      (list) => { te = list; teStatus = ''; save(); render(); },
      (msg) => { teStatus = msg; render(); });
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const itemIdFromImg = (img) => ((img && img.getAttribute('src')) || '').match(/\/items\/(\d+)\//)?.[1] || null;

  function gmGet(url) {
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      method: 'GET', url,
      onload: (res) => resolve(res),
      onerror: () => reject(new Error('TE request failed')),
    }));
  }

  // Fetch and parse one trader's list; cached in memory for TE_STALE_MS
  const listCache = {};
  async function loadTEp(name) {
    const hit = listCache[norm(name)];
    if (hit && Date.now() - hit.ts < TE_STALE_MS) return hit;
    const res = await gmGet(`https://www.tornexchange.com/prices/${encodeURIComponent(name)}/`);
    if (res.status === 404) throw new Error(`No TE list for ${name}`);
    if (res.status !== 200) throw new Error(`TE error ${res.status}`);
    const doc = new DOMParser().parseFromString(res.responseText, 'text/html');
    const byId = {};
    const byName = {};
    doc.querySelectorAll('tr.item').forEach((tr) => {
      const itemName = tr.querySelector('.item-name')?.textContent.trim();
      const cells = tr.querySelectorAll('td');
      const price = toInt(cells[cells.length - 1]?.textContent);
      if (!itemName || !price) return;
      byName[norm(itemName)] = price;
      const id = itemIdFromImg(tr.querySelector('img'));
      if (id) byId[id] = price;
    });
    if (!Object.keys(byName).length) throw new Error(`No TE list for ${name}`);
    const list = { trader: name, ts: Date.now(), byId, byName };
    listCache[norm(name)] = list;
    return list;
  }

  function loadTE(name, ok, fail) {
    loadTEp(name).then(ok, (e) => fail(e.message));
  }

  function priceIn(list, b) {
    if (!list) return null;
    if (b.itemId && list.byId[b.itemId] != null) return list.byId[b.itemId];
    const p = list.byName[norm(b.name)];
    return p != null ? p : null;
  }

  function tePrice(b) {
    return teOn ? priceIn(te, b) : null;
  }

  // ---------- best trader search ----------
  // Top-paying traders for one item from /listings, sorted by price high to low
  async function topTradersFor(b, want) {
    const found = [];
    for (let page = 1; page <= 2 && found.length < want; page++) {
      const url = 'https://www.tornexchange.com/listings?model_name_contains='
        + encodeURIComponent(b.name).replace(/%20/g, '+') + '&order_by=-effective_price&status=&page=' + page;
      const res = await gmGet(url);
      if (res.status !== 200) break;
      const doc = new DOMParser().parseFromString(res.responseText, 'text/html');
      const cards = doc.querySelectorAll('.listing-card');
      if (!cards.length) break;
      cards.forEach((card) => {
        if (found.length >= want) return;
        const img = card.querySelector('.card-text img');
        const sameItem = b.itemId ? itemIdFromImg(img) === String(b.itemId) : norm(img?.getAttribute('alt')) === norm(b.name);
        if (!sameItem) return;
        const m = (card.querySelector('a[href*="/prices/"]')?.getAttribute('href') || '').match(/\/prices\/([^/]+)\//);
        if (!m) return;
        const name = decodeURIComponent(m[1]);
        if (found.some((f) => f.name === name)) return;
        const dot = card.querySelector('.listing-player i.fa-circle')?.className || '';
        found.push({
          name,
          rating: parseInt(card.querySelector('.listing-player .text-end')?.textContent.trim(), 10) || 0,
          status: /text-success/.test(dot) ? 'on' : /text-warning/.test(dot) ? 'idle' : 'off',
        });
      });
      await sleep(400);
    }
    return found;
  }

  async function findBest() {
    const items = Object.values(basket).filter((b) => b.qty > 0);
    if (!items.length) return;
    const market = items.reduce((s, b) => s + b.price * b.qty, 0);

    // anchors: biggest lines until ~80% of market value, max 5
    const sorted = [...items].sort((a, b) => b.price * b.qty - a.price * a.qty);
    const anchors = [];
    let cum = 0;
    for (const b of sorted) {
      if (anchors.length >= 5 || (market && cum >= 0.8 * market)) break;
      anchors.push(b);
      cum += b.price * b.qty;
    }

    try {
      const traders = new Map(); // name -> meta
      for (let i = 0; i < anchors.length; i++) {
        teStatus = `Searching top traders ${i + 1}/${anchors.length}: ${anchors[i].name}…`;
        render();
        (await topTradersFor(anchors[i], 5)).forEach((t) => { if (!traders.has(t.name)) traders.set(t.name, t); });
      }

      const rows = [];
      const lists = [];
      let n = 0;
      for (const [name, meta] of traders) {
        teStatus = `Loading price lists ${++n}/${traders.size}…`;
        render();
        try {
          const list = await loadTEp(name);
          lists.push(list);
          let total = 0, lines = 0, covValue = 0;
          items.forEach((b) => {
            const p = priceIn(list, b);
            if (p == null) return;
            total += p * b.qty; lines++; covValue += b.price * b.qty;
          });
          rows.push({ ...meta, total, lines, covPct: market ? (covValue / market) * 100 : 0 });
        } catch (e) { /* trader without readable list, skip */ }
        await sleep(400);
      }

      // best split: each line to whichever found trader pays most for it
      let split = 0, splitLines = 0;
      items.forEach((b) => {
        let best = null;
        lists.forEach((l) => { const p = priceIn(l, b); if (p != null && (best == null || p > best)) best = p; });
        if (best != null) { split += best * b.qty; splitLines++; }
      });

      rows.sort((a, b) => b.total - a.total);
      bestResult = { ts: Date.now(), rows, split, splitLines, lineCount: items.length, anchors: anchors.map((a) => a.name) };
      teStatus = rows.length ? '' : 'No traders found for the top items';
    } catch (e) {
      teStatus = e.message;
    }
    render();
  }

  function useTrader(name) {
    const list = listCache[norm(name)];
    if (!list) return;
    trader = name; te = list; save(); render();
  }

  function teAge() {
    if (!te) return 'not loaded';
    const min = Math.round((Date.now() - te.ts) / 60000);
    return min < 60 ? `${min}m ago` : `${Math.round(min / 60)}h ago`;
  }

  // ---------- basket ops ----------
  function toggle(li) {
    const id = rowId(li);
    if (basket[id]) {
      delete basket[id];
    } else {
      const maxQty = rowQty(li);
      basket[id] = { id, itemId: li.dataset.item || null, name: rowName(li), price: rowPrice(li), maxQty, qty: maxQty };
    }
    save();
    syncButtons();
    render();
  }

  function refreshPrices() {
    document.querySelectorAll('ul.itemsList > li').forEach((li) => {
      const b = basket[rowId(li)];
      if (!b) return;
      const p = rowPrice(li);
      if (p) b.price = p;
      b.itemId = b.itemId || li.dataset.item || null;
      b.maxQty = rowQty(li);
      b.qty = Math.min(b.qty, b.maxQty);
    });
    save();
    if (teOn) fetchTE(); else render();
  }

  // ---------- row buttons ----------
  function decorate(li) {
    if (!li.querySelector('.name-wrap, .name')) return;
    let btn = li.querySelector('.ttb-add');
    if (!btn) {
      li.dataset.ttb = '1';
      btn = document.createElement('button');
      btn.className = 'ttb-add';
      btn.type = 'button';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggle(li);
      });
      setBtn(btn, !!basket[rowId(li)]);
    }
    place(li, btn);
  }

  // Put the button right after the TornTools price; TornTools injects it later, so re-check on every scan
  function place(li, btn) {
    const price = li.querySelector('.tt-item-price');
    if (price) {
      if (price.nextSibling !== btn) price.after(btn);
      btn.classList.add('ttb-by-price');
    } else if (!btn.isConnected) {
      (li.querySelector('.name-wrap') || li.querySelector('.name').parentElement).prepend(btn);
    }
  }

  function setBtn(btn, inBasket) {
    btn.textContent = inBasket ? '✓' : '+';
    btn.classList.toggle('ttb-in', inBasket);
    btn.title = inBasket ? 'Remove from basket' : 'Add to basket';
  }

  function syncButtons() {
    document.querySelectorAll('ul.itemsList > li[data-ttb]').forEach((li) => {
      const btn = li.querySelector('.ttb-add');
      if (btn) setBtn(btn, !!basket[rowId(li)]);
    });
  }

  function scan() {
    document.querySelectorAll('ul.itemsList > li').forEach(decorate);
  }

  // ---------- panel ----------
  const panel = document.createElement('div');
  panel.id = 'ttb-panel';
  document.body.appendChild(panel);

  function totals() {
    let market = 0, teSum = 0, missing = 0;
    Object.values(basket).forEach((b) => {
      market += b.price * b.qty;
      const p = tePrice(b);
      if (p == null) missing++; else teSum += p * b.qty;
    });
    return { market, teSum, missing };
  }

  function diffHtml(a, base) {
    if (!base) return '-';
    const d = a - base;
    return `<b class="${d >= 0 ? 'ttb-pos' : 'ttb-neg'}">${d >= 0 ? '+' : '-'}${fmt(Math.abs(d))} (${((a / base) * 100).toFixed(1)}%)</b>`;
  }

  function bestHtml(market) {
    const r = bestResult;
    const pct = (v) => (market ? ((v / market) * 100).toFixed(1) + '%' : '-');
    const stale = r.lineCount !== Object.keys(basket).length ? ' <span class="ttb-warn">(basket changed, run again)</span>' : '';
    return `
      <div class="ttb-best">
        <div class="ttb-best-head">Best traders for: ${r.anchors.map(esc).join(', ')}${stale}</div>
        ${r.rows.slice(0, 8).map((t) => `
          <div class="ttb-best-row ${te && te.trader === t.name ? 'ttb-active' : ''}">
            <span><i class="ttb-dot ttb-${t.status}"></i>${esc(t.name)} <small>★${t.rating}</small></span>
            <span>${fmt(t.total)} <small>${pct(t.total)}</small></span>
            <span title="Lines this trader buys / share of market value they cover">${t.lines}/${r.lineCount} · ${t.covPct.toFixed(0)}%</span>
            <button data-act="use" data-name="${esc(t.name)}">Use</button>
          </div>`).join('')}
        <div class="ttb-best-row ttb-split">
          <span>Best split (each line to top payer)</span>
          <span>${fmt(r.split)} <small>${pct(r.split)}</small></span>
          <span>${r.splitLines}/${r.lineCount}</span><span></span>
        </div>
      </div>`;
  }

  function render() {
    const items = Object.values(basket);
    const { market, teSum, missing } = totals();
    const tePct = market ? ((teSum / market) * 100).toFixed(1) : '0.0';

    const showTE = teOn && te;
    panel.classList.toggle('ttb-no-te', !teOn);

    panel.innerHTML = `
      <div class="ttb-head">
        <b>Trade basket</b>
        <span>${items.length} lines · ${fmt(market)}${showTE ? ` · TE ${fmt(teSum)}` : ''}</span>
        <button data-act="te" class="ttb-switch ${teOn ? 'ttb-switch-on' : ''}"
          title="When on: loads TornExchange prices and, on a trader's profile, switches to their list">TE ${teOn ? 'ON' : 'OFF'}</button>
        <button data-act="toggle">${open ? '–' : '+'}</button>
      </div>
      ${open ? `
      <div class="ttb-row ttb-hdr">
        <span>Item</span><span>Market</span><span>Qty</span><span>Market tot.</span><span class="ttb-te">TE tot.</span><span></span>
      </div>
      <div class="ttb-body">
        ${items.length ? '' : '<div class="ttb-empty">Click + next to an item to add it.</div>'}
        ${items.map((b) => {
          const p = tePrice(b);
          const teCell = p == null
            ? '<span class="ttb-te ttb-miss" title="Not on this trader\'s list">n/a</span>'
            : `<span class="ttb-te" title="TE unit ${fmt(p)}${b.price ? ` (${((p / b.price) * 100).toFixed(0)}% of market)` : ''}">${fmt(p * b.qty)}</span>`;
          return `
          <div class="ttb-row" data-id="${encodeURIComponent(b.id)}">
            <span class="ttb-name" title="${esc(b.name)}">${esc(b.name)}</span>
            <span class="ttb-unit">${b.price ? fmt(b.price) : 'N/A'}</span>
            <input class="ttb-qty" type="number" min="1" max="${b.maxQty}" value="${b.qty}">
            <span class="ttb-line">${fmt(b.price * b.qty)}</span>
            ${teCell}
            <button data-act="remove">✕</button>
          </div>`;
        }).join('')}
      </div>
      <div class="ttb-foot">
        <div><span>Market value</span><b>${fmt(market)}</b></div>
        ${teOn ? `
        <div><span>TE buy (${esc(te ? te.trader : trader)}, ${teAge()})</span>
          <b>${showTE ? `${fmt(teSum)} <small>(${tePct}%)</small>` : '-'}</b></div>
        ${showTE && missing ? `<div class="ttb-warn"><span>${missing} line(s) not on TE list, excluded from TE total</span></div>` : ''}` : ''}
        <div><span>Receiving</span><input class="ttb-recv" type="text" value="${received ? received.toLocaleString('en-US') : ''}" placeholder="$ offered"></div>
        ${received ? `
        <div><span>vs market</span>${diffHtml(received, market)}</div>
        ${showTE ? `<div><span>vs TE</span>${diffHtml(received, teSum)}</div>` : ''}` : ''}
        ${teOn && teStatus ? `<div class="ttb-warn"><span>${esc(teStatus)}</span></div>` : ''}
        ${teOn && bestResult ? bestHtml(market) : ''}
        <div class="ttb-actions">
          ${teOn ? '<button data-act="best">Find best traders</button><button data-act="trader">Trader</button>' : ''}
          <button data-act="refresh">Refresh prices</button>
          <button data-act="copy">Copy list</button>
          <button data-act="clear">Clear</button>
        </div>
      </div>` : ''}
    `;
  }

  let busy = false;
  panel.addEventListener('click', (e) => {
    const act = e.target.dataset.act;
    if (!act) return;
    if (act === 'toggle') { open = !open; save(); render(); }
    if (act === 'te') {
      teOn = !teOn;
      teStatus = '';
      save();
      if (teOn && (!te || te.trader !== trader || Date.now() - te.ts > TE_STALE_MS)) fetchTE(); else render();
    }
    if (act === 'remove') {
      const id = decodeURIComponent(e.target.closest('.ttb-row').dataset.id);
      delete basket[id]; save(); syncButtons(); render();
    }
    if (act === 'clear') { basket = {}; received = 0; bestResult = null; save(); syncButtons(); render(); }
    if (act === 'best' && !busy) { busy = true; findBest().finally(() => { busy = false; }); }
    if (act === 'use') useTrader(e.target.dataset.name);
    if (act === 'refresh') refreshPrices();
    if (act === 'trader') {
      const name = prompt('TornExchange trader name (from tornexchange.com/prices/<name>/):', trader);
      if (name && name.trim()) { trader = name.trim(); te = null; save(); fetchTE(); }
    }
    if (act === 'copy') {
      const lines = Object.values(basket).map((b) => {
        const p = tePrice(b);
        return `${b.name} x${b.qty} | market ${fmt(b.price * b.qty)} | TE ${p == null ? 'n/a' : fmt(p * b.qty)}`;
      });
      const { market, teSum } = totals();
      lines.push(`Total market: ${fmt(market)}`);
      if (teOn && te) lines.push(`Total TE (${te.trader}): ${fmt(teSum)}`);
      GM_setClipboard(lines.join('\n'));
    }
  });

  panel.addEventListener('change', (e) => {
    if (e.target.classList.contains('ttb-qty')) {
      const id = decodeURIComponent(e.target.closest('.ttb-row').dataset.id);
      const b = basket[id];
      b.qty = Math.max(1, Math.min(b.maxQty, toInt(e.target.value) || 1));
      save(); render();
    }
    if (e.target.classList.contains('ttb-recv')) {
      // accepts 12m / 1.5b / 250k shorthand
      const raw = e.target.value.trim().toLowerCase().replace(/[$,\s]/g, '');
      const m = raw.match(/^([\d.]+)([kmb]?)$/);
      const mult = { '': 1, k: 1e3, m: 1e6, b: 1e9 };
      received = m ? Math.round(parseFloat(m[1]) * mult[m[2]]) : 0;
      save(); render();
    }
  });

  // ---------- styles ----------
  const css = document.createElement('style');
  css.textContent = `
    .ttb-add { width:20px; height:20px; margin-right:6px; border:1px solid #666; border-radius:3px;
      background:#333; color:#ccc; font-weight:bold; cursor:pointer; line-height:16px; padding:0; vertical-align:middle; }
    .ttb-add.ttb-by-price { margin:0 0 0 8px; }
    .ttb-add.ttb-in { background:#4b6b1f; border-color:#8fbf3f; color:#fff; }
    #ttb-panel { position:fixed; right:12px; bottom:12px; width:540px; max-width:calc(100vw - 24px); z-index:99999;
      background:#222; color:#ddd; border:1px solid #444; border-radius:6px; font:12px Arial,sans-serif;
      box-shadow:0 4px 16px rgba(0,0,0,.5); }
    #ttb-panel button { background:#3a3a3a; color:#ddd; border:1px solid #555; border-radius:3px; cursor:pointer; padding:2px 6px; }
    .ttb-head { display:flex; gap:8px; align-items:center; padding:8px; border-bottom:1px solid #444; }
    .ttb-head span { flex:1; color:#9c9; }
    .ttb-body { max-height:300px; overflow-y:auto; }
    .ttb-empty { padding:10px; color:#888; }
    .ttb-row { display:grid; grid-template-columns:1fr 78px 52px 92px 92px 22px; gap:6px; align-items:center;
      padding:4px 8px; border-bottom:1px solid #333; }
    .ttb-hdr { color:#888; font-size:11px; border-bottom:1px solid #444; }
    .ttb-hdr span:not(:first-child) { text-align:right; }
    .ttb-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .ttb-unit { color:#999; text-align:right; }
    .ttb-line { color:#9c9; text-align:right; font-weight:bold; }
    .ttb-te { color:#7cc4ff; text-align:right; font-weight:bold; }
    .ttb-miss { color:#777; font-weight:normal; }
    .ttb-qty, .ttb-recv { width:100%; box-sizing:border-box; background:#111; color:#eee; border:1px solid #555; border-radius:3px; padding:2px 4px; }
    .ttb-foot { padding:8px; display:grid; gap:6px; }
    .ttb-foot > div { display:flex; justify-content:space-between; align-items:center; gap:8px; }
    .ttb-foot small { color:#999; font-weight:normal; }
    .ttb-foot .ttb-recv { width:150px; text-align:right; }
    .ttb-warn { color:#d9a441; }
    .ttb-best { border-top:1px solid #444; padding-top:6px; display:block !important; }
    .ttb-best-head { color:#999; margin-bottom:4px; }
    .ttb-best-row { display:grid; grid-template-columns:1fr 130px 80px 40px; gap:6px; align-items:center; padding:3px 0; }
    .ttb-best-row span:nth-child(2), .ttb-best-row span:nth-child(3) { text-align:right; }
    .ttb-best-row small { color:#999; }
    .ttb-best-row.ttb-active { color:#7cc4ff; }
    .ttb-split { border-top:1px dashed #444; color:#d9a441; }
    .ttb-dot { display:inline-block; width:7px; height:7px; border-radius:50%; margin-right:5px; background:#666; }
    .ttb-dot.ttb-on { background:#8fbf3f; } .ttb-dot.ttb-idle { background:#d9a441; }
    #ttb-panel button.ttb-switch-on { background:#1f4e6b; border-color:#7cc4ff; color:#fff; }
    #ttb-panel.ttb-no-te .ttb-row { grid-template-columns:1fr 78px 52px 92px 22px; }
    #ttb-panel.ttb-no-te .ttb-te { display:none; }
    .ttb-pos { color:#8fbf3f; } .ttb-neg { color:#e66; }
    .ttb-actions { justify-content:flex-end !important; }
  `;
  document.head.appendChild(css);

  // ---------- boot ----------
  let t;
  new MutationObserver(() => { clearTimeout(t); t = setTimeout(scan, 150); })
    .observe(document.body, { childList: true, subtree: true });
  scan();
  render();
  if (teOn && (!te || te.trader !== trader || Date.now() - te.ts > TE_STALE_MS)) fetchTE();
})();
