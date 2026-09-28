// Seyma's Wallet price server: a free Cloudflare Worker.
// Browsers can't read investing.com, Yahoo Finance or Harem Altın directly
// (they block other websites), so this small server fetches them and hands
// the numbers to the app.
//
//   GET /quotes?symbols=AAPL,THYAO.IS,USDTRY=X  -> { quotes: { AAPL: { price, currency, time } } }
//   GET /history?symbol=THYAO.IS&date=2024-05-10 -> { close, date }
//   GET /gold                                   -> { gold: { gram, ceyrek, ... }, source }
//
// Gold prices are the dealer's buying price (Alış) in TRY.

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

const json = (body, status = 200, maxAge = 30) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${maxAge}`, ...CORS },
  });

async function yahooChart(symbol, params) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?${params}`;
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`Yahoo ${r.status} for ${symbol}`);
  const j = await r.json();
  const res = j.chart?.result?.[0];
  if (!res) throw new Error(`No data for ${symbol}`);
  return res;
}

async function quotes(symbols) {
  const out = {};
  await Promise.all(symbols.map(async (s) => {
    try {
      const res = await yahooChart(s, 'range=1d&interval=1d');
      const m = res.meta;
      out[s] = { price: m.regularMarketPrice, currency: m.currency, time: m.regularMarketTime };
    } catch (e) {
      out[s] = null;
    }
  }));
  return out;
}

// Closing price on the given day, or the last trading day before it.
async function history(symbol, date) {
  const t = Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000);
  const res = await yahooChart(symbol, `period1=${t - 10 * 86400}&period2=${t + 86400}&interval=1d`);
  const ts = res.timestamp || [];
  const closes = res.indicators?.quote?.[0]?.close || [];
  let best = null;
  for (let i = 0; i < ts.length; i++) {
    if (closes[i] != null && ts[i] <= t + 86400) best = { close: closes[i], date: new Date(ts[i] * 1000).toISOString().slice(0, 10) };
  }
  if (!best) throw new Error('No price for that day');
  return best;
}

const num = (v) => {
  if (typeof v === 'number') return v;
  let s = String(v ?? '').replace(/[^\d.,-]/g, '');
  const c = s.lastIndexOf(','), d = s.lastIndexOf('.');
  if (c >= 0 && d >= 0) s = c > d ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (c >= 0) s = s.replace(',', '.');
  return parseFloat(s);
};

// Harem Altın's price data (the feed behind their live price page).
const haremPick = (d) => {
  const pick = (...keys) => { for (const k of keys) { const v = num(d[k]?.alis); if (v > 0) return v; } return undefined; };
  return {
    gram: pick('KULCEALTIN', 'ALTIN'), ceyrek: pick('CEYREK_YENI', 'CEYREK_ESKI'), yarim: pick('YARIM_YENI', 'YARIM_ESKI'),
    tam: pick('TEK_YENI', 'TEK_ESKI'), cumhuriyet: pick('ATA_YENI', 'ATA_ESKI'), bilezik22: pick('AYAR22'),
  };
};
async function haremGold() {
  const attempts = [
    () => fetch('https://canlipiyasalar.haremaltin.com/tmp/altin.json?dil_kodu=tr', { headers: { 'User-Agent': UA, Referer: 'https://canlipiyasalar.haremaltin.com/' } }),
    () => fetch('https://www.haremaltin.com/dashboard/ajax/altin', {
      method: 'POST',
      headers: {
        'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest', Referer: 'https://www.haremaltin.com/', Origin: 'https://www.haremaltin.com',
      },
      body: 'dil_kodu=tr',
    }),
  ];
  let last;
  for (const go of attempts) {
    try {
      const r = await go();
      if (!r.ok) { last = new Error(`Harem ${r.status}`); continue; }
      const j = await r.json();
      const gold = haremPick(j.data || j);
      if (gold.gram) return gold;
      last = new Error(`Harem: unexpected keys ${Object.keys(j.data || j).slice(0, 15).join(',')}`);
    } catch (e) { last = e; }
  }
  throw last;
}

// GenelPara's public gold feed (Kapalıçarşı prices).
async function genelParaGold() {
  const r = await fetch('https://api.genelpara.com/embed/altin.json', { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`GenelPara ${r.status}`);
  const d = await r.json();
  const pick = (...keys) => { for (const k of keys) { const v = num(d[k]?.alis); if (v > 0) return v; } return undefined; };
  const gold = { gram: pick('GA'), ceyrek: pick('C'), yarim: pick('Y'), tam: pick('T'), cumhuriyet: pick('CMR', 'ATA'), bilezik22: pick('YIA', '22') };
  if (!gold.gram) throw new Error(`GenelPara: unexpected keys ${Object.keys(d).slice(0, 15).join(',')}`);
  return gold;
}

// Kapalıçarşı prices from Truncgil Finans.
async function truncgilGold() {
  const r = await fetch('https://finans.truncgil.com/v4/today.json', { headers: { 'User-Agent': UA } });
  if (!r.ok) throw new Error(`Truncgil ${r.status}`);
  const d = await r.json();
  const norm = (k) => k.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i').replace(/[^a-z0-9]/g, '');
  const by = {}; for (const [k, v] of Object.entries(d)) by[norm(k)] = v;
  const buying = (o) => { if (!o || typeof o !== 'object') return NaN; for (const k of Object.keys(o)) if (['buying', 'alis', 'alış'].includes(k.toLowerCase())) return num(o[k]); return NaN; };
  const pick = (...keys) => { for (const k of keys) { const v = buying(by[k]); if (v > 0) return v; } return undefined; };
  const gold = {
    gram: pick('gramaltin', 'gra'), ceyrek: pick('ceyrekaltin', 'cey'), yarim: pick('yarimaltin', 'yar'),
    tam: pick('tamaltin', 'tam'), cumhuriyet: pick('cumhuriyetaltini', 'cum'), bilezik22: pick('22ayarbilezik', 'yia'),
  };
  if (!gold.gram) throw new Error('no gold prices');
  return gold;
}

// Last resort: world gold price (ounce, USD) converted to TRY per gram.
async function worldGold() {
  const q = await quotes(['GC=F', 'USDTRY=X']);
  return { gram: (q['GC=F'].price * q['USDTRY=X'].price) / 31.1035 };
}

async function goldPrices() {
  const sources = [['Harem Altın', haremGold], ['GenelPara (Kapalıçarşı)', genelParaGold], ['Truncgil Finans (Kapalıçarşı)', truncgilGold], ['World gold price', worldGold]];
  let last;
  for (const [source, fn] of sources) {
    try {
      const gold = await fn();
      // Coins a source didn't list are estimated from their gold content (22 ayar).
      const grams = { ceyrek: 1.6066, yarim: 3.2133, tam: 6.4266, cumhuriyet: 6.6098, bilezik22: 0.916 };
      for (const [k, g] of Object.entries(grams)) if (!(gold[k] > 0)) gold[k] = gold.gram * g;
      return { gold, source };
    } catch (e) { last = e; }
  }
  throw last;
}

export default {
  async fetch(req) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    try {
      if (url.pathname === '/quotes') {
        const symbols = (url.searchParams.get('symbols') || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 40);
        return json({ quotes: await quotes(symbols) });
      }
      if (url.pathname === '/history') {
        const symbol = url.searchParams.get('symbol');
        const date = url.searchParams.get('date');
        if (!symbol || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return json({ error: 'symbol and date required' }, 400);
        return json(await history(symbol, date), 200, 86400);
      }
      if (url.pathname === '/gold') {
        return json(await goldPrices());
      }
      return json({ ok: true, app: "Seyma's Wallet price server" });
    } catch (e) {
      return json({ error: e.message }, 502, 0);
    }
  },
};
