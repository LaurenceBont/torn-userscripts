// ==UserScript==
// @name         Torn Trade Basket (live loader)
// @namespace    laurence.torn.loader
// @version      1.4.0
// @description  Loads the latest Torn Trade Basket from GitHub on every page load, so pushed changes apply on the next reload.
// @match        https://www.torn.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @connect      api.github.com
// @connect      raw.githubusercontent.com
// @connect      tornexchange.com
// @connect      www.tornexchange.com
// @connect      api.torn.com
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/LaurenceBont/torn-userscripts/main/torn-trade-basket.loader.user.js
// @downloadURL  https://raw.githubusercontent.com/LaurenceBont/torn-userscripts/main/torn-trade-basket.loader.user.js
// ==/UserScript==

// How it works: ask the GitHub API for the latest commit of the script file (not CDN-cached),
// download the file at that exact commit (immutable URL, so no stale cache), keep it in storage, run it.
// The check is throttled so a burst of reloads stays under GitHub's 60 requests/hour anonymous limit;
// if GitHub is unreachable or rate-limited, the last downloaded version runs.

(function () {
  'use strict';

  const OWNER = 'LaurenceBont';
  const REPO = 'torn-userscripts';
  const FILE = 'torn-trade-basket.user.js';
  const MIN_CHECK_MS = 15 * 1000;

  // Installed for all of torn.com so new pages need no reinstall: the cached script runs everywhere and
  // decides itself where to act. The GitHub check only runs on these main pages, to stay under the rate limit.
  const CHECK_PAGES = ['/item.php', '/trade.php'];
  const checkHere = CHECK_PAGES.includes(location.pathname);

  const K_CODE = 'loader_code';
  const K_SHA = 'loader_sha';
  const K_CHECKED = 'loader_checked';

  function get(url, headers) {
    return new Promise((resolve) => GM_xmlhttpRequest({
      method: 'GET', url, headers: headers || {},
      onload: (r) => resolve(r),
      onerror: () => resolve({ status: 0, responseText: '' }),
      ontimeout: () => resolve({ status: 0, responseText: '' }),
      timeout: 5000,
    }));
  }

  async function latest(force) {
    const now = Date.now();
    if (!force && now - GM_getValue(K_CHECKED, 0) < MIN_CHECK_MS && GM_getValue(K_CODE, '')) return;
    GM_setValue(K_CHECKED, now);

    const r = await get(`https://api.github.com/repos/${OWNER}/${REPO}/commits?path=${FILE}&per_page=1`,
      { Accept: 'application/vnd.github+json' });
    if (r.status !== 200) return; // offline or rate-limited, keep cached version
    let sha;
    try { sha = JSON.parse(r.responseText)[0].sha; } catch (e) { return; }
    if (sha === GM_getValue(K_SHA, '') && GM_getValue(K_CODE, '')) return;

    const f = await get(`https://raw.githubusercontent.com/${OWNER}/${REPO}/${sha}/${FILE}`);
    if (f.status !== 200 || !f.responseText.includes('==UserScript==')) return;
    GM_setValue(K_CODE, f.responseText);
    GM_setValue(K_SHA, sha);
  }

  GM_registerMenuCommand('Force update now', async () => {
    await latest(true);
    location.reload();
  });

  (checkHere || !GM_getValue(K_CODE, '') ? latest(false) : Promise.resolve()).then(() => {
    const code = GM_getValue(K_CODE, '');
    if (!code) { console.warn('[TTB loader] no script downloaded yet'); return; }
    try {
      const TTB_LOADER = true; // tells the loaded script it runs via the loader (used for the one-time data hand-over)
      const TTB_LOADER_SHA = GM_getValue(K_SHA, ''); // shown in the panel next to the version
      const TTB_FORCE_UPDATE = async () => { await latest(true); location.reload(); }; // panel ⟳ button
      // direct eval keeps the GM_* functions of this script in scope for the loaded code
      eval(code + `\n//# sourceURL=${FILE}@${GM_getValue(K_SHA, '').slice(0, 7)}`);
    } catch (e) {
      console.error('[TTB loader] script error', e);
    }
  });
})();
