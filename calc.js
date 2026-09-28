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
