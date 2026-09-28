# Seyma's Wallet

A phone app (PWA) that tracks Seyma's gold, currencies, Turkish lira and stocks
(Borsa İstanbul and US), with gains in both ₺ and $.

- **Add**: enter an asset, how much, when it was bought and the price paid. The USD/TRY
  rate for that day is filled in automatically, so gains can be shown in dollars too.
- **Overview**: live total value in ₺ and $, gain in lira and in dollars, and every holding.
- **Monthly**: how much she earned each month. The app saves one record a day when it's
  opened, so the history builds up from the first day it's used.

All data stays on her phone (browser storage). Use Settings → Save backup now and then.

## Where prices come from

A GitHub Action in this repo (`.github/workflows/prices.yml`) runs about every 15 minutes
and saves `prices.json` on the `prices` branch. The app reads it; nothing to set up.

- **Stocks and USD/EUR/GBP**: Yahoo Finance (same exchange data investing.com shows).
- **Gold**: Harem Altın when reachable, otherwise Kapalıçarşı prices from GenelPara or
  Truncgil, and as a last resort the world gold price converted to lira.
- **Stocks followed**: the tickers in `symbols.txt`. To add one of her stocks, edit that file
  on GitHub (Borsa İstanbul tickers end in `.IS`, e.g. `THYAO.IS`). Until then she can
  type the price herself on the Overview.

Holdings are valued at the dealer's buying price (Alış), i.e. what she'd get if she sold.

## Put it online (GitHub Pages)

1. Create a GitHub repository and upload everything in this folder except `worker/`.
2. Repository → Settings → Pages → Deploy from branch → `main`, folder `/ (root)`.
3. Open the Pages link on her phone.
   - iPhone (Safari): Share → Add to Home Screen.
   - Android (Chrome): menu → Install app.

## Price server (optional, free, for live stock prices)

1. Sign up at https://dash.cloudflare.com (free plan).
2. Workers & Pages → Create → Create Worker → name it e.g. `seyma-prices` → Deploy.
3. Edit code → replace everything with `worker/price-server.js` → Deploy.
4. Copy the worker address (like `https://seyma-prices.<you>.workers.dev`) into the
   app's Settings → Price server address.

## Files

- `index.html`, `styles.css`, `app.js`: the app's pages
- `prices.js`: price feeds; `calc.js`: gains and monthly math; `store.js`: saving on the phone
- `sw.js`, `manifest.webmanifest`, `icons/`: installable app + offline support
- `worker/price-server.js`: the optional Cloudflare price server
