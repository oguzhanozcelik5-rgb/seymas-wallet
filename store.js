// All data lives in this browser's localStorage. Nothing leaves the phone
// except price requests.

const KEY = 'seymas-wallet-v1';

const empty = () => ({
  assets: [],
  prices: {},        // priceKey -> { price, time, source }
  manual: {},        // priceKey -> price typed by hand (stocks without a price server)
  snapshots: {},     // 'YYYY-MM-DD' -> { valueTry, costTry, valueUsd, costUsd }
  settings: { proxyUrl: '' },
});

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return empty();
    return { ...empty(), ...JSON.parse(raw) };
  } catch {
    return empty();
  }
}

export function save(state) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function exportJson(state) {
  return JSON.stringify({ app: 'seymas-wallet', version: 1, exportedAt: new Date().toISOString(), ...state }, null, 2);
}

export function importJson(text) {
  const j = JSON.parse(text);
  if (!Array.isArray(j.assets)) throw new Error('This file is not a Seyma\'s Wallet backup.');
  const { app, version, exportedAt, ...rest } = j;
  return { ...empty(), ...rest };
}

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
