// api.js — 前端数据访问 + 货币工具 + 分类配置

import { decimalsOf, symOf } from "./currencyMeta";

/* ============ 分类配置（稳定 categoryId；与 server.js / ark.js 保持同一份清单） ============ */
export const CATEGORIES = [
  { id: "groceries",  label: "买菜", icon: "", color: "#EC839D" },
  { id: "dining",     label: "餐饮", icon: "", color: "#E8B85C" },
  { id: "transport",  label: "交通", icon: "", color: "#679BC8" },
  { id: "utilities",  label: "水电", icon: "", color: "#62B5A1" },
  { id: "daily",      label: "日用", icon: "", color: "#8D8BC4" },
  { id: "housing",    label: "住宿", icon: "", color: "#DB8C6D" },
  { id: "fun",        label: "娱乐", icon: "", color: "#B779B1" },
  { id: "other",      label: "其他", icon: "", color: "#8797A3" },
];
export const CATEGORY_BY_ID = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));
export const validCategoryId = (id) => (CATEGORY_BY_ID[id] ? id : "other");
export const catOf = (id) => CATEGORY_BY_ID[id] || CATEGORY_BY_ID.other;

/* 最大余数法：百分比合计恒等于 100（不出现 99%/101%） */
export function percentLargestRemainder(values) {
  const total = values.reduce((a, b) => a + b, 0);
  if (total <= 0) return values.map(() => 0);
  const raw = values.map((v) => (v / total) * 100);
  const floors = raw.map(Math.floor);
  let rest = 100 - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; rest > 0; k = (k + 1) % order.length) {
    floors[order[k].i] += 1;
    rest -= 1;
  }
  return floors;
}

export const localDate = () => new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Hong_Kong"}).format(new Date());

/* 元 → 最小货币单位（小数位按币种元数据：JPY/KRW/VND 0 位、KWD 3 位等） */
export function yuanToMinor(yuan, currency) {
  const n = Number(yuan);
  if (!Number.isFinite(n) || n <= 0) return null;
  const minor = Math.round(n * Math.pow(10, decimalsOf(currency)));
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}

/* 最小货币单位 → 元（显示用） */
export function minorToYuan(minor, currency) {
  return Number(minor) / Math.pow(10, decimalsOf(currency));
}

/* 平分：余数按成员顺序分配，保证守恒 */
export function splitEqual(totalMinor, members) {
  const n = members.length;
  if (!n) return [];
  const base = Math.floor(totalMinor / n);
  const outs = members.map((m) => ({ id: m.id, name: m.name, minor: base }));
  let rest = totalMinor - base * n;
  for (let i = 0; rest > 0; i = (i + 1) % n, rest--) outs[i].minor += 1;
  return outs;
}

export function fmtMoney(minor, currency) {
  const d = decimalsOf(currency);
  const yuan = Number(minor) / Math.pow(10, d);
  const s = d === 0
    ? Math.round(yuan).toLocaleString("zh-CN")
    : yuan.toLocaleString("zh-CN", { minimumFractionDigits: d, maximumFractionDigits: d });
  return `${symOf(currency)}${s}`;
}

async function jfetch(url, opts) {
  const r = await fetch(url, opts);
  let data = null;
  try { data = await r.json(); } catch { /* 非 JSON */ }
  if (!r.ok) {
    const err = new Error((data && (data.error || data.message)) || `请求失败（${r.status}）`);
    err.status = r.status;
    err.payload = data;
    throw err;
  }
  return data;
}

const json = { "Content-Type": "application/json" };

export const api = {
  getRepayments: () => jfetch("api/repayments"),
  addRepayment: payload => jfetch("api/repayments",{method:"POST",headers:json,body:JSON.stringify(payload)}),
  deleteRepayment: id => jfetch(`api/repayments/${id}`,{method:"DELETE"}),
  getProfile: () => jfetch("api/profile"),
  putProfile: (nickname, avatar) => jfetch("api/profile", { method: "PUT", headers: json, body: JSON.stringify({ nickname, avatar }) }),
  putProfileCurrency: (currency) => jfetch("api/profile/currency", { method: "POST", headers: json, body: JSON.stringify({ currency }) }),
  getMembers: () => jfetch("api/members"),
  addMember: (name, avatar) => jfetch("api/members", { method: "POST", headers: json, body: JSON.stringify({ name, avatar }) }),
  patchMember: (id, patch) => jfetch(`api/members/${id}`, { method: "PATCH", headers: json, body: JSON.stringify(patch) }),
  getEntries: (month) => jfetch(`api/entries${month ? `?month=${month}` : ""}`),
  addEntry: (entry) => jfetch("api/entries", { method: "POST", headers: json, body: JSON.stringify(entry) }),
  patchEntry: (id, patch) => jfetch(`api/entries/${id}`, { method: "PATCH", headers: json, body: JSON.stringify(patch) }),
  deleteEntry: (id) => jfetch(`api/entries/${id}`, { method: "DELETE" }),
  undoLatest: () => jfetch("api/entries/undo-latest", { method: "POST", headers: json }),
  aiParse: (payload, opts) => jfetch("api/ai/parse", { method: "POST", headers: json, body: JSON.stringify(payload), ...(opts || {}) }),
  aiStatus: () => jfetch("api/ai/status"),
  getCurrencies: () => jfetch("api/currencies"),
  addCurrency: (payload) => jfetch("api/currencies", { method: "POST", headers: json, body: JSON.stringify(payload) }),
  getRate: (from, to, date) => jfetch(`api/rates?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}${date ? `&date=${encodeURIComponent(date)}` : ""}`),
  applyFx: (target, items) => jfetch("api/entries/fx-apply", { method: "POST", headers: json, body: JSON.stringify({ target, items }) }),
};
