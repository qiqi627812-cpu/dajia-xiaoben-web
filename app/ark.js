// ark.js — 火山方舟（豆包）服务端客户端
// 约束：
//   - API Key 只从环境变量 ARK_API_KEY 读取；绝不写入前端、源码产物或日志
//   - 模型由 ARK_MODEL 环境变量配置（支持视觉的豆包模型），不写死过期模型名
//   - Base URL 可由 ARK_BASE_URL 覆盖（默认方舟华北 OpenAI 兼容端点）
// 未配置 / 调用失败 / 响应不合法时返回结构化错误，绝不伪造识别结果。
//
// 上下文解析（服务端兜底，不依赖模型自觉）：
//   - 相对日期（今天/昨天/前天/大前天）按 currentDate 计算
//   - 未说明币种 → defaultCurrency，不返回 null
//   - 「我/本人/自己」→ currentUser
//   - 成员匹配忽略空格与大小写（含别名）
//   - 陌生名字才进 warnings，已存在成员不误报

const DEFAULT_BASE = "https://ark.cn-beijing.volces.com/api/v3";
const TIMEZONE = "Asia/Hong_Kong";
const SELF_WORDS = new Set(["我", "本人", "自己", "我本人", "me", "当前用户"]);

/* 分类（与 web/src/api.js / app/server.js 同一份清单；模型输出映射到有效值，非法回退 other） */
const CATEGORY_IDS = new Set(["groceries", "dining", "transport", "utilities", "daily", "housing", "fun", "other"]);
const CATEGORY_LABELS = {
  groceries: "买菜", dining: "餐饮", transport: "交通", utilities: "水电",
  daily: "日用", housing: "住宿", fun: "娱乐", other: "其他",
};

function arkConfig() {
  let apiKey = process.env.ARK_API_KEY || "";
  let model = process.env.ARK_MODEL || "";
  // 兜底：看护直接 `node app/server.js` 拉起时没有经过 start.sh 的 env 注入。
  // 双落点读取：/run/ark.env（tmpfs，随容器重建丢失）+ /workspace/.secrets/ark.env
  // （持久卷，工程目录外，0600，不进 zip/发布包/静态目录）。key 依然不进源码/产物/日志。
  if (!apiKey || !model) {
    try {
      const fs = require("fs");
      for (const p of ["/run/ark.env", "/workspace/.secrets/ark.env"]) {
        let env;
        try { env = fs.readFileSync(p, "utf8"); } catch { continue; }
        for (const line of env.split("\n")) {
          const m = line.match(/^(ARK_API_KEY|ARK_MODEL)=(.*)$/);
          if (!m) continue;
          if (m[1] === "ARK_API_KEY" && !apiKey) apiKey = m[2].trim();
          if (m[1] === "ARK_MODEL" && !model) model = m[2].trim();
        }
      }
    } catch { /* 双落点都不存在则忽略 */ }
  }
  const baseUrl = (process.env.ARK_BASE_URL || DEFAULT_BASE).replace(/\/+$/, "");
  return { apiKey, model, baseUrl, configured: Boolean(apiKey && model) };
}

function arkStatus() {
  const { configured, model } = arkConfig();
  return { configured, model: configured ? model : null, provider: "volcengine-ark" };
}

/* 当前日期（Asia/Hong_Kong），服务端唯一真源 */
function todayHK() {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: TIMEZONE }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function addDays(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/* 名字归一：去空白 + 小写 */
function norm(s) {
  return String(s || "").replace(/\s+/g, "").toLowerCase();
}

/* 成员解析：「我」→ currentUser；否则按 昵称/别名 归一匹配 */
function resolveMember(name, ctx) {
  if (!name) return null;
  const n = norm(name);
  if (SELF_WORDS.has(n)) return ctx.currentUser || null;
  for (const m of ctx.members) {
    if (norm(m.name) === n) return m;
    for (const a of m.aliases || []) {
      if (norm(a) === n) return m;
    }
  }
  return null;
}

/* 相对日期兜底：模型没给出日期时，从原文里的 今天/昨天/前天/大前天 换算 */
function resolveRelativeDate(text, currentDate) {
  if (!text || !currentDate) return null;
  for (const [w, off] of [["大前天", 3], ["前天", 2], ["昨天", 1], ["今天", 0]]) {
    if (text.includes(w)) return addDays(currentDate, -off);
  }
  return null;
}

/* 平分（与业务侧同规则）：余数按成员顺序分配，保证守恒 */
function splitEqualMinor(totalMinor, members) {
  const n = members.length;
  if (!n || !Number.isFinite(totalMinor)) return [];
  const base = Math.floor(totalMinor / n);
  const outs = members.map((m) => ({ id: m.id, name: m.name, minor: base }));
  let rest = totalMinor - base * n;
  for (let i = 0; rest > 0; i = (i + 1) % n, rest--) outs[i].minor += 1;
  return outs;
}

/* —— 从模型输出提取严格 JSON（容忍 ```json 围栏）—— */
function extractJson(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

/* 金额面值 → 整数最小货币单位（小数位由 ctx.decimals 提供：JPY/KRW 0 位、KWD 3 位等） */
function toMinor(amount, decimals) {
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = Number.isFinite(decimals) ? Math.max(0, Math.min(4, decimals)) : 2;
  const minor = Math.round(n * Math.pow(10, d));
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}

const SYSTEM_PROMPT = `你是共享账本的记账解析助手。从用户的文字描述或票据图片中提取账目信息，输出严格的 JSON（不要输出任何其他文字）。
JSON 字段：
- title: 简短标题（如「火锅晚餐」）
- date: YYYY-MM-DD
- currency: 币种 ISO 4217 三字母代码（如 CNY/HKD/USD/JPY/THB/TWD/EUR）。判定规则：
  * 仅凭「$」不能认定 USD（可能是 HKD/TWD/SGD/AUD 等），仅凭「¥」需结合国家/文字/账本默认币种判断（CNY 或 JPY）；
  * 无法确定时 currency 填 null，同时给出 currencyText（用户原文里的币种文字）并在 warnings 说明；
  * 用户完全没提币种时 currency 填 null（不要猜），由系统按账本默认币种处理。
- currencyText: 用户原文中的币种文字（如「泰铢」「美金」「$」）；无法确定代码或原文有币种但不确定代码时给出
- total: 总金额（数字，原币面值，不要换算、不要做汇率折算）
- payerName: 付款人姓名
- participants: 参与分摊的人名数组
- splits: 若用户指定不均等分摊，计算每个人最终承担金额，输出 [{name, amount}]，金额为原币面值且合计等于 total；均摊时填 null。单独消费先分配给指定成员，剩余金额再按指定人员均摊。
- fx: 仅当用户文字/票据明确写了兑换汇率时填 {"rate": 数字, "quote": 目标币 ISO 代码}；否则填 null。市场汇率由系统提供，禁止编造或估算汇率。
- items: [{name, price, qty}]（票据可见明细行时才填）
- category: 分类，必须是以下 categoryId 之一：groceries(买菜)/dining(餐饮)/transport(交通)/utilities(水电)/daily(日用)/housing(住宿)/fun(娱乐)/other(其他)
- confidence: 0-1 的置信度
- warnings: 字符串数组，列出无法确定或存疑的字段
规则：
- 无法确定的字段一律填 null，并把原因写进 warnings；禁止猜测或编造。
- 人名必须原样出现，禁止改写、合并或发明新名字。
- 金额以票据/描述的原始数字为准。`;

/* 账本上下文注入（每次请求实时读取，不缓存） */
function buildContextPrompt(ctx) {
  const lines = [
    "",
    "===== 账本上下文（服务端实时提供） =====",
    `当前日期：${ctx.currentDate}（时区 ${ctx.timezone}）`,
    `账本默认币种：${ctx.defaultCurrency}`,
  ];
  if (ctx.currentUser) {
    lines.push(`当前用户（说话的「我」）：id=${ctx.currentUser.id}，昵称「${ctx.currentUser.name}」`);
  } else {
    lines.push("当前用户：未设置");
  }
  if (ctx.members.length) {
    lines.push("账本有效成员列表（id / 昵称 / 别名）：");
    for (const m of ctx.members) {
      const alias = (m.aliases || []).length ? `，别名：${m.aliases.map((a) => `「${a}」`).join("")}` : "";
      lines.push(`- id=${m.id}，昵称「${m.name}」${alias}`);
    }
  } else {
    lines.push("账本有效成员列表：空");
  }
  if (ctx.usableCurrencies && ctx.usableCurrencies.length) {
    lines.push(`账本已启用币种（代码/名称/小数位）：${ctx.usableCurrencies.map((c) => `${c.code}(${c.zh || c.en || c.code},${c.decimals}位)`).join("、")}`);
  }
  lines.push(
    "===== 上下文规则 =====",
    "- 相对日期（今天/昨天/前天/上周X 等）必须基于上面的「当前日期」换算成具体 YYYY-MM-DD。",
    "- 「我/本人/自己」指当前用户，payerName 和 participants 里直接写当前用户的昵称。",
    "- 用户未说明币种时，currency 输出 null（系统会按账本默认币种处理，不要代填）。",
    "- 币种能确定时输出标准 ISO 4217 代码（不限于已启用币种，如泰铢 THB、新加坡元 SGD）。",
    "- 人名优先使用成员列表里的昵称原样（含别名）；列表外的人名原样输出，不要编造。",
    "- 用户明确写了兑换汇率（如「按0.9折算」）才填 fx；市场汇率由系统查询，禁止编造。"
  );
  return lines.join("\n");
}

/* 草稿规整：id 解析 + 兜底（币种/日期/我）+ 平分建议 */
function sanitizeDraft(d, ctx, text) {
  if (!d || typeof d !== "object") return null;
  const warnings = Array.isArray(d.warnings) ? d.warnings.map(String).slice(0, 8) : [];

  // 标题
  const title = typeof d.title === "string" && d.title.trim() ? d.title.trim().slice(0, 80) : null;

  // 分类：映射到有效 categoryId；模型未给出或非法 → other（不警告，属合理默认）
  const categoryId = CATEGORY_IDS.has(d.category) ? d.category : "other";

  // 币种：AI 输出 ISO 代码 → 校验已知目录（curated + Frankfurter + 自定义）；
  // 校验不过/未输出 → 保留 currencyText 原文请用户确认（不丢、不改、不编）；
  // 完全没提币种 → 按账本默认币种并在 warnings 说明。
  const NON_CURRENCY_WORDS = new Set(["块", "块钱", "元", "蚊", "蚊纸", "块钱儿", "蚊仔", "文", "把钱"]); // 量词，非币种
  const catalogCodes = ctx.catalogCodes || new Set();
  let code = typeof d.currency === "string" ? d.currency.trim().toUpperCase() : "";
  if (code && !catalogCodes.has(code)) code = "";
  let currencyText = typeof d.currencyText === "string" ? d.currencyText.trim().slice(0, 20) : null;
  if (currencyText && NON_CURRENCY_WORDS.has(currencyText)) currencyText = null;   // 「35块」= 没写币种
  let currency = code || null;
  let usedDefault = false;
  if (!currency && !currencyText && ctx.defaultCurrency && catalogCodes.has(ctx.defaultCurrency)) {
    currency = ctx.defaultCurrency;   // 完全没提币种 → 按默认并明示
    usedDefault = true;
  }
  const dec = currency && ctx.decimalsOf ? ctx.decimalsOf(currency) : null;

  // 日期：模型给出合法日期用之；否则按原文相对词兜底
  let date = typeof d.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.date) ? d.date : null;
  if (!date) date = resolveRelativeDate(text, ctx.currentDate);

  // 总额：面值 + 按币种小数位换最小单位（小数位未知 → 只给面值，让用户选币种后前端换算）
  let totalMinor = null;
  let totalYuan = null;
  if (Number.isFinite(Number(d.total)) && Number(d.total) > 0) {
    totalYuan = Number(d.total);
    if (dec != null) totalMinor = toMinor(totalYuan, dec);
  } else if (Number.isFinite(Number(d.totalMinor))) {
    const n = Number(d.totalMinor);
    if (Number.isSafeInteger(n) && n > 0) totalMinor = n;   // 兼容旧模型输出
  }

  // 用户文字/票据明确提供的兑换信息（仅原文明示时才可信）
  let fx = null;
  if (d.fx && Number(d.fx.rate) > 0 && typeof d.fx.quote === "string") {
    const quote = d.fx.quote.trim().toUpperCase();
    if (catalogCodes.has(quote)) fx = { rate: Number(d.fx.rate), quote };
  }

  // 付款人 → id
  let payerId = null;
  let payerName = null;
  const payerRaw = typeof d.payerName === "string" ? d.payerName.trim() : "";
  if (payerRaw) {
    const m = resolveMember(payerRaw, ctx);
    if (m) { payerId = m.id; payerName = m.name; }
    else { payerName = payerRaw.slice(0, 30); warnings.push(`将新增成员「${payerName}」`); }
  }

  // 参与人 → id 列表
  const participants = [];
  if (Array.isArray(d.participants)) {
    for (const p of d.participants) {
      const name = typeof p === "string" ? p.trim() : (p && typeof p.name === "string" ? p.name.trim() : "");
      if (!name) continue;
      const m = resolveMember(name, ctx);
      if (m) {
        if (!participants.some((x) => String(x.id) === String(m.id))) participants.push({ id: m.id, name: m.name });
      } else {
        participants.push({id:null,name});
        warnings.push(`将新增成员「${name}」`);
      }
    }
  }

  // 明细行
  const items = [];
  if (Array.isArray(d.items)) {
    for (const it of d.items) {
      if (!it || typeof it.name !== "string" || !it.name.trim()) continue;
      const item = { name: it.name.trim().slice(0, 40), minor: null };
      if (Number.isFinite(Number(it.minor))) item.minor = Math.max(0, Math.round(Number(it.minor)));
      else if (Number.isFinite(Number(it.price)) && dec != null) item.minor = toMinor(it.price, dec) || 0;
      if (Number.isFinite(Number(it.qty)) && it.qty > 1) item.qty = Math.round(it.qty);
      items.push(item);
    }
  }

  // 平分建议（服务端计算，守恒）
  let splitSuggestion = totalMinor && participants.length
    ? splitEqualMinor(totalMinor, participants)
    : [];

  let explicitSplits = null;
  if (Array.isArray(d.splits) && d.splits.length) {
    const candidates=d.splits.map(s=>({name:s.name,minor:Number(s.amount)===0?0:toMinor(s.amount,dec)}));
    if(candidates.every(s=>s.name && s.minor!=null) && candidates.reduce((a,s)=>a+s.minor,0)===totalMinor) explicitSplits=candidates;
    else warnings.push('自定义分摊金额不完整，请核对每人承担金额');
  }
  // 只对仍然缺失的关键字段警告（币种已兜底，不再误报）
  if (!title) warnings.push("未能识别标题");
  if (!date) warnings.push("未能识别日期");
  if (!totalMinor && !totalYuan) warnings.push("未能识别总额");
  if (!payerName) warnings.push("未能识别付款人");
  if (!code && currencyText) warnings.push(`币种未能确定（原文「${currencyText}」），请确认`);
  if (usedDefault) warnings.push(`未写币种，按账本默认币种 ${currency} 处理`);

  return {
    title, date, currency, currencyText, totalMinor, totalYuan, fx,
    payerId, payerName,
    participants,
    explicitSplits,
    categoryId,
    items,
    confidence: typeof d.confidence === "number" ? Math.max(0, Math.min(1, d.confidence)) : null,
    warnings,
    splitSuggestion,
  };
}

async function parseReceipt({ text, imageBase64, mime, ctx, signal }) {
  const { apiKey, model, baseUrl, configured } = arkConfig();
  if (!configured) {
    return { ok: false, status: "not_configured", message: "AI 未配置（缺少 ARK_API_KEY 或 ARK_MODEL 环境变量）" };
  }

  const content = [];
  if (text && text.trim()) content.push({ type: "text", text: text.trim().slice(0, 2000) });
  if (imageBase64) {
    content.push({
      type: "image_url",
      image_url: { url: `data:${mime || "image/png"};base64,${imageBase64}` },
    });
  }
  if (!content.length) {
    return { ok: false, status: "bad_request", message: "需要文字描述或票据图片" };
  }
  content.push({ type: "text", text: "请解析以上账目信息，只输出 JSON。" });

  /* 计时：模型等待 vs JSON 解析分开测量；外部（客户端断开）可取消 */
  const t0 = Date.now();
  let modelMs = null;
  let parseMs = null;
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort("client");
  if (signal) {
    if (signal.aborted) return { ok: false, status: "cancelled", message: "请求已取消" };
    signal.addEventListener("abort", onExternalAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort("timeout"), 25000);

  let resp;
  try {
    resp = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT + buildContextPrompt(ctx) },
          { role: "user", content },
        ],
        temperature: 0.1,
        max_tokens: 800,
        /* 关闭长思考：记账解析要快，不需要推理链（豆包 seed 系列支持显式关闭） */
        thinking: { type: "disabled" },
      }),
    });
  } catch (e) {
    const reason = String(typeof e === "string" ? e : (e?.message || e?.name || ""));
    const isTimeout = /timeout|25s|AbortError/i.test(reason) && reason.includes("timeout");
    const isCancel = reason.includes("client") || reason.includes("cancel");
    return {
      ok: false,
      status: isTimeout ? "timeout" : (isCancel ? "cancelled" : "error"),
      message: isTimeout ? "AI 请求超时（25s）" : (isCancel ? "请求已取消" : `AI 请求失败：${reason || "未知错误"}`),
      timing: { modelMs: Date.now() - t0, parseMs: 0 },
    };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onExternalAbort);
  }
  modelMs = Date.now() - t0;

  if (!resp.ok) {
    let detail = "";
    try {
      const errBody = await resp.text();
      const j = JSON.parse(errBody);
      detail = (j.error && (j.error.message || j.error.code)) || errBody.slice(0, 200);
    } catch { /* 保留空 */ }
    return { ok: false, status: "error", message: `AI 服务返回 ${resp.status}${detail ? `：${String(detail).slice(0, 200)}` : ""}`, timing: { modelMs, parseMs: 0 } };
  }

  const t1 = Date.now();
  let data;
  try {
    data = await resp.json();
  } catch {
    return { ok: false, status: "error", message: "AI 返回内容无法解析", timing: { modelMs, parseMs: Date.now() - t1 } };
  }
  const raw = data.choices?.[0]?.message?.content;
  const draft = sanitizeDraft(extractJson(typeof raw === "string" ? raw : null), ctx, text);
  parseMs = Date.now() - t1;
  if (!draft) {
    return { ok: false, status: "error", message: "AI 未返回有效 JSON 草稿", timing: { modelMs, parseMs } };
  }
  return { ok: true, status: "ok", draft, model, timing: { modelMs, parseMs } };
}

module.exports = { parseReceipt, arkStatus, todayHK, sanitizeDraft };
