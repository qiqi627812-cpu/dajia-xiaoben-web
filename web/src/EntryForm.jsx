// EntryForm.jsx — 账目表单（手动 & AI 草稿共用；编辑复用）
// 金额内部一律整数最小货币单位；equal 模式余数按成员顺序分配并保证守恒
// 分类：稳定 categoryId；付款人/参与人用统一圆形 Avatar；参与人末尾「＋ 添加成员」
import React, { useMemo, useState, useEffect, useRef } from "react";
import { yuanToMinor, minorToYuan, splitEqual, fmtMoney, CATEGORIES, validCategoryId } from "./api";
import { symOf, decimalsOf, isKnownCurrency, labelOf } from "./currencyMeta";
import Avatar from "./Avatar";
import CurrencyPicker from "./CurrencyPicker";
import EntryRate from "./EntryRate";

export default function EntryForm({ initial, members, profile, onSave, onCancel, submitLabel, onRequestAddMember, autoSelectId, customSplitNote, onCurrencyAdded }) {
  const me = profile ? profile.nickname : "";
  const activeMembers = members.filter((m) => m.active || initial?.splits?.some(s=>String(s.id)===String(m.id)) || String(initial?.payerId)===String(m.id));

  const init = initial || {};
  const [title, setTitle] = useState(init.title || "");
  const [date, setDate] = useState(init.date || new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Hong_Kong"}).format(new Date()));
  /* 币种：AI 草稿未定（给了 currencyText）→ 留空强制确认；手动新建 → 预选账本默认币种 */
  const [currency, setCurrency] = useState(
    init.currency && isKnownCurrency(init.currency) ? init.currency
      : init.currencyText ? ""
        : (profile && profile.default_currency && isKnownCurrency(profile.default_currency) ? profile.default_currency : "CNY")
  );
  const [categoryId, setCategoryId] = useState(validCategoryId(init.categoryId));
  const [totalYuan, setTotalYuan] = useState(
    init.totalYuan != null ? String(init.totalYuan)
      : init.totalMinor != null ? String(minorToYuan(init.totalMinor, init.currency || "CNY"))
        : "");
  const [payerId, setPayerId] = useState(() => {
    if (init.payerId != null) return String(init.payerId);
    const meObj = activeMembers.find((m) => m.is_self);
    return meObj ? String(meObj.id) : "";
  });
  const [participantIds, setParticipantIds] = useState(() => {
    // AI 草稿：优先用解析出的成员 id（含平分建议里的 id）
    const fromIds = init.participantIds
      ? activeMembers.filter((m) => init.participantIds.map((m) => String(m.id)).includes(String(m.id))).map((m) => String(m.id))
      : null;
    if (fromIds) return fromIds;
    if (init.splits) {
      const ids = new Set(init.splits.map((s) => String(s.id)));
      const matched = activeMembers.filter((m) => ids.has(String(m.id))).map((m) => String(m.id));
      if (matched.length) return matched;
    }
    return activeMembers.map((m) => String(m.id));
  });
  const [mode, setMode] = useState(init.splits && init.splits.some((s) => s.minor) && activeMembers.length > 1 && !init.splits.every((s, i, a) => s.minor === a[0].minor) ? "exact" : "equal");
  const [exact, setExact] = useState(() => (init.splits ? Object.fromEntries(init.splits.map((s) => [String(s.id), String(minorToYuan(s.minor, init.currency || "CNY"))])) : {}));
  const [fx, setFx] = useState(init.fx || {});
  const [note, setNote] = useState(init.note || "");
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);
  const saveLock = useRef(false);
  const requestId = useRef(crypto.randomUUID());
  const [newlyAdded, setNewlyAdded] = useState(null); // 从「＋添加成员」回来的新成员 id

  const payerName = useMemo(() => {
    const p = activeMembers.find((m) => String(m.id) === String(payerId));
    return p ? p.name : "";
  }, [payerId, activeMembers]);

  /* 从「＋ 添加成员」返回：新成员自动勾选为参与人（等分自动重算；自定义金额新成员先 0）。
     refresh 与 onAdded 可能乱序到达：deps 含 activeMembers 以便成员列表晚到时重试；每个 id 只应用一次。 */
  const appliedAuto = useRef(null);
  useEffect(() => {
    if (autoSelectId == null || appliedAuto.current === String(autoSelectId)) return;
    const m = activeMembers.find((x) => String(x.id) === String(autoSelectId));
    if (!m) return;
    appliedAuto.current = String(autoSelectId);
    setParticipantIds((prev) => (prev.includes(String(m.id)) ? prev : [...prev, String(m.id)]));
    setNewlyAdded(String(m.id));
  }, [autoSelectId, activeMembers]);

  const totalMinor = yuanToMinor(totalYuan, currency);

  const participants = useMemo(
    () => activeMembers.filter((m) => participantIds.includes(String(m.id))),
    [activeMembers, participantIds]
  );

  const computedSplits = useMemo(() => {
    if (totalMinor == null || !participants.length) return [];
    if (mode === "equal") return splitEqual(totalMinor, participants);
    const out = participants.map((m) => ({ id: m.id, name: m.name, minor: yuanToMinor(exact[String(m.id)] || 0, currency) || 0 }));
    return out;
  }, [mode, totalMinor, participants, exact, currency]);

  const splitSum = computedSplits.reduce((a, s) => a + s.minor, 0);
  const conserved = totalMinor != null && computedSplits.length > 0 && splitSum === totalMinor;

  const submit = async (e) => {
    e.preventDefault();
    setErr("");
    if (!title.trim()) return setErr("请填写名称");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return setErr("日期格式应为 YYYY-MM-DD");
    if (!currency) return setErr(init.currencyText ? `AI 未能确定币种（原文「${init.currencyText}」），请选择` : "请选择币种");
    if (totalMinor == null) return setErr("总额需为正数");
    if (!payerName.trim()) return setErr("请选择付款人");
    if (!participants.length) return setErr("请至少选择一位参与人");
    if (mode === "exact" && !conserved) {
      return setErr(`金额不守恒：分摊合计 ${fmtMoney(splitSum, currency)} ≠ 总额 ${fmtMoney(totalMinor, currency)}`);
    }
    if (saveLock.current) return;
    saveLock.current = true; setSaving(true);
    try { await onSave({
      requestId: requestId.current,
      fx,
      id: init.id,
      title: title.trim(),
      date,
      currency,
      categoryId,
      totalMinor,
      payerId: payerId || null,
      payerName: payerName.trim(),
      splits: computedSplits.map((s) => ({ id: s.id, name: s.name, minor: s.minor })),
      items: init.items || null,
      note: note.trim() || null,
      source: init.source || "manual",
      aiConfidence: init.aiConfidence ?? null,
      aiWarnings: init.aiWarnings || null,
    }); } finally { saveLock.current = false; setSaving(false); }
  };

  const toggleP = (id) => {
    const sid = String(id);
    setParticipantIds((prev) => (prev.includes(sid) ? prev.filter((x) => x !== sid) : [...prev, sid]));
  };

  const moneyStep = currency ? Math.pow(10, -decimalsOf(currency)) : 0.01;

  return (
    <form className="entry-form" onSubmit={submit}>
      <div className="fld-row">
        <label className="fld grow">
          <span>名称</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="如：火锅晚餐" maxLength={60} />
        </label>
        <label className="fld">
          <span>类别</span>
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
            {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.icon} {c.label}</option>)}
          </select>
        </label>
      </div>
      <div className="fld-row">
        <label className="fld"><span>日期</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <div className="fld"><span>币种{init.currencyText && !currency ? "（待确认）" : ""}</span>
          <CurrencyPicker value={currency} onChange={(c) => { setCurrency(c); setErr(""); }} onCurrencyAdded={onCurrencyAdded} compact />
          {init.currencyText && !currency && <em className="hint curr-confirm">AI 未能确定币种（原文「{init.currencyText}」），请选择</em>}
        </div>
        <label className="fld"><span>总额（{currency ? symOf(currency) || labelOf(currency) : ""}）</span>
          <input type="number" min="0" step={moneyStep} value={totalYuan}
            onChange={(e) => setTotalYuan(e.target.value)} placeholder={currency && decimalsOf(currency) === 0 ? "整数" : "0.00"} inputMode="decimal" />
        </label>
      </div>

      <EntryRate currency={currency} date={date} initial={init.fx} onChange={setFx}/>
      <fieldset className="fld">
        <legend>付款人</legend>
        <div className="ppl ppl-payer">
          {activeMembers.map((m) => (
            <button type="button" key={m.id}
              className={`payer-chip${String(m.id) === String(payerId) ? " on" : ""}`}
              onClick={() => setPayerId(String(m.id))}>
              <Avatar name={m.name} src={m.avatar} size={34} me={m.is_self} />
              <span>{m.name}</span>
            </button>
          ))}
          {init.payerName && !activeMembers.some((m) => m.name === init.payerName) && (
            <span className="pill-snap">付款人快照：{init.payerName}</span>
          )}
        </div>
      </fieldset>

      <fieldset className="fld">
        <legend>参与人</legend>
        <div className="ppl">
          {activeMembers.map((m) => (
            <label key={m.id} className={`pill-check${participantIds.includes(String(m.id)) ? " on" : ""}`}>
              <input type="checkbox" checked={participantIds.includes(String(m.id))} onChange={() => toggleP(m.id)} />
              <Avatar name={m.name} src={m.avatar} size={30} me={m.is_self} />
              <span>{m.name}</span>
              {String(m.id) === newlyAdded && <em className="new-tag">新增</em>}
            </label>
          ))}
          {onRequestAddMember && (
            <button type="button" className="pill-add" onClick={onRequestAddMember}>＋ 添加成员</button>
          )}
        </div>
      </fieldset>
      <div className="fld-row">
        <div className="seg">
          <button type="button" className={mode === "equal" ? "on" : ""} onClick={() => setMode("equal")}>平分</button>
          <button type="button" className={mode === "exact" ? "on" : ""} onClick={() => setMode("exact")}>自定义分摊</button>
        </div>
      </div>
      {computedSplits.length > 0 && (
        <div className="splits">
          {mode === "equal" ? (
            <p className="hint">平分：</p>
          ) : (
            <p className="hint">自定义每人金额（{currency ? symOf(currency) || currency : ""}）：</p>
          )}
          <ul>
            {computedSplits.map((s) => (
              <li key={s.name}>
                <span>{s.name}{mode === "exact" && String(s.id) === newlyAdded && !exact[String(s.id)] ? "（新增，请填金额）" : ""}</span>
                {mode === "exact" ? (
                  <input type="number" min="0" step={moneyStep} value={exact[String(s.id)] || ""}
                    onChange={(e) => setExact((x) => ({ ...x, [String(s.id)]: e.target.value }))} inputMode="decimal" />
                ) : (
                  <b>{fmtMoney(s.minor, currency)}</b>
                )}
              </li>
            ))}
          </ul>
          {mode === "exact" && totalMinor != null && (
            <p className={`hint ${conserved ? "ok" : "warn"}`}>
              合计 {fmtMoney(splitSum, currency)} / 总额 {fmtMoney(totalMinor, currency)} {conserved ? "✓ 守恒" : "✗ 不守恒"}
            </p>
          )}
        </div>
      )}
      <label className="fld"><span>备注（可选）</span>
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
      </label>
      {err && <p className="form-err">{err}</p>}
      <div className="form-actions">
        <button type="submit" className="primary" disabled={saving}>{saving ? "正在保存…" : submitLabel || "入账"}</button>
        {onCancel && <button type="button" className="ghost" onClick={onCancel}>取消</button>}
      </div>
    </form>
  );
}
