import { GOLD_KINDS, FX_CODES, parseNum, fetchAllPrices, fetchFrankfurter, usdTryOn, historicalPrice, priceKey, suggestTicker, tickerExists } from './prices.js';
import { load, save, exportJson, importJson, uid } from './store.js';
import { totals, valueAsset, recordSnapshot, monthly, today, nativeCurrency } from './calc.js';

let state = load();
let lastRefresh = null;
let lastSources = [];
let refreshing = false;
const suggestions = {}; // asset id -> { symbol, name } for tickers with no price

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- formatting ----------
const nf = (d) => new Intl.NumberFormat('tr-TR', { minimumFractionDigits: d, maximumFractionDigits: d });
const fmt = {
  TRY: (n) => (n == null ? '—' : `₺${nf(2).format(n)}`),
  USD: (n) => (n == null ? '—' : `$${nf(2).format(n)}`),
  num: (n, d = 4) => new Intl.NumberFormat('tr-TR', { maximumFractionDigits: d }).format(n),
  price: (n, cur) => (n == null ? '—' : (cur === 'USD' ? '$' : '₺') + nf(n < 10 ? 4 : 2).format(n)),
};
const signed = (n, f) => (n == null ? '—' : (n > 0 ? '+' : n < 0 ? '−' : '') + f(Math.abs(n)));
const pct = (g, c) => (g == null || !c ? '' : ` (${g >= 0 ? '+' : '−'}${nf(1).format(Math.abs((g / c) * 100))}%)`);
const cls = (n) => (n > 0.005 ? 'up' : n < -0.005 ? 'down' : '');
const monthName = (mk) => new Date(`${mk}-15`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
const dateText = (d) => new Date(`${d}T12:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

const TYPE_LABEL = { gold: 'Gold', fx: 'Foreign currency', try: 'Turkish lira', bist: 'Borsa İstanbul stocks', us: 'US stocks' };
const TYPE_COLOR = { gold: '#c9982f', fx: '#3d7fb5', try: '#b3413a', bist: '#2f8a63', us: '#7a5bb5' };

function assetName(a) {
  if (a.type === 'gold') return GOLD_KINDS[a.symbol]?.label ?? a.symbol;
  if (a.type === 'fx') return `${FX_CODES[a.symbol] ?? a.symbol} (${a.symbol})`;
  if (a.type === 'try') return 'Turkish lira';
  return a.symbol;
}
function qtyText(a) {
  if (a.type === 'gold') return `${fmt.num(a.quantity)} ${GOLD_KINDS[a.symbol]?.unit === 'gram' ? 'g' : (a.quantity === 1 ? 'piece' : 'pieces')}`;
  if (a.type === 'fx') return `${fmt.num(a.quantity, 2)} ${a.symbol}`;
  if (a.type === 'try') return `₺${nf(2).format(a.quantity)}`;
  return `${fmt.num(a.quantity)} ${a.quantity === 1 ? 'share' : 'shares'}`;
}

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), ms);
}

function persist() {
  if (!save(state)) toast('Could not save on this phone (storage is full or blocked).', 5000);
}

// ---------- routing ----------
const VIEWS = ['add', 'overview', 'monthly'];
function route() {
  let v = location.hash.slice(1);
  if (!VIEWS.includes(v)) v = state.assets.length ? 'overview' : 'add';
  for (const name of VIEWS) $(`#view-${name}`).hidden = name !== v;
  for (const a of document.querySelectorAll('.tabs a')) a.classList.toggle('active', a.dataset.tab === v);
  render();
  window.scrollTo(0, 0);
}

function render() {
  renderOverview();
  renderAssetList();
  renderMonthly();
}

// ---------- overview ----------
function renderOverview() {
  const { rows, t } = totals(state);
  const hasAny = state.assets.length > 0;
  $('#overview-empty').hidden = hasAny;
  $('#total-try').textContent = hasAny ? fmt.TRY(t.valueTry) : '₺0,00';
  $('#total-usd').textContent = hasAny ? fmt.USD(t.valueUsd) : '$0,00';
  const gt = $('#gain-try'), gu = $('#gain-usd');
  gt.textContent = hasAny ? signed(t.gainTry, fmt.TRY) + pct(t.gainTry, t.costTry) : '—';
  gu.textContent = hasAny ? signed(t.gainUsd, fmt.USD) + pct(t.gainUsd, t.costUsd) : '—';
  gt.className = hasAny ? cls(t.gainTry) : '';
  gu.className = hasAny ? cls(t.gainUsd) : '';
  $('#updated').textContent = lastRefresh
    ? `Prices updated ${lastRefresh.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}`
    : refreshing ? 'Loading prices…' : 'Prices not loaded yet';

  // allocation bar
  const byType = {};
  for (const r of rows) if (r.valueTry > 0) byType[r.asset.type] = (byType[r.asset.type] || 0) + r.valueTry;
  const sum = Object.values(byType).reduce((a, b) => a + b, 0);
  const alloc = $('#alloc');
  alloc.innerHTML = '';
  alloc.hidden = !sum;
  let legend = alloc.nextElementSibling;
  if (!legend?.classList.contains('alloc-legend')) {
    legend = document.createElement('div'); legend.className = 'alloc-legend'; alloc.after(legend);
  }
  legend.innerHTML = '';
  legend.hidden = !sum;
  for (const [type, v] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
    const s = document.createElement('span');
    s.style.width = `${(v / sum) * 100}%`; s.style.background = TYPE_COLOR[type];
    alloc.append(s);
    legend.insertAdjacentHTML('beforeend', `<span><i style="background:${TYPE_COLOR[type]}"></i>${esc(TYPE_LABEL[type])} ${nf(0).format((v / sum) * 100)}%</span>`);
  }

  // holdings grouped by type
  const box = $('#holdings');
  box.innerHTML = '';
  for (const type of ['gold', 'fx', 'try', 'bist', 'us']) {
    const group = rows.filter((r) => r.asset.type === type);
    if (!group.length) continue;
    box.insertAdjacentHTML('beforeend', `<div class="group-title">${esc(TYPE_LABEL[type])}</div>`);
    for (const r of group) box.insertAdjacentHTML('beforeend', holdingHtml(r));
  }
}

function holdingHtml(r) {
  const a = r.asset;
  const cur = nativeCurrency(a);
  const needsPrice = r.price == null;
  let priceLine;
  if (a.type === 'try') priceLine = '';
  else if (needsPrice && suggestions[a.id]) {
    const s = suggestions[a.id];
    priceLine = `No price for ${esc(a.symbol)}. Did you mean <strong>${esc(s.symbol)}</strong> (${esc(s.name)})? <button class="link-btn" data-fix-symbol="${esc(a.id)}">Use ${esc(s.symbol)}</button>`;
  } else if (needsPrice) priceLine = `<button class="link-btn" data-set-price="${esc(a.id)}">Enter today's price</button>`;
  else priceLine = `Now ${fmt.price(r.price, cur)}${r.live ? '' : ` <span class="tag">typed in</span> <button class="link-btn" data-set-price="${esc(a.id)}">change</button>`}`;
  return `
  <div class="card holding">
    <div class="holding-top">
      <div>
        <div class="holding-name">${esc(assetName(a))}</div>
        <div class="holding-meta">${esc(qtyText(a))} · bought ${esc(dateText(a.buyDate))}${a.note ? ` · ${esc(a.note)}` : ''}</div>
        <div class="holding-meta">${a.type === 'try' ? '' : `Paid ${fmt.price(a.buyPrice, cur)} · `}${priceLine}</div>
      </div>
      <div class="holding-value">${fmt.TRY(r.valueTry)}<div class="holding-meta">${fmt.USD(r.valueUsd)}</div></div>
    </div>
    <div class="holding-grid">
      <div><span class="k">Gain in lira</span><span class="${cls(r.gainTry)}">${signed(r.gainTry, fmt.TRY)}${pct(r.gainTry, r.costTry)}</span></div>
      <div><span class="k">Gain in dollars</span><span class="${cls(r.gainUsd)}">${signed(r.gainUsd, fmt.USD)}${pct(r.gainUsd, r.costUsd)}</span></div>
    </div>
    <div class="holding-actions">
      <button data-edit="${esc(a.id)}">Edit</button>
      <button class="del" data-del="${esc(a.id)}">Delete</button>
    </div>
  </div>`;
}

$('#holdings').addEventListener('click', (e) => {
  if (handleEditDelete(e)) return;
  const fixId = e.target.closest('[data-fix-symbol]')?.dataset.fixSymbol;
  if (fixId) {
    const a = state.assets.find((x) => x.id === fixId);
    a.symbol = suggestions[fixId].symbol;
    delete suggestions[fixId];
    persist();
    render();
    refresh();
    return;
  }
  const id = e.target.closest('[data-set-price]')?.dataset.setPrice;
  if (!id) return;
  const a = state.assets.find((x) => x.id === id);
  const cur = nativeCurrency(a);
  const v = prompt(`Today's price of ${assetName(a)} in ${cur === 'USD' ? 'dollars' : 'lira'}:`, '');
  if (v == null) return;
  const n = parseNum(v);
  if (!(n > 0)) return toast('That doesn\'t look like a price.');
  state.manual[priceKey(a)] = n;
  recordSnapshot(state);
  persist();
  render();
});

// ---------- monthly ----------
function renderMonthly() {
  const months = monthly(state);
  const nowKey = today().slice(0, 7);
  const cur = months.find((m) => m.month === nowKey && !m.noData);
  $('#month-hero-label').textContent = `This month · ${monthName(nowKey)}`;
  const mt = $('#month-try'), mu = $('#month-usd');
  if (cur) {
    mt.textContent = signed(cur.gainTry, fmt.TRY);
    mu.textContent = signed(cur.gainUsd, fmt.USD);
    mt.className = `hero-value ${cls(cur.gainTry)}`;
    mu.className = `hero-sub ${cls(cur.gainUsd)}`;
    $('#month-foot').textContent = cur.firstMonth
      ? `Counting since ${dateText(cur.from)}, the first day the app recorded her wallet.`
      : `Since the end of last month (${dateText(cur.from)}).`;
  } else {
    mt.textContent = '—'; mu.textContent = '—';
    mt.className = 'hero-value'; mu.className = 'hero-sub';
    $('#month-foot').textContent = state.assets.length ? 'Waiting for today\'s prices.' : 'Add her assets to start tracking.';
  }

  const list = $('#month-list');
  list.innerHTML = '';
  const max = Math.max(1, ...months.filter((m) => !m.noData).map((m) => Math.abs(m.gainTry)));
  for (const m of months) {
    if (m.noData) {
      list.insertAdjacentHTML('beforeend', `<li><div class="month-row"><span class="month-name">${esc(monthName(m.month))}</span><span class="muted">App not opened this month</span></div></li>`);
      continue;
    }
    const w = (Math.abs(m.gainTry) / max) * 50;
    const bar = m.gainTry >= 0
      ? `<span style="left:50%;width:${w}%;background:var(--up)"></span>`
      : `<span style="right:50%;width:${w}%;background:var(--down)"></span>`;
    list.insertAdjacentHTML('beforeend', `
      <li>
        <div class="month-row">
          <span class="month-name">${esc(monthName(m.month))}${m.month === nowKey ? ' <span class="tag">so far</span>' : ''}</span>
          <span class="month-vals"><span class="${cls(m.gainTry)}">${signed(m.gainTry, fmt.TRY)}</span><small class="${cls(m.gainUsd)}">${signed(m.gainUsd, fmt.USD)}</small></span>
        </div>
        <div class="bar">${bar}</div>
      </li>`);
  }
}

// ---------- asset form ----------
const form = $('#asset-form');
form.gold.innerHTML = Object.entries(GOLD_KINDS).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
form.fx.innerHTML = Object.entries(FX_CODES).map(([k, v]) => `<option value="${k}">${esc(v)} (${k})</option>`).join('');
form.buyDate.max = today();

function syncFormToType() {
  const type = form.type.value;
  const show = (sel, on) => form.querySelectorAll(`[data-for="${sel}"]`).forEach((el) => (el.hidden = !on));
  show('stock', type === 'us' || type === 'bist');
  show('gold', type === 'gold');
  show('fx', type === 'fx');
  show('price', type !== 'try');
  form.symbol.placeholder = type === 'us' ? 'e.g. AAPL' : 'e.g. THYAO';
  const goldUnit = GOLD_KINDS[form.gold.value]?.unit;
  $('#qty-label').textContent = {
    us: 'How many shares?', bist: 'How many shares?',
    gold: goldUnit === 'gram' ? 'How many grams?' : 'How many pieces?',
    fx: `How much ${form.fx.value}?`, try: 'How much lira?',
  }[type];
  $('#price-label').textContent = {
    us: 'Price paid per share ($)', bist: 'Price paid per share (₺)',
    gold: goldUnit === 'gram' ? 'Price paid per gram (₺)' : 'Price paid per piece (₺)',
    fx: `Lira paid for 1 ${form.fx.value} (₺)`,
  }[type] ?? '';
  const canLookUp = type === 'fx' || ((type === 'us' || type === 'bist') && state.settings.proxyUrl);
  $('#fill-price').hidden = !canLookUp;
  $('#price-hint').textContent = type === 'gold'
    ? 'Check the receipt, or Harem Altın / the bank history for that day.'
    : canLookUp ? 'Tap Look up to use that day\'s closing price, or type the exact price she paid.' : '';
}
form.type.addEventListener('change', syncFormToType);
form.gold.addEventListener('change', syncFormToType);
form.fx.addEventListener('change', () => { syncFormToType(); form.buyPrice.value = ''; });

// USD/TRY on the purchase date, looked up silently so she never has to type it.
// If the lookup fails it stays empty: the math uses today's rate meanwhile,
// and the next price refresh tries again.
async function usdTryForDate(date) {
  const live = state.prices['fx:USD']?.price;
  if (date === today() && live > 0) return live;
  try {
    const r = await usdTryOn(date, state.settings.proxyUrl);
    if (r > 0) return r;
  } catch { /* retried on next refresh */ }
  return null;
}

// Fill in rates for purchases saved while offline.
async function backfillRates() {
  let changed = false;
  for (const a of state.assets) {
    if (a.buyUsdTry > 0) continue;
    if (a.type === 'fx' && a.symbol === 'USD') { a.buyUsdTry = a.buyPrice; changed = true; continue; }
    const r = await usdTryForDate(a.buyDate);
    if (r > 0) { a.buyUsdTry = r; changed = true; }
  }
  if (changed) persist();
}

$('#fill-price').addEventListener('click', async () => {
  const d = form.buyDate.value;
  if (!d) return toast('Pick the date first.');
  const btn = $('#fill-price');
  btn.disabled = true;
  try {
    let p = null;
    if (form.type.value === 'fx') {
      const code = form.fx.value;
      p = code === 'USD' ? await usdTryOn(d, state.settings.proxyUrl) : (await fetchFrankfurter(d))[`fx:${code}`];
    } else {
      p = await historicalPrice(formAsset(), d, state.settings.proxyUrl);
    }
    if (p > 0) form.buyPrice.value = nf(4).format(p);
    else toast('No price found for that day.');
  } catch {
    toast('Couldn\'t look up the price. Please type it in.');
  } finally {
    btn.disabled = false;
  }
});

function formAsset() {
  const type = form.type.value;
  let symbol = null;
  if (type === 'us' || type === 'bist') symbol = form.symbol.value.trim().toUpperCase().replace(/\.IS$/, '');
  if (type === 'gold') symbol = form.gold.value;
  if (type === 'fx') symbol = form.fx.value;
  return {
    id: form.id.value || uid(),
    type, symbol,
    quantity: parseNum(form.quantity.value),
    buyDate: form.buyDate.value,
    buyPrice: type === 'try' ? 1 : parseNum(form.buyPrice.value),
    buyUsdTry: null,
    note: form.note.value.trim(),
  };
}

let confirmedSymbol = null;

function resetForm() {
  confirmedSymbol = null;
  form.reset();
  form.id.value = '';
  form.buyDate.value = today();
  $('#form-title').textContent = 'Add an asset';
  $('#save-btn').textContent = 'Add asset';
  $('#cancel-edit').hidden = true;
  $('#form-error').hidden = true;
  syncFormToType();
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const a = formAsset();
  const err = (m) => { const el = $('#form-error'); el.textContent = m; el.hidden = false; };
  if ((a.type === 'us' || a.type === 'bist') && !/^[A-Z0-9.\-]{1,12}$/.test(a.symbol || '')) return err('Please enter the ticker symbol, e.g. THYAO or AAPL.');
  if (!(a.quantity > 0)) return err('Please enter how much she has.');
  if (!a.buyDate || a.buyDate > today()) return err('Please pick the date she bought it.');
  if (!(a.buyPrice > 0)) return err('Please enter the price she paid.');
  if ((a.type === 'us' || a.type === 'bist') && a.symbol !== confirmedSymbol) {
    const exists = await tickerExists(a.type, a.symbol);
    if (exists === false) {
      const s = await suggestTicker(a.type, a.symbol);
      confirmedSymbol = a.symbol; // pressing Add again saves it as typed
      if (s) {
        form.symbol.value = s.symbol;
        return err(`${a.symbol} wasn't found. Did you mean ${s.symbol} (${s.name})? We've filled it in; press Add again.`);
      }
      return err(`${a.symbol} wasn't found on ${a.type === 'bist' ? 'Borsa İstanbul' : 'US markets'}. Check the ticker, or press Add again to save it anyway.`);
    }
  }
  const i = state.assets.findIndex((x) => x.id === a.id);
  const old = state.assets[i];
  if (a.type === 'fx' && a.symbol === 'USD') a.buyUsdTry = a.buyPrice;
  else if (old && old.buyDate === a.buyDate && old.buyUsdTry > 0) a.buyUsdTry = old.buyUsdTry;
  else {
    $('#save-btn').disabled = true;
    a.buyUsdTry = await usdTryForDate(a.buyDate);
    $('#save-btn').disabled = false;
  }
  if (i >= 0) state.assets[i] = a; else state.assets.push(a);
  persist();
  const editing = i >= 0;
  resetForm();
  render();
  toast(editing ? 'Saved.' : `${assetName(a)} added.`);
  refresh();
});

$('#cancel-edit').addEventListener('click', resetForm);

function editAsset(a) {
  form.id.value = a.id;
  form.type.value = a.type;
  if (a.type === 'us' || a.type === 'bist') form.symbol.value = a.symbol;
  if (a.type === 'gold') form.gold.value = a.symbol;
  if (a.type === 'fx') form.fx.value = a.symbol;
  form.quantity.value = fmt.num(a.quantity, 6);
  form.buyDate.value = a.buyDate;
  form.buyPrice.value = a.type === 'try' ? '' : fmt.num(a.buyPrice, 6);
  form.note.value = a.note || '';
  $('#form-title').textContent = 'Edit asset';
  $('#save-btn').textContent = 'Save changes';
  $('#cancel-edit').hidden = false;
  syncFormToType();
  form.scrollIntoView({ behavior: 'smooth' });
}

function renderAssetList() {
  const ul = $('#asset-list');
  ul.innerHTML = '';
  $('#list-empty').hidden = state.assets.length > 0;
  const sorted = [...state.assets].sort((a, b) => b.buyDate.localeCompare(a.buyDate));
  for (const a of sorted) {
    const cur = nativeCurrency(a);
    ul.insertAdjacentHTML('beforeend', `
      <li>
        <div>
          <strong>${esc(assetName(a))}</strong>
          <div class="holding-meta">${esc(qtyText(a))}${a.type === 'try' ? '' : ` at ${fmt.price(a.buyPrice, cur)}`} · ${esc(dateText(a.buyDate))}</div>
        </div>
        <div class="actions">
          <button data-edit="${esc(a.id)}">Edit</button>
          <button class="del" data-del="${esc(a.id)}">Delete</button>
        </div>
      </li>`);
  }
}

// Edit and Delete buttons, on both the Overview cards and the Add tab list.
function handleEditDelete(e) {
  const edit = e.target.closest('[data-edit]')?.dataset.edit;
  const del = e.target.closest('[data-del]')?.dataset.del;
  if (edit) {
    if (location.hash !== '#add') { location.hash = '#add'; route(); }
    editAsset(state.assets.find((a) => a.id === edit));
    return true;
  }
  if (del) {
    const a = state.assets.find((x) => x.id === del);
    if (!confirm(`Delete ${assetName(a)} (${qtyText(a)})?`)) return true;
    state.assets = state.assets.filter((x) => x.id !== del);
    if (form.id.value === del) resetForm();
    persist();
    render();
    toast(`${assetName(a)} deleted.`);
    return true;
  }
  return false;
}
$('#asset-list').addEventListener('click', handleEditDelete);

// ---------- prices ----------
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  $('#refresh').classList.add('spinning');
  renderOverview();
  try {
    const { prices, sources, errors } = await fetchAllPrices(state.assets, state.settings.proxyUrl);
    const now = new Date().toISOString();
    for (const [k, v] of Object.entries(prices)) if (v > 0) state.prices[k] = { price: v, time: now };
    await backfillRates();
    lastSources = sources;
    if (Object.keys(prices).length > 1) lastRefresh = new Date();
    recordSnapshot(state);
    persist();
    const notice = $('#notice');
    const noLive = state.assets.filter((a) => (a.type === 'us' || a.type === 'bist') && !(prices[priceKey(a)] > 0));
    const msgs = [];
    if (errors.length && Object.keys(prices).length <= 1) msgs.push('Couldn\'t reach the price feeds. Showing the last saved prices.');
    for (const a of noLive) if (!suggestions[a.id]) suggestTicker(a.type, a.symbol).then((s) => { if (s) { suggestions[a.id] = s; render(); } });
    if (noLive.length) msgs.push(`No live price for ${noLive.map((a) => a.symbol).join(', ')}. Check the ticker, or tap "Enter today's price".`);
    notice.textContent = msgs.join(' ');
    notice.hidden = !msgs.length;
  } finally {
    refreshing = false;
    $('#refresh').classList.remove('spinning');
    render();
  }
}

$('#refresh').addEventListener('click', refresh);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
setInterval(() => { if (!document.hidden) refresh(); }, 60_000);

// ---------- settings ----------
const dlg = $('#settings');
$('#open-settings').addEventListener('click', () => {
  dlg.querySelector('[name=proxyUrl]').value = state.settings.proxyUrl || '';
  $('#sources').textContent = lastSources.length ? `Prices from: ${lastSources.join(', ')}.` : '';
  dlg.showModal();
});
dlg.addEventListener('close', () => {
  const url = dlg.querySelector('[name=proxyUrl]').value.trim();
  if (url !== (state.settings.proxyUrl || '')) {
    state.settings.proxyUrl = url;
    persist();
    syncFormToType();
    refresh();
  }
});
$('#export').addEventListener('click', () => {
  const blob = new Blob([exportJson(state)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `seymas-wallet-${today()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});
$('#import').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const next = importJson(await file.text());
    if (!confirm(`Replace the current data with this backup (${next.assets.length} assets)?`)) return;
    state = next;
    persist();
    dlg.close();
    resetForm();
    route();
    refresh();
    toast('Backup restored.');
  } catch (err) {
    toast(err.message || 'Couldn\'t read that file.', 4000);
  } finally {
    e.target.value = '';
  }
});

// ---------- start ----------
window.addEventListener('hashchange', route);
resetForm();
route();
refresh();

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
