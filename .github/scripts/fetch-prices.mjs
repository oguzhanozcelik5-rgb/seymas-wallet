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

async function haremGold() {
  const r = await fetch('https://www.haremaltin.com/dashboard/ajax/doviz', {
    method: 'POST',
    headers: {
      'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest', Referer: 'https://www.haremaltin.com/', Origin: 'https://www.haremaltin.com',
    },
    body: 'dil_kodu=tr',
  });
  if (!r.ok) throw new Error(`Harem ${r.status}`);
  const d = (await r.json()).data || {};
  const pick = (...keys) => { for (const k of keys) { const v = num(d[k]?.alis); if (v > 0) return v; } return undefined; };
  const gold = {
    gram: pick('KULCEALTIN', 'ALTIN'), ceyrek: pick('CEYREK_YENI', 'CEYREK_ESKI'), yarim: pick('YARIM_YENI', 'YARIM_ESKI'),
    tam: pick('TEK_YENI', 'TEK_ESKI'), cumhuriyet: pick('ATA_YENI', 'ATA_ESKI'), bilezik22: pick('AYAR22'),
  };
  if (!gold.gram) throw new Error('no gold prices');
  return gold;
}

const quotes = {};
const queue = [...symbols];
await Promise.all(Array.from({ length: 6 }, async () => {
  while (queue.length) { const s = queue.shift(); quotes[s] = await quote(s); }
}));

let gold = null, goldSource = null;
try { gold = await haremGold(); goldSource = 'Harem Altın'; } catch (e) { console.log('Harem failed:', e.message); }

const ok = Object.values(quotes).filter(Boolean).length;
console.log(`quotes: ${ok}/${symbols.length}, gold: ${goldSource ?? 'none'}`);
console.log('THYAO.IS', quotes['THYAO.IS'], 'USDTRY', quotes['USDTRY=X'], 'gold gram', gold?.gram);
if (!ok) { console.error('No prices fetched; keeping the previous file.'); process.exit(1); }

mkdirSync('out', { recursive: true });
writeFileSync('out/prices.json', JSON.stringify({ updated: new Date().toISOString(), quotes, gold, goldSource }));
