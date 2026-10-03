// Express entry point for a Guard sub-app (static HTML/JS frontend + JSON API).
//
// Shape:
//   /api/*                       -> JSON business endpoints (add yours)
//   /healthz                     -> provided
//   everything else              -> static files from ../static (mounted LAST)
//
// Rules enforced by structure:
//   - business data served as JSON, never inlined into the HTML shell
//   - express.static mounted directly (no app.use('*', ...) — that 301-loops)
//   - listens on 0.0.0.0:3000 (APP_PORT), env names carry APP_ prefix

const path = require("path");
const express = require("express");
const db = require("../guard_sdk/db");
const ai = require("../guard_sdk/ai");

const app = express();
app.set("trust proxy", true);
/* 请求到达打点：用于测量 AI 请求「上传/解析/模型」三段真实耗时 */
app.use((req, _res, next) => { req._t0 = Date.now(); next(); });
app.use(express.json({ limit: "12mb" }));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const STATIC_DIR = path.resolve(__dirname, "..", "static");

// Health: /healthz is browser-facing; bare /health is reserved by the Guard
// proxy, so health.sh hits 127.0.0.1:3000/health on loopback.
app.get(["/health", "/healthz"], (_req, res) => res.json({ status: "ok" }));

// Module self-check: probes DB / AI and reports per-module status. The demo
// page renders this so you can see at a glance which modules are wired up.
// Status: "ok" (green) | "not_configured" (grey) | "error" (red).
app.get("/api/health/modules", wrap(async (_req, res) => {
  res.json({
    db: await checkDb(),
    ai: checkAi(),
  });
}));

async function checkDb() {
  if (!db.isDbConfigured()) {
    return { status: "not_configured", detail: "无 db.properties；纯无状态应用可忽略" };
  }
  try {
    const pool = db.getPool();
    const m = await pool.query("SELECT count(*) AS n FROM schema_migrations");
    return { status: "ok", detail: `已连接；migrations=${m.rows[0].n}` };
  } catch (e) {
    return { status: "error", detail: `连接/查询失败：${e.code || e.message}` };
  }
}

function checkAi() {
  const textOk = ai.isAiEnabled();
  const imageOk = ai.isImageEnabled();
  if (!textOk && !imageOk) {
    return { status: "not_configured", detail: "无 ai.properties；不调 AI 可忽略" };
  }
  const parts = [];
  if (textOk) parts.push("文本对话已配置");
  if (imageOk) parts.push("图像生成已配置");
  return { status: "ok", detail: parts.join("；") };
}

// ============================================================
// 大家小本 · 业务 API
// ============================================================
const ark = require("./ark");
const rates = require("./rates");
const CURR_SHARED = require("../shared/currencies.json");

/* 币种目录：shared/currencies.json（curated，ISO 4217 小数位）+ ledger_currencies（本账本加入的标准币种/自定义）
   + Frankfurter 目录（运行时合并，提供英文全名/符号与 API 覆盖标记）。所有选择器共用这一份。 */
const COMMON_INIT = CURR_SHARED.common;               // 初始 20 个常用币种（代码序）
const CURR_META = CURR_SHARED.meta;                   // code -> {zh,en,symbol,decimals}
const CODE_RE = /^[A-Z]{3,8}$/;

let ledgerCurrCache = null;   // null=未加载；Map code->row
async function loadLedgerCurrencies(force) {
  if (ledgerCurrCache && !force) return ledgerCurrCache;
  const { rows } = await db.getPool().query("SELECT * FROM ledger_currencies ORDER BY sort, code");
  ledgerCurrCache = new Map(rows.map((r) => [r.code, r]));
  return ledgerCurrCache;
}

/* Frankfurter 目录（24h 缓存；不可达时返回 null）→ 合并后的「全部可搜索币种」 */
let catalogMergedAt = 0;
let catalogMerged = null;
async function getFullCatalog() {
  const apiList = await rates.getCatalog();           // [{code,en,symbol}] | null
  if (catalogMerged && Date.now() - catalogMergedAt < 60000) return catalogMerged;
  const apiCodes = apiList ? new Set(apiList.map((c) => c.code)) : null;
  const out = [];
  const seen = new Set();
  for (const [code, m] of Object.entries(CURR_META)) {
    /* apiSupport 以 Frankfurter 实际覆盖为准（目录不可达时保守为 true，查询失败会如实报错） */
    out.push({ code, zh: m.zh, en: m.en, symbol: m.symbol, decimals: m.decimals, decimalsKnown: true, apiSupport: apiCodes ? apiCodes.has(code) : true });
    seen.add(code);
  }
  if (apiList) {
    for (const c of apiList) {
      if (seen.has(c.code)) continue;
      out.push({ code: c.code, zh: "", en: c.en, symbol: c.symbol, decimals: null, decimalsKnown: false, apiSupport: true });
      seen.add(c.code);
    }
  }
  out.sort((a, b) => a.code.localeCompare(b.code));
  catalogMerged = out;
  catalogMergedAt = Date.now();
  return out;
}

/* 某币种当前可用元数据（ledger 行 > curated）；未知返回 null */
async function metaOf(code) {
  code = String(code || "").trim().toUpperCase();
  const ledger = await loadLedgerCurrencies();
  const row = ledger.get(code);
  if (row) return { code, zh: row.name, en: "", symbol: row.symbol, decimals: row.decimals, decimalsKnown: true, isCustom: row.is_custom };
  const m = CURR_META[code];
  return m ? { code, zh: m.zh, en: m.en, symbol: m.symbol, decimals: m.decimals, decimalsKnown: true, isCustom: false } : null;
}

/* 账目可用币种 = 初始常用 + 本账本加入（含自定义） */
async function isUsableCurrency(code) {
  code = String(code || "").trim().toUpperCase();
  if (COMMON_INIT.includes(code)) return true;
  const ledger = await loadLedgerCurrencies();
  return ledger.has(code);
}

async function usableCurrencies() {
  const ledger = await loadLedgerCurrencies();
  const list = [];
  for (const code of COMMON_INIT) {
    const m = CURR_META[code];
    if (m) list.push({ code, zh: m.zh, en: m.en, symbol: m.symbol, decimals: m.decimals });
  }
  for (const [code, row] of ledger) {
    if (COMMON_INIT.includes(code)) continue;
    list.push({ code, zh: row.name, en: "", symbol: row.symbol, decimals: row.decimals, isCustom: row.is_custom });
  }
  return list;
}

const CATEGORY_IDS = new Set(["groceries", "dining", "transport", "utilities", "daily", "housing", "fun", "other"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/* ---------- 金额：一律整数最小货币单位（小数位按币种元数据：JPY/KRW 0 位、KWD 3 位等） ---------- */
function toMinor(yuan, decimals) {
  const n = Number(yuan);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = Number.isFinite(decimals) ? decimals : 2;
  const minor = Math.round(n * Math.pow(10, d));
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}
function fromMinor(minor, decimals) {
  const d = Number.isFinite(decimals) ? decimals : 2;
  return Number(minor) / Math.pow(10, d);
}

/* ---------- 校验账目守恒：sum(splits) === total ---------- */
function validateSplits(splits, totalMinor) {
  if (!Array.isArray(splits) || !splits.length) return "缺少分摊明细";
  let sum = 0;
  for (const s of splits) {
    if (!s || typeof s.name !== "string" || !s.name.trim()) return "分摊明细缺成员名";
    const m = Number(s.minor);
    if (!Number.isSafeInteger(m) || m < 0) return `成员「${s.name}」分摊金额非法`;
    sum += m;
  }
  if (sum !== totalMinor) return `金额不守恒：分摊合计 ${sum} ≠ 总额 ${totalMinor}`;
  return null;
}

/* ---------- 平分（余数按成员顺序分配） ---------- */
function splitEqual(totalMinor, members) {
  const n = members.length;
  if (!n) return [];
  const base = Math.floor(totalMinor / n);
  const outs = members.map((m, i) => ({ id: m.id, name: m.name, minor: base }));
  let rest = totalMinor - base * n;
  for (let i = 0; rest > 0; i = (i + 1) % n, rest--) outs[i].minor += 1;
  return outs;
}

function rowToEntry(r) {
  return {
    id: r.id, title: r.title, date: r.date, currency: r.currency,
    totalMinor: Number(r.total_minor), payerId: r.payer_id, payerName: r.payer_name,
    splits: r.splits, items: r.items, note: r.note, source: r.source,
    aiConfidence: r.ai_confidence, aiWarnings: r.ai_warnings,
    categoryId: CATEGORY_IDS.has(r.category_id) ? r.category_id : "other",
    fx: r.fx || {},
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

/* ---------- 币种目录 / 添加币种（全站共用一份配置） ---------- */
app.get("/api/currencies", wrap(async (_req, res) => {
  const [ledger, catalog] = await Promise.all([loadLedgerCurrencies(), getFullCatalog()]);
  const added = [...ledger.values()].filter((r) => !r.is_custom);
  const custom = [...ledger.values()].filter((r) => r.is_custom);
  const common = [
    ...COMMON_INIT.map((code) => {
      const m = CURR_META[code];
      return { code, zh: m.zh, en: m.en, symbol: m.symbol, decimals: m.decimals, decimalsKnown: true, apiSupport: true };
    }),
    ...added.map((r) => ({ code: r.code, zh: r.name, en: "", symbol: r.symbol, decimals: r.decimals, decimalsKnown: true, apiSupport: true, added: true })),
    ...custom.map((r) => ({ code: r.code, zh: r.name, en: "", symbol: r.symbol, decimals: r.decimals, decimalsKnown: true, apiSupport: false, custom: true })),
  ];
  res.json({
    common,
    custom: custom.map((r) => ({ code: r.code, name: r.name, symbol: r.symbol, decimals: r.decimals })),
    all: catalog,                     // 可搜索全集（Frankfurter + curated；decimalsKnown=false 需确认）
    defaultCurrency: null,
  });
}));

app.post("/api/currencies", wrap(async (req, res) => {
  const b = req.body || {};
  const code = String(b.code || "").trim().toUpperCase();
  if (!CODE_RE.test(code)) return res.status(400).json({ error: "币种代码需为 3-8 位字母" });
  const ledger = await loadLedgerCurrencies();
  if (ledger.has(code)) return res.status(409).json({ error: "该币种已在常用列表" });
  if (COMMON_INIT.includes(code)) return res.status(409).json({ error: "该币种已在常用列表" });

  const catalog = await getFullCatalog();
  const std = catalog.find((c) => c.code === code);

  if (b.isCustom) {
    /* 自定义币种：不伪装成标准 ISO；无 API 汇率 → 手动 */
    const name = String(b.name || "").trim().slice(0, 24);
    if (!name) return res.status(400).json({ error: "名称必填" });
    const decimals = Number(b.decimals);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 4) return res.status(400).json({ error: "小数位需为 0-4 的整数" });
    const symbol = String(b.symbol || "").trim().slice(0, 8);
    const { rows } = await db.getPool().query(
      "INSERT INTO ledger_currencies (code, name, symbol, decimals, is_custom, sort) VALUES ($1,$2,$3,$4,TRUE,200) RETURNING *",
      [code, name, symbol, decimals]
    );
    await loadLedgerCurrencies(true);
    return res.json({ currency: { code, name, symbol, decimals, isCustom: true, apiSupport: false } });
  }

  if (!std) return res.status(404).json({ error: "标准目录中没有该币种；可用「自定义币种」创建" });
  if (std.decimalsKnown === false && !Number.isInteger(Number(b.decimals))) {
    return res.status(400).json({ error: "该币种的小数位未经元数据确认，需随请求提供 decimals（0-4）" });
  }
  const decimals = std.decimalsKnown ? std.decimals : Math.max(0, Math.min(4, Number(b.decimals)));
  const name = (CURR_META[code] && CURR_META[code].zh) || String(b.name || std.en || code).trim().slice(0, 24);
  const symbol = (CURR_META[code] && CURR_META[code].symbol) || std.symbol || "";
  const { rows } = await db.getPool().query(
    "INSERT INTO ledger_currencies (code, name, symbol, decimals, is_custom, sort) VALUES ($1,$2,$3,$4,FALSE,100) RETURNING *",
    [code, name, symbol, decimals]
  );
  await loadLedgerCurrencies(true);
  return res.json({ currency: { code, name: rows[0].name, symbol: rows[0].symbol, decimals: rows[0].decimals, isCustom: false, apiSupport: true, added: true } });
}));

/* ---------- 参考汇率（Frankfurter；服务端统一调用，只发币种+日期） ---------- */
app.get("/api/rates", wrap(async (req, res) => {
  const from = String(req.query.from || "");
  const to = String(req.query.to || "");
  const date = String(req.query.date || "");
  if (!CODE_RE.test(from.toUpperCase()) || !CODE_RE.test(to.toUpperCase())) {
    return res.status(400).json({ error: "缺少 from/to 币种代码" });
  }
  if (date && !ISO_DATE.test(date)) return res.status(400).json({ error: "日期格式应为 YYYY-MM-DD" });
  /* 自定义币种不打上游（接口必然 422，省一次请求） */
  const ledger = await loadLedgerCurrencies();
  const customFrom = ledger.get(from.toUpperCase());
  const customTo = ledger.get(to.toUpperCase());
  if ((customFrom && customFrom.is_custom) || (customTo && customTo.is_custom)) {
    return res.status(422).json({ error: "自定义币种暂无自动汇率，请手动填写" });
  }
  try {
    const r = await rates.getRate({ from, to, date });
    res.json(r);
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message || "汇率查询失败" });
  }
}));

/* ---------- 把确认后的汇率快照写入账目（用户点「应用到这N笔」才调用） ---------- */
app.post("/api/entries/fx-apply", wrap(async (req, res) => {
  const { target, items } = req.body || {};
  if (!CODE_RE.test(String(target || "").toUpperCase())) return res.status(400).json({ error: "缺少目标币种" });
  if (!Array.isArray(items) || !items.length || items.length > 500) return res.status(400).json({ error: "items 需为非空数组" });
  const pool = db.getPool();
  const now = new Date().toISOString();
  const out = [];
  for (const it of items) {
    const id = Number(it.id);
    const rate = Number(it.rate);
    if (!Number.isSafeInteger(id) || !Number.isFinite(rate) || !(rate > 0)) continue;
    const { rows } = await pool.query("SELECT * FROM entries WHERE id = $1", [id]);
    if (!rows.length) continue;
    const e = rows[0];
    if (e.currency === target.toUpperCase()) continue;             // 同币种汇率恒为 1，无需快照
    const fx = { ...(e.fx || {}) };
    const old = fx[target.toUpperCase()];
    /* API 结果不覆盖已保存的手动汇率（用户显式确认的快照优先） */
    if (old && old.source === "manual" && it.source !== "manual") continue;
    fx[target.toUpperCase()] = {
      from: e.currency,
      rate: String(rate),
      source: it.source === "api" ? "api" : "manual",
      rateDate: ISO_DATE.test(String(it.rateDate || "")) ? String(it.rateDate) : null,
      fetchedAt: now,
    };
    const { rows: up } = await pool.query("UPDATE entries SET fx = $1::jsonb, updated_at = now() WHERE id = $2 RETURNING *", [JSON.stringify(fx), id]);
    out.push(rowToEntry(up[0]));
  }
  res.json({ applied: out.length, entries: out });
}));

/* ---------- 身份 ---------- */
app.get("/api/profile", wrap(async (_req, res) => {
  const { rows } = await db.getPool().query("SELECT * FROM profile WHERE id = 1");
  res.json({ profile: rows[0] || null });
}));

app.put("/api/profile", wrap(async (req, res) => {
  const { nickname, avatar, currency } = req.body || {};
  const name = String(nickname || "").trim().slice(0, 20);
  if (!name) return res.status(400).json({ error: "昵称不能为空" });
  const av = typeof avatar === "string" && avatar.startsWith("data:image/") && avatar.length < 600000 ? avatar : null;
  const cur = (typeof currency === "string" && await isUsableCurrency(currency)) ? currency.trim().toUpperCase() : "CNY";
  const pool = db.getPool();
  await pool.query(
    `INSERT INTO profile (id, nickname, avatar, default_currency) VALUES (1, $1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET nickname = $1, avatar = COALESCE($2, profile.avatar), default_currency = $3, updated_at = now()`,
    [name, av, cur]
  );
  const existingSelf = await pool.query('SELECT id FROM members WHERE is_self LIMIT 1');
  if(existingSelf.rows.length) {
    await pool.query('UPDATE members SET name=$1, avatar=COALESCE($2,avatar) WHERE id=$3',[name,av,existingSelf.rows[0].id]);
    const {rows}=await pool.query('SELECT * FROM profile WHERE id=1');return res.json({profile:rows[0]});
  }
  // 同步成员表里的「我」
  await pool.query(
    `INSERT INTO members (name, avatar, is_self) VALUES ($1, $2, TRUE)
     ON CONFLICT (name) DO UPDATE SET avatar = COALESCE($2, members.avatar), is_self = TRUE, active = TRUE`,
    [name, av]
  );
  const { rows } = await pool.query("SELECT * FROM profile WHERE id = 1");
  res.json({ profile: rows[0] });
}));

/* ---------- 默认记账币种（AI 未写币种时的回退；须在启用币种内） ---------- */
app.post("/api/profile/currency", wrap(async (req, res) => {
  const cur = String((req.body || {}).currency || "").trim().toUpperCase();
  if (!await isUsableCurrency(cur)) return res.status(400).json({ error: "币种未在本账本启用" });
  const pool = db.getPool();
  const { rows } = await pool.query(
    "UPDATE profile SET default_currency = $1, updated_at = now() WHERE id = 1 RETURNING default_currency", [cur]
  );
  res.json({ defaultCurrency: rows[0] ? rows[0].default_currency : cur });
}));

/* ---------- 成员 ---------- */
app.get("/api/members", wrap(async (_req, res) => {
  const { rows } = await db.getPool().query("SELECT * FROM members ORDER BY is_self DESC, id");
  res.json({ members: rows });
}));

app.post("/api/members", wrap(async (req, res) => {
  const name = String((req.body || {}).name || "").trim().slice(0, 20);
  if (!name) return res.status(400).json({ error: "成员名不能为空" });
  try {
    const { rows } = await db.getPool().query(
      "INSERT INTO members (name,avatar) VALUES ($1,$2) RETURNING *", [name, typeof req.body.avatar === "string" && req.body.avatar.startsWith("data:image/") && req.body.avatar.length<600000 ? req.body.avatar : null]
    );
    res.json({ member: rows[0] });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "成员已存在" });
    throw e;
  }
}));

app.patch("/api/members/:id", wrap(async (req, res) => {
  const id = Number(req.params.id);
  const { name, active, avatar } = req.body || {};
  const pool = db.getPool();
  const { rows } = await pool.query("SELECT * FROM members WHERE id = $1", [id]);
  if (!rows.length) return res.status(404).json({ error: "成员不存在" });
  const m = rows[0];
  if (m.is_self && active === false) return res.status(400).json({ error: "不能停用自己" });
  const newName = typeof name === "string" && name.trim() ? name.trim().slice(0, 20) : m.name;
  const newActive = typeof active === "boolean" ? active : m.active;
  const newAvatar = (typeof avatar === "string" && avatar.startsWith("data:image/") && avatar.length < 600000)
    ? avatar : m.avatar;
  try {
    const { rows: up } = await pool.query(
      "UPDATE members SET name = $1, active = $2, avatar = $3 WHERE id = $4 RETURNING *",
      [newName, newActive, newAvatar, id]
    );
    // 当前登录者改名/换头像：同步 profile（身份一致性；历史账目快照不受影响）
    if (m.is_self) {
      await pool.query(
        "UPDATE profile SET nickname = $1, avatar = $2, updated_at = now() WHERE id = 1",
        [newName, newAvatar]
      );
    }
    res.json({ member: up[0] });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "该名字已被占用" });
    throw e;
  }
}));

/* ---------- AI 解析（草稿，不入账） ---------- */
app.post("/api/ai/parse", wrap(async (req, res) => {
  const { text, imageBase64, mime } = req.body || {};
  if (!text && !imageBase64) return res.status(400).json({ error: "需要文字描述或票据图片" });
  if (imageBase64 && !/^[A-Za-z0-9+/=]+$/.test(String(imageBase64).slice(0, 100))) {
    return res.status(400).json({ error: "图片数据必须是 base64" });
  }
  // 上下文每次实时读库（成员增改后立刻生效，无缓存）
  const pool = db.getPool();
  const [{ rows: pRows }, { rows: mRows }, usable, catalog] = await Promise.all([
    pool.query("SELECT nickname, default_currency FROM profile WHERE id = 1"),
    pool.query("SELECT id, name, active, is_self, aliases FROM members WHERE active"),
    usableCurrencies(),
    getFullCatalog(),
  ]);
  const self = mRows.find((m) => m.is_self) || null;
  const defaultCurrency = (pRows[0] && await isUsableCurrency(pRows[0].default_currency)) ? pRows[0].default_currency : "CNY";
  const catalogCodes = new Set(catalog.map((c) => c.code));
  const ledger = await loadLedgerCurrencies();
  for (const [code] of ledger) catalogCodes.add(code);   // 自定义币种也算「已知」
  const decimalsOf = (code) => {
    const u = usable.find((x) => x.code === code);
    if (u) return u.decimals;
    const c = catalog.find((x) => x.code === code);
    return c && Number.isFinite(c.decimals) ? c.decimals : null;
  };
  const ctx = {
    currentDate: ark.todayHK(),
    timezone: "Asia/Hong_Kong",
    defaultCurrency,
    currentUser: self ? { id: self.id, name: self.name } : null,
    members: mRows.map((m) => ({ id: m.id, name: m.name, aliases: m.aliases || [] })),
    usableCurrencies: usable,
    catalogCodes,
    decimalsOf,
  };
  /* 客户端断开（取消/超时）→ 立即中止上游模型请求，避免后台重复占用 */
  const abort = new AbortController();
  const onClose = () => abort.abort("client");
  res.on("close", onClose);
  const tReq = Date.now();
  const result = await ark.parseReceipt({ text, imageBase64, mime, ctx, signal: abort.signal });
  const uploadMs = tReq - (req._t0 || tReq); // 上传段：请求到达 → 进入处理（含 body 解析）
  res.off("close", onClose);
  const kind = imageBase64 ? "receipt" : "text";
  console.log(`[ai] kind=${kind} uploadMs=${uploadMs} modelMs=${result.timing?.modelMs ?? "?"} parseMs=${result.timing?.parseMs ?? "?"} status=${result.status}`);
  if (!result.ok) {
    if (result.status === "cancelled") return res.status(499).json({ status: "cancelled", message: result.message });
    return res.status(502).json({ status: result.status, message: result.message });
  }
  /* AI 识别出未加入常用列表的标准币种（如 THB）→ 自动加入，全站选择器立即可用 */
  let currencyAdded = false;
  const dcode = result.draft && result.draft.currency;
  if (dcode && !await isUsableCurrency(dcode)) {
    const std = catalog.find((c) => c.code === dcode);
    if (std && std.decimalsKnown) {
      const name = (CURR_META[dcode] && CURR_META[dcode].zh) || std.en || dcode;
      const symbol = (CURR_META[dcode] && CURR_META[dcode].symbol) || std.symbol || "";
      try {
        await pool.query(
          "INSERT INTO ledger_currencies (code, name, symbol, decimals, is_custom, sort) VALUES ($1,$2,$3,$4,FALSE,100) ON CONFLICT (code) DO NOTHING",
          [dcode, name, symbol, std.decimals]
        );
        await loadLedgerCurrencies(true);
        currencyAdded = true;
      } catch { /* 并发重复插入：忽略 */ }
    }
  }
  const draft = result.draft;
  const createdMembers = [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE members IN SHARE ROW EXCLUSIVE MODE');
    const {rows: known} = await client.query('SELECT * FROM members');
    const norm = s => String(s || '').replace(/\s+/g,'').toLowerCase();
    async function ensure(name, id) {
      if (id) return known.find(m => String(m.id) === String(id));
      if (!name || /^(朋友|同事|家人|大家|我们|某人|其他人)$/.test(name)) {draft.warnings.push('有未明确姓名的参与人，请补充后入账');return null;}
      let m = known.find(m => norm(m.name) === norm(name) || (m.aliases || []).some(a => norm(a) === norm(name)));
      if (m && !m.active) return null;
      if (!m) { const r = await client.query('INSERT INTO members(name) VALUES($1) RETURNING *',[name.slice(0,30)]); m=r.rows[0]; known.push(m); createdMembers.push(m.name); }
      return m;
    }
    const payer = await ensure(draft.payerName,draft.payerId);
    if (payer) { draft.payerId=payer.id; draft.payerName=payer.name; }
    for (const person of draft.participants || []) { const m=await ensure(person.name,person.id); if(m) {person.id=m.id;person.name=m.name;} }
    draft.participants=(draft.participants || []).filter(x=>x.id);
    draft.splitSuggestion=splitEqual(draft.totalMinor || 0,draft.participants);
    if(draft.explicitSplits) {
      const exact=draft.explicitSplits.map(s=>{const m=known.find(m=>norm(m.name)===norm(s.name)||(m.aliases||[]).some(a=>norm(a)===norm(s.name)));return {...s,id:m?.id,name:m?.name||s.name};});
      if(exact.every(s=>s.id) && new Set(exact.map(s=>String(s.id))).size===exact.length && exact.reduce((a,s)=>a+s.minor,0)===draft.totalMinor) {draft.splitSuggestion=exact;draft.participants=exact.map(({id,name})=>({id,name}));}
      else draft.warnings.push('自定义分摊人员未完全匹配，请核对');
    }
    draft.warnings=(draft.warnings || []).filter(w=>!w.startsWith('将新增成员'));
    await client.query('COMMIT');
  } catch(e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  res.json({ status: "ok", draft: { ...draft, currencyAdded, createdMembers, requestId:require('crypto').randomUUID() }, timing: result.timing });
}));



app.get("/api/ai/status", (_req, res) => res.json(ark.arkStatus()));

app.get('/api/repayments',wrap(async(req,res)=>{const {rows}=await db.getPool().query('SELECT * FROM repayments ORDER BY id DESC');res.json({repayments:rows});}));
app.post('/api/repayments',wrap(async(req,res)=>{
 const b=req.body;
 if(!Number.isSafeInteger(Number(b.minor))||Number(b.minor)<=0||String(b.fromId)===String(b.toId)||!ISO_DATE.test(b.date||'')||!await isUsableCurrency(b.currency)) return res.status(400).json({error:'转账信息不完整'});
 const {rows}=await db.getPool().query('INSERT INTO repayments(from_id,to_id,currency,minor,date,request_id) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(request_id) DO UPDATE SET request_id=EXCLUDED.request_id RETURNING *',[b.fromId,b.toId,b.currency,b.minor,b.date,b.requestId||null]);res.json({repayment:rows[0]});
}));
app.delete('/api/repayments/:id',wrap(async(req,res)=>{await db.getPool().query('DELETE FROM repayments WHERE id=$1',[req.params.id]);res.json({ok:true});}));
/* ---------- 账目 ---------- */
app.get("/api/entries", wrap(async (req, res) => {
  const month = String(req.query.month || ""); // YYYY-MM 可选
  const pool = db.getPool();
  let q = "SELECT * FROM entries", params = [];
  if (/^\d{4}-\d{2}$/.test(month)) {
    q += " WHERE date LIKE $1"; params.push(month + "%");
  }
  q += " ORDER BY date DESC, id DESC";
  const { rows } = await pool.query(q, params);
  res.json({ entries: rows.map(rowToEntry) });
}));

async function validateEntryBody(b) {
  if (!b || typeof b !== "object") return { error: "请求体非法" };
  if (!b.title || !String(b.title).trim()) return { error: "标题不能为空" };
  if (!ISO_DATE.test(String(b.date || ""))) return { error: "日期格式应为 YYYY-MM-DD" };
  if (!(await isUsableCurrency(b.currency))) return { error: `币种 ${b.currency} 未在本账本启用（先在选择器中加入常用列表）` };
  const totalMinor = Number(b.totalMinor);
  if (!Number.isSafeInteger(totalMinor) || totalMinor <= 0) return { error: "总额必须为正整数（最小货币单位）" };
  if (!b.payerName || !String(b.payerName).trim()) return { error: "付款人不能为空" };
  if (b.fx != null) {
    if (typeof b.fx !== 'object' || Array.isArray(b.fx)) return {error:'汇率格式不正确'};
    for (const [target,snap] of Object.entries(b.fx)) {
      if (!CODE_RE.test(target) || !snap || !/^\d+(\.\d+)?$/.test(String(snap.rate)) || !Number.isFinite(Number(snap.rate)) || Number(snap.rate)<=0 || snap.from!==b.currency) return {error:'汇率必须为有效正数，且匹配原币种'};
    }
  }
  const {rows:validMembers} = await db.getPool().query('SELECT id FROM members');
  const ids = new Set(validMembers.map(m=>String(m.id)));
  if(!ids.has(String(b.payerId))) return {error:'付款人不存在，请重新选择'};
  if(!Array.isArray(b.splits) || b.splits.some(s=>!ids.has(String(s.id))) || new Set(b.splits.map(s=>String(s.id))).size!==b.splits.length) return {error:'参与人不存在或重复，请重新选择'};
  const spErr = validateSplits(b.splits, totalMinor);
  if (spErr) return { error: spErr };
  if (b.categoryId != null && !CATEGORY_IDS.has(b.categoryId)) {
    return { error: "categoryId 必须是有效分类之一" };
  }
  return null;
}

app.post("/api/entries", wrap(async (req, res) => {
  const err = await validateEntryBody(req.body);
  if (err) return res.status(400).json({ error: err.error });
  const b = req.body;
  if (b.requestId) { const prior = await db.getPool().query("SELECT * FROM entries WHERE request_id=$1",[b.requestId]); if(prior.rows.length) return res.json({entry:rowToEntry(prior.rows[0])}); }
  const splits = b.splits.map((s) => ({
    id: Number(s.id) || null,
    name: String(s.name).trim().slice(0, 30),
    minor: Number(s.minor),
  }));
  const items = Array.isArray(b.items) ? b.items.slice(0, 30) : null;
  const { rows } = await db.getPool().query(
    `INSERT INTO entries (title, date, currency, total_minor, payer_id, payer_name, splits, items, note, source, ai_confidence, ai_warnings, category_id, fx, request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12::jsonb,$13,$14::jsonb,$15) ON CONFLICT(request_id) DO UPDATE SET request_id=EXCLUDED.request_id RETURNING *`,
    [b.title.trim().slice(0, 80), b.date, b.currency, b.totalMinor,
     Number(b.payerId) || null, String(b.payerName).trim().slice(0, 30),
     JSON.stringify(splits), items ? JSON.stringify(items) : null,
     b.note ? String(b.note).slice(0, 300) : null,
     b.source === "ai" ? "ai" : "manual",
     typeof b.aiConfidence === "number" ? b.aiConfidence : null,
     Array.isArray(b.aiWarnings) ? JSON.stringify(b.aiWarnings.map(String).slice(0, 8)) : null,
     CATEGORY_IDS.has(b.categoryId) ? b.categoryId : "other", JSON.stringify(b.fx || {}), b.requestId || null]
  );
  res.json({ entry: rowToEntry(rows[0]) });
}));

app.patch("/api/entries/:id", wrap(async (req, res) => {
  const id = Number(req.params.id);
  const { rows: old } = await db.getPool().query("SELECT * FROM entries WHERE id = $1", [id]);
  if (!old.length) return res.status(404).json({ error: "账目不存在" });
  const merged = { ...rowToEntry(old[0]), ...req.body };
  const err = await validateEntryBody(merged);
  if (err) return res.status(400).json({ error: err.error });
  const splits = merged.splits.map((s) => ({
    id: Number(s.id) || null, name: String(s.name).trim().slice(0, 30), minor: Number(s.minor),
  }));
  /* 币种变化 → 旧折算快照失效（from 不符），清空待重新折算 */
  const fxReset = merged.currency !== old[0].currency || merged.date !== old[0].date;
  const { rows } = await db.getPool().query(
    `UPDATE entries SET title=$1, date=$2, currency=$3, total_minor=$4, payer_id=$5, payer_name=$6,
       splits=$7::jsonb, items=$8::jsonb, note=$9, category_id=$10,
       fx=$12::jsonb, updated_at=now() WHERE id=$11 RETURNING *`,
    [merged.title.trim().slice(0, 80), merged.date, merged.currency, merged.totalMinor,
     Number(merged.payerId) || null, String(merged.payerName).trim().slice(0, 30),
     JSON.stringify(splits), merged.items ? JSON.stringify(merged.items) : null,
     merged.note ? String(merged.note).slice(0, 300) : null,
     CATEGORY_IDS.has(merged.categoryId) ? merged.categoryId : "other", id, JSON.stringify(req.body.fx || (fxReset ? {} : old[0].fx))]
  );
  res.json({ entry: rowToEntry(rows[0]) });
}));

app.delete("/api/entries/:id", wrap(async (req, res) => {
  const { rowCount } = await db.getPool().query("DELETE FROM entries WHERE id = $1", [Number(req.params.id)]);
  if (!rowCount) return res.status(404).json({ error: "账目不存在" });
  res.json({ ok: true });
}));

app.post("/api/entries/undo-latest", wrap(async (_req, res) => {
  const { rows } = await db.getPool().query(
    "DELETE FROM entries WHERE id = (SELECT id FROM entries ORDER BY created_at DESC, id DESC LIMIT 1) RETURNING *"
  );
  if (!rows.length) return res.status(404).json({ error: "没有可撤销的账目" });
  res.json({ ok: true, undone: rowToEntry(rows[0]) });
}));


// 统一错误兜底：业务异常 → 500 JSON，绝不让进程崩溃
app.use((err, _req, res, _next) => {
  console.error("[api-error]", err && (err.code || err.message));
  res.status(err.status || 500).json({ error: err.status ? err.message : "服务器内部错误，请稍后重试" });
});

// Static frontend — mounted directly AFTER all /api routes. Never use
// app.use('*', express.static(...)): that strips the path and 301-loops assets.
// 书本 iframe 资源 + SPA 入口强制协商缓存：浏览器/代理必须回源校验，杜绝旧 app.js 卡在用户端
app.use(
  (req, res, next) => {
    const p = req.path;
    if (p === "/" || p === "/index.html" || p.startsWith("/book/")) {
      res.set("Cache-Control", "no-cache, must-revalidate");
    }
    next();
  },
  express.static(STATIC_DIR, { index: "index.html" })
);

const PORT = parseInt(process.env.PORT || process.env.APP_PORT || "3030", 10);
const HOST = process.env.APP_HOSTNAME || "0.0.0.0";
db.migrate().then(() => app.listen(PORT, HOST, () => console.log(`listening on ${HOST}:${PORT}`))).catch(e => { console.error("Database startup failed:",e.message); process.exit(1); });
