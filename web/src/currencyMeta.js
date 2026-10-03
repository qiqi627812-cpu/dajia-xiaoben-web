// currencyMeta.js — 币种元数据注册表（全站唯一）
// 初始数据来自 shared/currencies.json（与 server 同一份）；运行时合并 /api/currencies
// 返回的目录（含本账本加入的标准币种与自定义币种）。
// 小数位：curated 为 ISO 4217 元数据；decimalsKnown=false 的目录项需用户确认后启用。
import shared from "../../shared/currencies.json";

const META = {};   // code -> {code, zh, en, symbol, decimals, decimalsKnown, custom, apiSupport, added}
for (const [code, m] of Object.entries(shared.meta)) {
  META[code] = { code, zh: m.zh, en: m.en, symbol: m.symbol, decimals: m.decimals, decimalsKnown: true, apiSupport: true };
}

let LISTS = {
  common: shared.common.slice(),      // 常用（初始 20）
  all: Object.keys(META),             // 可搜索全集
  custom: [],
};

/* 应用服务端目录（App 拉取 /api/currencies 后调用） */
export function applyCurrencies(payload) {
  if (!payload) return;
  for (const it of payload.all || []) {
    const prev = META[it.code];
    if (!prev) {
      META[it.code] = {
        code: it.code, zh: it.zh || "", en: it.en || "", symbol: it.symbol || "",
        decimals: Number.isFinite(it.decimals) ? it.decimals : null,
        decimalsKnown: Boolean(it.decimalsKnown), apiSupport: Boolean(it.apiSupport),
      };
    } else if (!prev.decimalsKnown && it.decimalsKnown) {
      META[it.code] = { ...prev, ...it, code: it.code };
    } else {
      META[it.code] = { ...prev, zh: it.zh || prev.zh, en: it.en || prev.en, symbol: it.symbol || prev.symbol, apiSupport: it.apiSupport !== false };
    }
  }
  for (const it of payload.common || []) {
    if (!META[it.code]) {
      META[it.code] = {
        code: it.code, zh: it.zh || "", en: it.en || "", symbol: it.symbol || "",
        decimals: Number.isFinite(it.decimals) ? it.decimals : 2, decimalsKnown: Boolean(it.decimalsKnown),
        apiSupport: it.apiSupport !== false, custom: Boolean(it.custom), added: Boolean(it.added),
      };
    } else {
      META[it.code] = { ...META[it.code], custom: Boolean(it.custom), added: it.added || META[it.code].added };
    }
  }
  for (const it of payload.custom || []) {
    META[it.code] = { code: it.code, zh: it.name, en: "", symbol: it.symbol || "", decimals: it.decimals, decimalsKnown: true, custom: true, apiSupport: false };
  }
  LISTS = {
    common: (payload.common || []).map((x) => x.code),
    all: (payload.all || []).map((x) => x.code),
    custom: (payload.custom || []).map((x) => x.code),
  };
}

export const metaOf = (code) => META[String(code || "").toUpperCase()] || null;
export const decimalsOf = (code) => {
  const d = META[String(code || "").toUpperCase()]?.decimals;
  return Number.isFinite(d) ? d : 2;
};
export const symOf = (code) => META[String(code || "").toUpperCase()]?.symbol || "";
export const labelOf = (code) => {
  const m = META[String(code || "").toUpperCase()];
  return m ? (m.zh || m.en || m.code) : String(code || "");
};
export const isKnownCurrency = (code) => Boolean(META[String(code || "").toUpperCase()]);
export const commonCurrencies = () => LISTS.common;
export const allCurrencies = () => LISTS.all;
export const customCurrencies = () => LISTS.custom;
