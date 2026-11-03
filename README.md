# torn-userscripts

Tampermonkey userscripts for Torn.

## Torn Trade Basket

Select items on the Items page into a basket and see their total value: market value (from TornTools) and, optionally, TornExchange trader buy prices. Includes a "Find best traders" ranking for the whole basket.

**Install:** open the raw file below with Tampermonkey installed and click Install.

https://raw.githubusercontent.com/LaurenceBont/torn-userscripts/main/torn-trade-basket.user.js

Updates are picked up automatically through Tampermonkey's update check (or Tampermonkey menu > "Check for userscript updates").

**Live version (instant updates):** install the loader instead, and disable or remove the normal script so it doesn't run twice. The loader fetches the latest commit from GitHub on each page load (checked at most every 15 seconds), so a push is live on the next reload.

https://raw.githubusercontent.com/LaurenceBont/torn-userscripts/main/torn-trade-basket.loader.user.js

Only reads the page; it does not click or act in Torn. TornExchange requests run only when the TE switch in the basket is ON.
