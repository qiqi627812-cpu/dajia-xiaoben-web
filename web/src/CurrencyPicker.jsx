// CurrencyPicker.jsx — 可搜索币种选择器（全站共用一份目录配置）
// 结构：常用列表 / 搜索（中文名 + 英文名 + 代码）/ 更多币种 / ＋ 添加币种（自定义）
// 选中不在常用里的标准币种 → 先 POST /api/currencies 加入常用，再回调 onChange
// 自定义币种：名称 + 唯一标识 + 符号(选填) + 小数位(0-4)，标记 custom（无自动汇率）
import React, { useEffect, useMemo, useRef, useState } from "react";
import { api } from "./api";
import { metaOf, labelOf, commonCurrencies, allCurrencies } from "./currencyMeta";

export default function CurrencyPicker({ value, onChange, onCurrencyAdded, compact, placeholder }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [showMore, setShowMore] = useState(false);
  const [adding, setAdding] = useState(false);
  const [addErr, setAddErr] = useState("");
  const [busy, setBusy] = useState(false);
  const rootRef = useRef(null);
  const searchRef = useRef(null);

  /* 点击组件外关闭 */
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) { setOpen(false); setAdding(false); setQ(""); }
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape" && open) { setOpen(false); setAdding(false); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  useEffect(() => { if (open && searchRef.current) searchRef.current.focus({ preventScroll: true }); }, [open, adding]);

  const common = commonCurrencies();
  const all = allCurrencies();
  const query = q.trim().toLowerCase();
  const match = (code) => {
    if (!query) return false;
    const m = metaOf(code) || {};
    return code.toLowerCase().includes(query)
      || (m.zh || "").includes(query)
      || (m.en || "").toLowerCase().includes(query);
  };
  const searchHits = useMemo(() => (query ? all.filter(match) : []), [query, all.join(",")]);
  const moreList = useMemo(() => (showMore && !query ? all.filter((c) => !common.includes(c)) : []), [showMore, query, all.join(","), common.join(",")]);

  const select = async (code) => {
    code = String(code).toUpperCase();
    if (common.includes(code)) {
      onChange(code);
      setOpen(false); setQ(""); setShowMore(false); setAdding(false);
      return;
    }
    /* 未加入常用的标准币种：先加入本账本常用列表 */
    setBusy(true);
    try {
      const meta = metaOf(code);
      const needDecimals = meta && meta.decimalsKnown === false;
      if (needDecimals) {setCf({code,name:meta.en||code,symbol:meta.symbol||"",decimals:2});setAdding(true);setAddErr("请确认该币种的小数位后添加，系统不会猜测精度。");setBusy(false);return;}
      const r = await api.addCurrency({ code });
      if (onCurrencyAdded) onCurrencyAdded(r.currency || { code });
      onChange(code);
      setOpen(false); setQ(""); setShowMore(false); setAdding(false);
    } catch (e) {
      setAddErr(e.message || "加入失败");
    }
    setBusy(false);
  };

  /* —— 自定义币种表单 —— */
  const [cf, setCf] = useState({ code: "", name: "", symbol: "", decimals: 2 });
  const submitCustom = async (e) => {
    e.preventDefault();
    setAddErr("");
    const code = cf.code.trim().toUpperCase();
    const name = cf.name.trim();
    if (!name) { setAddErr("名称必填"); return; }
    if (!/^[A-Z0-9]{3,8}$/.test(code)) { setAddErr("唯一标识需为 3-8 位字母/数字"); return; }
    if (metaOf(code) || all.includes(code)) { setAddErr(`标识 ${code} 与已有币种冲突`); return; }
    setBusy(true);
    try {
      const r = await api.addCurrency({ code, name, symbol: cf.symbol.trim(), decimals: Number(cf.decimals), isCustom: true });
      if (onCurrencyAdded) onCurrencyAdded(r.currency || { code, name, isCustom: true });
      onChange(code);
      setOpen(false); setQ(""); setAdding(false); setCf({ code: "", name: "", symbol: "", decimals: 2 });
    } catch (e2) {
      setAddErr(e2.message || "创建失败");
    }
    setBusy(false);
  };

  const cur = value ? metaOf(value) : null;

  return (
    <div className={`curr-picker${compact ? " compact" : ""}`} ref={rootRef}>
      <button type="button" className="curr-btn" onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox" aria-expanded={open}>
        {value ? <><b>{value}</b><span>{labelOf(value)}</span>{cur && cur.symbol ? <em>{cur.symbol}</em> : null}</>
          : <span className="curr-ph">{placeholder || "选择币种"}</span>}
        <i className="curr-caret" aria-hidden>▾</i>
      </button>
      {open && (
        <div className="curr-menu" role="listbox">
          {adding ? (
            <form className="curr-add-form" onSubmit={submitCustom}>
              <b>添加自定义币种</b>
              <p className="hint">目录里没有时创建；标记为自定义，不伪装成标准 ISO 币种，汇率手动填写。</p>
              <label className="fld"><span>名称（必填）</span>
                <input value={cf.name} onChange={(e) => setCf({ ...cf, name: e.target.value })} placeholder="如：民宿积分" maxLength={24} autoFocus />
              </label>
              <label className="fld"><span>唯一标识（必填，3-8 位，不与已有冲突）</span>
                <input value={cf.code} onChange={(e) => setCf({ ...cf, code: e.target.value.toUpperCase() })} placeholder="如：PTS" maxLength={8} />
              </label>
              <label className="fld"><span>显示符号（选填）</span>
                <input value={cf.symbol} onChange={(e) => setCf({ ...cf, symbol: e.target.value })} placeholder="如：Ⓟ" maxLength={8} />
              </label>
              <label className="fld"><span>小数位（必填，默认 2）</span>
                <select value={cf.decimals} onChange={(e) => setCf({ ...cf, decimals: Number(e.target.value) })}>
                  {[0, 1, 2, 3, 4].map((d) => <option key={d} value={d}>{d} 位</option>)}
                </select>
              </label>
              <p className="hint warn">币种被账目使用后，小数位不可再改（历史金额按原口径解释）。</p>
              {addErr && <p className="form-err">{addErr}</p>}
              <div className="form-actions">
                <button type="submit" className="primary" disabled={busy}>创建并使用</button>
                <button type="button" className="ghost" onClick={() => { setAdding(false); setAddErr(""); }}>返回列表</button>
              </div>
            </form>
          ) : (
            <>
              <input ref={searchRef} className="curr-search" value={q} onChange={(e) => setQ(e.target.value)}
                placeholder="搜索币种：中文 / 英文 / 代码" />
              <div className="curr-scroll">
                {query ? (
                  <div className="curr-group">
                    <p className="curr-gtitle">搜索结果（{searchHits.length}）</p>
                    {searchHits.map((c) => <CurrItem key={c} code={c} used={c === value} onPick={select} busy={busy} />)}
                    {!searchHits.length && <p className="hint" style={{ padding: "8px 10px" }}>目录里没有「{q.trim()}」；可创建自定义币种。</p>}
                  </div>
                ) : (
                  <div className="curr-group">
                    <p className="curr-gtitle">常用币种</p>
                    {common.map((c) => <CurrItem key={c} code={c} used={c === value} onPick={select} busy={busy} />)}
                  </div>
                )}
                {!query && (showMore ? (
                  <div className="curr-group">
                    <p className="curr-gtitle">更多币种（{moreList.length}）</p>
                    {moreList.map((c) => <CurrItem key={c} code={c} used={c === value} onPick={select} busy={busy} />)}
                    <button type="button" className="curr-more" onClick={() => setShowMore(false)}>收起</button>
                  </div>
                ) : (
                  <button type="button" className="curr-more" onClick={() => setShowMore(true)}>更多币种（{all.length - common.length}）</button>
                ))}
              </div>
              <button type="button" className="curr-add" onClick={() => { setAdding(true); setAddErr(""); }}>＋ 添加币种</button>
              {addErr && !adding && <p className="form-err" style={{ margin: "0 10px 8px" }}>{addErr}</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function CurrItem({ code, used, onPick, busy }) {
  const m = metaOf(code) || { zh: "", en: "", symbol: "", decimals: 2 };
  return (
    <button type="button" className={`curr-item${used ? " used" : ""}`} role="option" aria-selected={used}
      disabled={busy} onClick={() => onPick(code)}>
      <i className="curr-sym">{m.symbol || code.slice(0, 1)}</i>
      <b>{code}</b>
      <span>{m.zh || m.en || code}</span>
      {m.custom ? <em className="curr-tag custom">自定义</em>
        : m.decimals === 0 ? <em className="curr-tag">0位小数</em>
          : m.decimals === 3 ? <em className="curr-tag">3位小数</em> : null}
    </button>
  );
}
