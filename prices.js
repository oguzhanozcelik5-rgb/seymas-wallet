// Live price sources.
// Every price is returned in the asset's native currency:
//   US stocks in USD; BIST stocks, gold and foreign currency in TRY.
//
// Two ways to get prices:
//  1. A price server URL in Settings (the small Cloudflare Worker in /worker).
//     It reads Yahoo Finance (the same exchange feed investing.com shows) for
//     US and BIST stocks and FX, and Harem Altın for gold.
//  2. Without it, gold and FX come from free public feeds that allow browser
//     access (Truncgil Finans for Kapalıçarşı gold + FX, Frankfurter as FX
//     backup). Stocks then need their price typed in by hand.

export const GOLD_KINDS = {
  gram:       { label: 'Gram altın (24 ayar)', unit: 'gram' },
  ceyrek:     { label: 'Çeyrek altın',         unit: 'piece' },
  yarim:      { label: 'Yarım altın',          unit: 'piece' },
  tam:        { label: 'Tam altın',            unit: 'piece' },
  cumhuriyet: { label: 'Cumhuriyet / Ata altın', unit: 'piece' },
  bilezik22:  { label: '22 ayar bilezik (gram)', unit: 'gram' },
};

export const FX_CODES = { USD: 'US Dollar', EUR: 'Euro', GBP: 'British Pound' };

// Parses numbers like 4123.45, "4.123,45", "34,1234", "%1,23".
export function parseNum(v) {
  if (typeof v === 'number') return v;
  if (v == null) return NaN;
  let s = String(v).replace(/[%\s₺$]/g, '');
  const c = s.lastIndexOf(','), d = s.lastIndexOf('.');
  if (c >= 0 && d >= 0) s = c > d ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (c >= 0) s = s.replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  return parseFloat(s);
}

async function getJson(url, opts = {}, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal, cache: 'no-store' });
    if (!r.ok) throw new Error(`${r.status} from ${new URL(url).host}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

const norm = (k) => k.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ı/g, 'i').replace(/[^a-z0-9]/g, '');

// Truncgil keys differ between API versions, so match by normalised aliases.
const TRUNCGIL_ALIASES = {
  'fx:USD': ['usd'],
  'fx:EUR': ['eur'],
  'fx:GBP': ['gbp'],
  'gold:gram': ['gramaltin', 'gra', 'gram'],
  'gold:ceyrek': ['ceyrekaltin', 'cey', 'ceyrek'],
  'gold:yarim': ['yarimaltin', 'yar', 'yarim'],
  'gold:tam': ['tamaltin', 'tam'],
  'gold:cumhuriyet': ['cumhuriyetaltini', 'cum', 'ata', 'ataaltin'],
  'gold:bilezik22': ['22ayarbilezik', 'yia', 'bilezik22', '22ayar'],
};

// Value holdings at the dealer's buying price (Alış): what she would get if she sold.
function pickBuying(o) {
  if (o == null) return NaN;
  if (typeof o !== 'object') return parseNum(o);
  for (const k of Object.keys(o)) {
    if (['buying', 'alis', 'alış'].includes(k.toLowerCase())) return parseNum(o[k]);
  }
  for (const k of Object.keys(o)) {
    if (['selling', 'satis', 'satış'].includes(k.toLowerCase())) return parseNum(o[k]);
  }
  return NaN;
}

export async function fetchTruncgil() {
  let data, lastErr;
  for (const url of ['https://finans.truncgil.com/v4/today.json', 'https://finans.truncgil.com/today.json']) {
    try { data = await getJson(url); break; } catch (e) { lastErr = e; }
  }
  if (!data) throw lastErr;
  const byNorm = {};
  for (const [k, v] of Object.entries(data)) byNorm[norm(k)] = v;
  const out = {};
  for (const [key, aliases] of Object.entries(TRUNCGIL_ALIASES)) {
    for (const a of aliases) {
      const p = pickBuying(byNorm[a]);
      if (p > 0) { out[key] = p; break; }
    }
  }
  return out;
}

export async function fetchFrankfurter(date = 'latest') {
  const paths = [`https://api.frankfurter.dev/v1/${date}?base=USD&symbols=TRY,EUR,GBP`,
                 `https://api.frankfurter.app/${date}?from=USD&to=TRY,EUR,GBP`];
  let lastErr;
  for (const url of paths) {
    try {
      const j = await getJson(url);
      const r = j.rates;
      return { 'fx:USD': r.TRY, 'fx:EUR': r.TRY / r.EUR, 'fx:GBP': r.TRY / r.GBP, date: j.date };
    } catch (e) { lastErr = e; }
  }
  throw lastErr;
}

// USD/TRY on a past date, used to turn a purchase cost into dollars.
export async function usdTryOn(date, proxyUrl) {
  if (proxyUrl) {
    try {
      const j = await getJson(`${proxyUrl.replace(/\/$/, '')}/history?symbol=${encodeURIComponent('USDTRY=X')}&date=${date}`);
      if (j.close > 0) return j.close;
    } catch { /* fall through */ }
  }
  const r = await fetchFrankfurter(date);
  return r['fx:USD'];
}

// Closing price of a symbol on a past date (only with the price server).
export async function historicalPrice(asset, date, proxyUrl) {
  if (!proxyUrl) return null;
  const sym = yahooSymbol(asset);
  if (!sym) return null;
  const j = await getJson(`${proxyUrl.replace(/\/$/, '')}/history?symbol=${encodeURIComponent(sym)}&date=${date}`);
  return j.close > 0 ? j.close : null;
}

export function priceKey(a) {
  switch (a.type) {
    case 'us': return `us:${a.symbol}`;
    case 'bist': return `bist:${a.symbol}`;
    case 'gold': return `gold:${a.symbol}`;
    case 'fx': return `fx:${a.symbol}`;
    default: return 'try';
  }
}

function yahooSymbol(a) {
  if (a.type === 'us') return a.symbol;
  if (a.type === 'bist') return `${a.symbol}.IS`;
  if (a.type === 'fx') return `${a.symbol}TRY=X`;
  return null;
}

// Returns { prices: {key: number}, sources: [string], errors: [string] }.
export async function fetchAllPrices(assets, proxyUrl) {
  const prices = {}, sources = new Set(), errors = [];
  const keys = new Set(assets.map(priceKey));
  keys.add('fx:USD'); // always needed for the dollar totals

  if (proxyUrl) {
    const base = proxyUrl.replace(/\/$/, '');
    const syms = {};
    for (const a of assets) { const s = yahooSymbol(a); if (s) syms[s] = priceKey(a); }
    syms['USDTRY=X'] = 'fx:USD';
    try {
      const j = await getJson(`${base}/quotes?symbols=${encodeURIComponent(Object.keys(syms).join(','))}`);
      for (const [s, q] of Object.entries(j.quotes || {})) if (q && q.price > 0 && syms[s]) prices[syms[s]] = q.price;
      sources.add('Yahoo Finance');
    } catch (e) { errors.push(`Price server (stocks): ${e.message}`); }
    try {
      const j = await getJson(`${base}/gold`);
      for (const [k, v] of Object.entries(j.gold || {})) if (v > 0) prices[`gold:${k}`] = v;
      if (j.source) sources.add(j.source);
    } catch (e) { errors.push(`Price server (gold): ${e.message}`); }
  }

  const missing = () => [...keys].some((k) => (k.startsWith('gold:') || k.startsWith('fx:')) && !(prices[k] > 0));
  if (missing()) {
    try {
      const t = await fetchTruncgil();
      for (const [k, v] of Object.entries(t)) if (!(prices[k] > 0)) prices[k] = v;
      sources.add('Truncgil Finans (Kapalıçarşı)');
    } catch (e) { errors.push(`Truncgil: ${e.message}`); }
  }
  if ([...keys].some((k) => k.startsWith('fx:') && !(prices[k] > 0))) {
    try {
      const f = await fetchFrankfurter();
      for (const k of ['fx:USD', 'fx:EUR', 'fx:GBP']) if (!(prices[k] > 0)) prices[k] = f[k];
      sources.add('Frankfurter (ECB daily)');
    } catch (e) { errors.push(`Frankfurter: ${e.message}`); }
  }
  prices.try = 1;
  return { prices, sources: [...sources], errors };
}
