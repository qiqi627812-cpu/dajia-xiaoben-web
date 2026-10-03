// app/rates.js — Frankfurter v2 参考汇率客户端（服务端统一调用，前端不直连）
// 隐私：只向汇率服务发送币种代码与日期；绝不携带账目名称、成员、图片。
// 响应实测（2026-10-03）：
//   GET /v2/rate/hkd/cny             -> {"date":"2026-10-03","base":"HKD","quote":"CNY","rate":0.85339}
//   GET /v2/rate/hkd/cny?date=...    -> 同上（周末请求返回前一交易日及其真实日期）
//   GET /v2/currencies               -> [{iso_code,name,symbol,start_date,end_date}...]（165 个）
//   不支持币种 -> HTTP 422 {"status":422,"message":"invalid currency: XXX"}
// 缓存：DB 表 rate_cache；指定日期的报价不变（永久缓存）；latest 当日复用。
// 并发去重：同 key 的并发请求合并为一次上游调用。超时 8s，不自动重试。

const db = require("../guard_sdk/db");

const BASE = process.env.FX_BASE_URL || "https://api.frankfurter.dev/v2";
const TIMEOUT_MS = 8000;

const inFlight = new Map();   // key -> Promise（并发合并）
const memCatalog = { at: 0, list: null }; // 内存目录缓存（24h）
const DAY_MS = 24 * 3600 * 1000;

function httpError(status, msg, code) {
  const e = new Error(msg);
  e.status = status;
  e.code = code;
  return e;
}

/* ---------- 上游调用（严格校验 base/quote/rate/date） ---------- */
async function fetchUpstream(from, to, date) {
  const url = `${BASE}/rate/${encodeURIComponent(from)}/${encodeURIComponent(to)}${date ? `?date=${encodeURIComponent(date)}` : ""}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort("timeout"), TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(url, { signal: ctrl.signal, headers: { Accept: "application/json" } });
  } catch (e) {
    const reason = String((e && e.message) || e);
    if (reason === "timeout") throw httpError(504, "汇率服务超时（8s）", "timeout");
    throw httpError(502, `汇率服务不可达：${reason.slice(0, 120)}`, "unreachable");
  } finally {
    clearTimeout(timer);
  }

  if (resp.status === 422 || resp.status === 404) {
    let msg = "不支持的币种";
    try { const j = await resp.json(); msg = (j && j.message) || msg; } catch { /* 非 JSON */ }
    throw httpError(422, msg, "unsupported");
  }
  if (!resp.ok) throw httpError(502, `汇率服务返回 ${resp.status}`, "upstream");

  let j;
  try { j = await resp.json(); } catch { throw httpError(502, "汇率响应不是 JSON", "invalid"); }
  const rate = Number(j.rate);
  if (!(rate > 0) || j.base !== from || j.quote !== to || !/^\d{4}-\d{2}-\d{2}$/.test(String(j.date || ""))) {
    throw httpError(502, "汇率响应校验失败（base/quote/rate/date 不符）", "invalid");
  }
  return { rate, rateDate: String(j.date) };
}

/* ---------- 查询：缓存 → 并发合并 → 上游 → 落缓存 ---------- */
async function getRate({ from, to, date }) {
  from = String(from || "").trim().toUpperCase();
  to = String(to || "").trim().toUpperCase();
  if (!/^[A-Z]{2,8}$/.test(from) || !/^[A-Z]{2,8}$/.test(to)) {
    throw httpError(400, "币种代码非法", "bad_request");
  }
  if (from === to) {
    return { ok: true, rate: 1, rateDate: null, source: "same", cached: false, fetchedAt: new Date().toISOString() };
  }
  const reqDate = /^\d{4}-\d{2}-\d{2}$/.test(date || "") ? date : "latest";
  const pair = `${from}->${to}`;
  const key = `${pair} @ ${reqDate}`;

  const pool = db.getPool();
  /* 1) 缓存：指定日期的报价是历史事实（不失效）；latest 只用当日的 */
  try {
    const { rows } = await pool.query(
      "SELECT rate, rate_date, fetched_at FROM rate_cache WHERE pair = $1 AND req_date = $2",
      [pair, reqDate]
    );
    if (rows.length) {
      const fresh = reqDate !== "latest" || Date.now() - new Date(rows[0].fetched_at).getTime() < DAY_MS;
      if (fresh) {
        const rate = Number(rows[0].rate);
        if (rate > 0) {
          return { ok: true, rate, rateDate: rows[0].rate_date, source: "frankfurter", cached: true, fetchedAt: rows[0].fetched_at };
        }
      }
    }
  } catch { /* 缓存读失败不阻塞查询 */ }

  /* 2) 并发去重：同 key 请求只打一次上游 */
  if (inFlight.has(key)) return inFlight.get(key);
  const p = (async () => {
    const r = await fetchUpstream(from, to, reqDate === "latest" ? null : reqDate);
    try {
      await pool.query(
        `INSERT INTO rate_cache (pair, req_date, rate, rate_date, fetched_at) VALUES ($1,$2,$3,$4,now())
         ON CONFLICT (pair, req_date) DO UPDATE SET rate = $3, rate_date = $4, fetched_at = now()`,
        [pair, reqDate, String(r.rate), r.rateDate]
      );
    } catch { /* 缓存写失败不影响返回 */ }
    return { ok: true, rate: r.rate, rateDate: r.rateDate, source: "frankfurter", cached: false, fetchedAt: new Date().toISOString() };
  })().finally(() => { inFlight.delete(key); });
  inFlight.set(key, p);
  return p;
}

/* ---------- 标准目录（Frankfurter /v2/currencies，24h 缓存） ---------- */
async function getCatalog() {
  if (memCatalog.list && Date.now() - memCatalog.at < DAY_MS) return memCatalog.list;
  const pool = db.getPool();
  const readCache = async () => {
    try {
      const { rows } = await pool.query("SELECT rate, fetched_at FROM rate_cache WHERE pair = '__catalog__' AND req_date = 'latest'");
      if (rows.length && Date.now() - new Date(rows[0].fetched_at).getTime() < DAY_MS) {
        return JSON.parse(rows[0].rate);
      }
    } catch { /* ignore */ }
    return null;
  };
  let list = await readCache();
  if (list) { memCatalog.list = list; memCatalog.at = Date.now(); return list; }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort("timeout"), TIMEOUT_MS);
  try {
    const resp = await fetch(`${BASE}/currencies`, { signal: ctrl.signal, headers: { Accept: "application/json" } });
    if (resp.ok) {
      const arr = await resp.json();
      if (Array.isArray(arr)) {
        list = arr
          .filter((c) => c && typeof c.iso_code === "string" && /^[A-Z]{3}$/.test(c.iso_code))
          .map((c) => ({ code: c.iso_code, en: String(c.name || ""), symbol: String(c.symbol || "") }));
        try {
          await pool.query(
            `INSERT INTO rate_cache (pair, req_date, rate, rate_date, fetched_at) VALUES ('__catalog__','latest',$1,null,now())
             ON CONFLICT (pair, req_date) DO UPDATE SET rate = $1, fetched_at = now()`,
            [JSON.stringify(list)]
          );
        } catch { /* ignore */ }
        memCatalog.list = list; memCatalog.at = Date.now();
        return list;
      }
    }
  } catch { /* 不可达 → 退回 curated 目录 */ }
  finally { clearTimeout(timer); }
  memCatalog.at = Date.now(); memCatalog.list = [];
  return null; // 目录不可用：调用方只用 shared/currencies.json
}

module.exports = { getRate, getCatalog, BASE };
