// Collects stock, currency and gold prices into prices.json.
// Runs on GitHub Actions every ~15 minutes; the app reads the result
// from raw.githubusercontent.com, which phones are allowed to fetch.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const FX = ['USDTRY=X', 'EURTRY=X', 'GBPTRY=X'];

const symbols = [...new Set([
  ...readFileSync('symbols.txt', 'utf8').split('\n').map((l) => l.trim().toUpperCase()).filter((l) => l && !l.startsWith('#')),
  ...FX,
])];

const num = (v) => {
  if (typeof v === 'number') return v;
  let s = String(v ?? '').replace(/[^\d.,-]/g, '');
  const c = s.lastIndexOf(','), d = s.lastIndexOf('.');
  if (c >= 0 && d >= 0) s = c > d ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (c >= 0) s = s.replace(',', '.');
  return parseFloat(s);
};

async function quote(symbol) {
  for (const host of ['query1', 'query2']) {
    try {
      const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`, { headers: { 'User-Agent': UA } });
      if (!r.ok) continue;
      const m = (await r.json()).chart?.result?.[0]?.meta;
      if (m?.regularMarketPrice > 0) return { price: m.regularMarketPrice, currency: m.currency, time: m.regularMarketTime };
    } catch { /* try next host */ }
  }
  return null;
}

// Harem Altın's live prices come over a socket.io connection (the same one
// their website uses). Connect, wait for the first "price_changed" message.
const HAREM_WS = 'wss://hrmsocketonly.haremaltin.com/socket.io/?EIO=4&transport=websocket';
const haremPick = (d) => {
  const pick = (...keys) => { for (const k of keys) { const v = num(d[k]?.alis); if (v > 0) return v; } return undefined; };
  return {
    gram: pick('KULCEALTIN', 'ALTIN'), ceyrek: pick('CEYREK_YENI', 'CEYREK_ESKI'), yarim: pick('YARIM_YENI', 'YARIM_ESKI'),
    tam: pick('TEK_YENI', 'TEK_ESKI'), cumhuriyet: pick('ATA_YENI', 'ATA_ESKI'), bilezik22: pick('AYAR22'),
  };
};
function haremGold() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(HAREM_WS, { headers: { 'User-Agent': UA, Origin: 'https://www.haremaltin.com' } });
    const data = {};
    const finish = (err) => {
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closed */ }
      const gold = haremPick(data);
      if (gold.gram) { console.log('Harem keys:', Object.keys(data).join(',')); resolve(gold); }
      else reject(err || new Error('Harem sent no gold prices'));
    };
    const timer = setTimeout(() => finish(new Error('Harem timed out')), 15000);
    ws.onerror = () => finish(new Error('Harem connection failed'));
    ws.onmessage = (m) => {
      const t = String(m.data);
      if (t[0] === '0') ws.send('40');
      else if (t === '2') ws.send('3');
      else if (t.startsWith('42')) {
        const [event, payload] = JSON.parse(t.slice(2));
        if (event === 'price_changed') Object.assign(data, payload?.data);
        if (haremPick(data).gram) finish();
      }
    };
  });
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

const quotes = {};
const queue = [...symbols];
await Promise.all(Array.from({ length: 6 }, async () => {
  while (queue.length) { const s = queue.shift(); quotes[s] = await quote(s); }
}));

// Kapalıçarşı prices from Truncgil Finans, used when Harem Altın blocks the request.
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
  const oz = await quote('GC=F');
  const usd = quotes['USDTRY=X'];
  if (!oz || !usd) throw new Error('no world gold price');
  return { gram: (oz.price * usd.price) / 31.1035 };
}

let gold = null, goldSource = null;
for (const [name, fn] of [['Harem Altın', haremGold], ['GenelPara (Kapalıçarşı)', genelParaGold], ['Truncgil Finans (Kapalıçarşı)', truncgilGold], ['World gold price', worldGold]]) {
  try { gold = await fn(); goldSource = name; break; } catch (e) { console.log(`${name} failed:`, e.message); }
}
// Coins a source didn't list are estimated from their gold content (22 ayar).
const GOLD_GRAMS = { ceyrek: 1.6066, yarim: 3.2133, tam: 6.4266, cumhuriyet: 6.6098, bilezik22: 0.916 };
if (gold?.gram) for (const [k, g] of Object.entries(GOLD_GRAMS)) if (!(gold[k] > 0)) gold[k] = gold.gram * g;

const ok = Object.values(quotes).filter(Boolean).length;
console.log(`quotes: ${ok}/${symbols.length}, gold: ${goldSource ?? 'none'}`);
console.log('THYAO.IS', quotes['THYAO.IS'], 'USDTRY', quotes['USDTRY=X'], 'gold gram', gold?.gram);
if (!ok) { console.error('No prices fetched; keeping the previous file.'); process.exit(1); }

mkdirSync('out', { recursive: true });
writeFileSync('out/prices.json', JSON.stringify({ updated: new Date().toISOString(), quotes, gold, goldSource }));
