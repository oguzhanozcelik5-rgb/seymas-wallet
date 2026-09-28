import { priceKey } from './prices.js';

export const nativeCurrency = (a) => (a.type === 'us' ? 'USD' : 'TRY');

export function currentPrice(state, a) {
  if (a.type === 'try') return { price: 1, live: true };
  const k = priceKey(a);
  const live = state.prices[k];
  if (live && live.price > 0) return { price: live.price, live: true, time: live.time };
  const m = state.manual[k];
  if (m > 0) return { price: m, live: false };
  return { price: null, live: false };
}

export function usdTryNow(state) {
  const p = state.prices['fx:USD'];
  return p && p.price > 0 ? p.price : null;
}

// Cost and current value of one holding, in TRY and USD.
export function valueAsset(state, a) {
  const usdTry = usdTryNow(state);
  const { price, live } = currentPrice(state, a);
  const isUsd = nativeCurrency(a) === 'USD';
  const buyPrice = a.type === 'try' ? 1 : a.buyPrice;
  const costNative = a.quantity * buyPrice;
  // Rate on the purchase date; today's rate until it has been looked up.
  const buyRate = a.buyUsdTry > 0 ? a.buyUsdTry : usdTry;
  const costTry = isUsd ? costNative * buyRate : costNative;
  const costUsd = isUsd ? costNative : costTry / buyRate;
  const out = { asset: a, price, live, costTry, costUsd, valueTry: null, valueUsd: null, gainTry: null, gainUsd: null };
  if (price == null || !usdTry) return out;
  const valueNative = a.quantity * price;
  out.valueTry = isUsd ? valueNative * usdTry : valueNative;
  out.valueUsd = out.valueTry / usdTry;
  out.gainTry = out.valueTry - costTry;
  out.gainUsd = out.valueUsd - costUsd;
  return out;
}

export function totals(state) {
  const rows = state.assets.map((a) => valueAsset(state, a));
  const t = { valueTry: 0, valueUsd: 0, costTry: 0, costUsd: 0, unpriced: 0 };
  for (const r of rows) {
    if (r.valueTry == null) { t.unpriced++; continue; }
    t.valueTry += r.valueTry; t.valueUsd += r.valueUsd;
    t.costTry += r.costTry; t.costUsd += r.costUsd;
  }
  t.gainTry = t.valueTry - t.costTry;
  t.gainUsd = t.valueUsd - t.costUsd;
  return { rows, t };
}

export const today = () => localDate(new Date());
export function localDate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// Remember today's totals so later months can be compared.
export function recordSnapshot(state) {
  const { t } = totals(state);
  if (!state.assets.length || !usdTryNow(state)) return;
  state.snapshots[today()] = {
    valueTry: t.valueTry, costTry: t.costTry, valueUsd: t.valueUsd, costUsd: t.costUsd,
  };
}

// Gain for a month = unrealised gain at the end of the month minus unrealised
// gain at the start. Buying something new doesn't count as a gain, because
// its cost is added on both sides.
export function monthly(state) {
  const days = Object.keys(state.snapshots).sort();
  if (!days.length) return [];
  const g = (s) => ({ try: s.valueTry - s.costTry, usd: s.valueUsd - s.costUsd });
  const nowMonth = today().slice(0, 7);
  const months = [];
  let [y, m] = days[0].slice(0, 7).split('-').map(Number);
  for (;;) {
    const key = `${y}-${String(m).padStart(2, '0')}`;
    months.push(key);
    if (key >= nowMonth) break;
    m++; if (m > 12) { m = 1; y++; }
  }
  const out = [];
  for (const mk of months) {
    const inMonth = days.filter((d) => d.startsWith(mk));
    const before = days.filter((d) => d < `${mk}-01`);
    if (!inMonth.length) { out.push({ month: mk, noData: true }); continue; }
    const endDay = inMonth[inMonth.length - 1];
    const startDay = before.length ? before[before.length - 1] : inMonth[0];
    const e = g(state.snapshots[endDay]), s = g(state.snapshots[startDay]);
    out.push({
      month: mk, from: startDay, to: endDay, firstMonth: !before.length,
      gainTry: e.try - s.try, gainUsd: e.usd - s.usd,
    });
  }
  return out.reverse();
}

// Pure gold in each kind, in grams of 24 ayar (a çeyrek is 1.75 g of 22 ayar).
export const GOLD_24K_GRAMS = { gram: 1, ceyrek: 1.6066, yarim: 3.2133, tam: 6.4266, cumhuriyet: 6.6098, bilezik22: 0.916 };

function sumRows(rows) {
  const t = { costTry: 0, costUsd: 0, valueTry: 0, valueUsd: 0, unpriced: 0 };
  for (const r of rows) {
    t.costTry += r.costTry; t.costUsd += r.costUsd;
    if (r.valueTry == null) { t.unpriced++; continue; }
    t.valueTry += r.valueTry; t.valueUsd += r.valueUsd;
  }
  // Gains only make sense when every holding in the group has a price.
  t.gainTry = t.unpriced ? null : t.valueTry - t.costTry;
  t.gainUsd = t.unpriced ? null : t.valueUsd - t.costUsd;
  if (t.unpriced) { t.valueTry = null; t.valueUsd = null; }
  return t;
}

// Cumulative totals: all gold together, each currency, each stock.
export function summary(state) {
  const { rows } = totals(state);
  const out = { gold: null, currencies: [], stocks: [], lira: null };

  const gold = rows.filter((r) => r.asset.type === 'gold');
  if (gold.length) {
    const kinds = {};
    let grams = 0;
    for (const r of gold) {
      const k = r.asset.symbol;
      kinds[k] = (kinds[k] || 0) + r.asset.quantity;
      grams += r.asset.quantity * (GOLD_24K_GRAMS[k] ?? 1);
    }
    const t = sumRows(gold);
    out.gold = { ...t, grams, kinds, avgCostPerGram: t.costTry / grams, valuePerGram: t.valueTry == null ? null : t.valueTry / grams };
  }

  const group = (type) => {
    const by = {};
    for (const r of rows.filter((x) => x.asset.type === type)) (by[r.asset.symbol] ||= []).push(r);
    return Object.entries(by).map(([symbol, rs]) => {
      const t = sumRows(rs);
      const quantity = rs.reduce((s, r) => s + r.asset.quantity, 0);
      const costNative = rs.reduce((s, r) => s + r.asset.quantity * r.asset.buyPrice, 0);
      return { ...t, symbol, type, quantity, avgCost: costNative / quantity, price: rs[0].price, count: rs.length };
    }).sort((a, b) => (b.valueTry ?? b.costTry) - (a.valueTry ?? a.costTry));
  };
  out.currencies = group('fx');
  out.stocks = [...group('bist'), ...group('us')];

  const lira = rows.filter((r) => r.asset.type === 'try');
  if (lira.length) out.lira = { ...sumRows(lira), quantity: lira.reduce((s, r) => s + r.asset.quantity, 0) };
  return out;
}
