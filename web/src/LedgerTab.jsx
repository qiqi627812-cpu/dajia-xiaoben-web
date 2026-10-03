// LedgerTab.jsx — 明细 Dashboard：统计概览（分类环形图 + 成员承担条形图）＋ 记录列表
// 所有统计来自真实保存的账目；金额一律整数最小货币单位（原币口径）或 元（折算口径，仅显示）。
// 多币种：原币模式一次只看一种币种（不跨币种相加）；统一折算 = 已保存快照优先 → 行内汇率，缺汇率明示
// 缺汇率状态（spec）：无账目→「还没有支出」；有账目全缺→总额「—」+待折算笔数+自动补齐入口；
//   部分缺→「已折算部分」+待补笔数；图表无可折算数据→「补齐汇率后显示统计」；成员金额不冒充 0 →「待折算」。
import React, { useEffect, useMemo, useRef, useState } from "react";
import { api, fmtMoney, minorToYuan, CATEGORIES, catOf, validCategoryId, percentLargestRemainder } from "./api";
import { symOf, labelOf } from "./currencyMeta";
import EntryForm from "./EntryForm";
import accounting from "../../shared/accounting.cjs";
import { decimalsOf } from "./currencyMeta";
import Avatar from "./Avatar";
import CurrencyPicker from "./CurrencyPicker";
import { useRates, RateRow, FxApplier } from "./RateRow";

const curMonth = () => new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Hong_Kong"}).format(new Date()).slice(0,7);

export default function LedgerTab({ entries, members, profile, refresh, toast, highlight }) {
  const [editing, setEditing] = useState(null);
  const [confirmDel, setConfirmDel] = useState(null);
  const [showFxApply, setShowFxApply] = useState(false);
  const itemRefs = useRef({});

  /* ---- 月份 / 口径选择 ---- */
  const months = useMemo(() => {
    const set = new Set(entries.map((e) => e.date.slice(0, 7)));
    set.add(curMonth());
    return [...set].sort().reverse();
  }, [entries]);
  const [month, setMonth] = useState(() => {
    const withEntries = [...new Set(entries.map((e) => e.date.slice(0, 7)))].sort().reverse();
    return withEntries[0] || curMonth();
  });
  /* entries 变化后保持选中月份有效 */
  useEffect(() => {
    if (!months.includes(month)) setMonth(months[0]);
  }, [months, month]);

  const monthEntries = useMemo(() => entries.filter((e) => e.date.slice(0, 7) === month), [entries, month]);
  const currsInMonth = useMemo(() => [...new Set(monthEntries.map((e) => e.currency))], [monthEntries]);

  const [mode, setMode] = useState("per");          // per=原币（单币种） | unify=统一折算
  const [cur, setCur] = useState(null);              // 原币模式的币种
  useEffect(() => { if (currsInMonth.length && !currsInMonth.includes(cur)) setCur(currsInMonth[0]); }, [currsInMonth, cur]);
  const [target, setTarget] = useState("CNY");

  /* ---- 统计口径内的账目（消费口径；type 非 expense 一律排除，还款不计入） ---- */
  const scoped = useMemo(() => {
    if (mode === "per") return monthEntries.filter((e) => e.currency === cur);
    return monthEntries;                              // 折算模式：全部（按各自汇率折）
  }, [mode, monthEntries, cur]);

  /* ---- 汇率行（unify）：自动候选 + 手动；目标币变化自动作废重查 ---- */
  const neededRates = useMemo(() => (mode === "unify" ? [...new Set(scoped.map((e) => e.currency))].filter((c) => c !== target) : []), [mode, scoped, target]);
  const { rates, meta, setManual, restoreAuto, autoFill } = useRates(target);
  useEffect(() => {}, [target]);  // eslint-disable-line

  /* ---- 每笔的有效折算：已保存快照 > 行内汇率；缺 → null（=待折算，绝不记 0） ---- */
  const effRate = (e) => {
    if (e.currency === target) return { rate: 1, source: "same" };
    const snap = e.fx && e.fx[target];
    if (snap && Number(snap.rate) > 0) return snap;
    const r = Number(rates[e.currency]);
    return r > 0 ? { rate: r, source: meta[e.currency]?.source === "api" ? "api" : "manual", rateDate: meta[e.currency]?.rateDate } : null;
  };
  /* 统计值：per 模式=最小货币单位（整数）；unify 模式=折算元值；无法折算 → null（待折算） */
  const convVal = (e, minor) => {
    if (mode === "per") return minor;
    const er = effRate(e);
    if (!er) return null;
    const converted = accounting.convertEntry(e,target,decimalsOf,rates);
    if (minor === e.totalMinor) return converted.totalMinor / 10 ** decimalsOf(target);
    return accounting.convert(minor,er.rate,decimalsOf(e.currency),decimalsOf(target)) / 10 ** decimalsOf(target);
  };

  /* v 的单位：per 模式=最小货币单位；unify 模式=已折算的目标币元值（不再二次折算） */
  const money = (v) => (mode === "unify"
    ? `${symOf(target) || ""}${v.toLocaleString("zh-CN", { minimumFractionDigits: decimalsOf(target), maximumFractionDigits: decimalsOf(target) })}`
    : fmtMoney(v, cur));

  const sumMinor = scoped.reduce((a, e) => a + e.totalMinor, 0);
  const hasRate = (e) => mode !== "unify" || effRate(e) != null;
  const totalYuanUnified = mode === "unify" ? scoped.reduce((a, e) => a + (convVal(e, e.totalMinor) || 0), 0) : 0;
  const convertedCount = mode === "unify" ? scoped.filter(hasRate).length : scoped.length;
  const pendingEntries = mode === "unify" ? scoped.filter((e) => !hasRate(e)) : [];
  const pendingCount = pendingEntries.length;

  /* ---- 分类统计（categoryId 汇总；待折算的分类不冒充 0） ---- */
  const catStats = useMemo(() => {
    const acc = new Map();
    for (const e of scoped) {
      const v = convVal(e, e.totalMinor);
      if (v == null) continue;                        // 待折算的账目不进入图表
      const id = validCategoryId(e.categoryId);
      const prev = acc.get(id) || { value: 0, currencies: new Set() };
      prev.value += v;
      prev.currencies.add(e.currency);
      acc.set(id, prev);
    }
    const rows = CATEGORIES.map((c) => {
      const s = acc.get(c.id);
      return { id: c.id, label: c.label, icon: c.icon, color: c.color, value: s ? s.value : 0 };
    }).filter((r) => r.value > 0);
    const total = rows.reduce((a, r) => a + r.value, 0);
    const pcts = percentLargestRemainder(rows.map((r) => r.value));
    rows.forEach((r, i) => { r.pct = pcts[i]; });
    return { rows, total };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoped, mode, rates, target]);

  /* ---- 成员承担统计（splits 汇总；不是付款金额；有待折算 → 标记，不冒充 0） ---- */
  const memberStats = useMemo(() => {
    const acc = new Map();                            // name -> {value, pending}
    for (const e of scoped) {
      for (const s of e.splits) {
        const key = accounting.identity(s.id,s.name);
        const prev = acc.get(key) || { value: 0, pending: false, id:s.id, name:s.name };
        const ce = mode === "unify" ? accounting.convertEntry(e,target,decimalsOf,rates) : e;
        const v = ce ? Number(ce.splits[e.splits.indexOf(s)].minor) / (mode === "unify" ? 10 ** decimalsOf(target) : 1) : null;
        if (v == null) prev.pending = true;
        else prev.value += v;
        acc.set(key, prev);
      }
    }
    const rows = [...acc.entries()].map(([name, v]) => {
      const m = members.find((x) => String(x.id) === String(v.id));
      return { name: m?.name || v.name, avatar: m ? m.avatar : null, value: v.value, pending: v.pending };
    }).sort((a, b) => b.value - a.value);
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoped, mode, members, rates, target]);

  const memberMax = memberStats.reduce((a, r) => Math.max(a, r.value), 0);

  /* ---- 记录列表 ---- */
  const listMonths = useMemo(() => {
    const g = [];
    for (const e of monthEntries) {
      if (!g.length || g[g.length - 1].m !== e.date.slice(0, 7)) g.push({ m: e.date.slice(0, 7), list: [] });
      g[g.length - 1].list.push(e);
    }
    return g;
  }, [monthEntries]);

  useEffect(() => {
    if (highlight == null) return;
    const highlighted = entries.find(e=>String(e.id)===String(highlight));
    if (highlighted && highlighted.date.slice(0,7)!==month) {setMonth(highlighted.date.slice(0,7));return;}
    const el = itemRefs.current[String(highlight)];
    if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlight, entries, month]);

  const undo = async () => {
    try {
      const r = await api.undoLatest();
      toast(`已撤销最近一次入账：${r.undone.title}（${r.undone.date}）`);
      refresh();
    } catch (e) { toast(e.message, true); }
  };

  const del = async (id) => {
    try {
      await api.deleteEntry(id);
      toast("已删除");
      setConfirmDel(null);
      refresh();
    } catch (e) { toast(e.message, true); }
  };

  const saveEdit = (entry) => api.patchEntry(entry.id, entry)
    .then(() => { toast("已保存修改"); setEditing(null); refresh(); })
    .catch((e) => toast(`保存失败：${e.message}`, true));

  const modeLabel = mode === "per" ? `${cur || "-"} 原币` : `折算 ${target}`;
  /* 快照来源小注：有快照参与的折算才显示 */
  const snapCount = mode === "unify" ? scoped.filter((e) => e.currency !== target && e.fx && e.fx[target]).length : 0;

  return (
    <section className="ledger-tab dashboard">
      {editing ? (
        <div className="card">
          <h3>编辑账目</h3>
          <EntryForm initial={editing} members={members} profile={profile}
            onSave={saveEdit} onCancel={() => setEditing(null)} submitLabel="保存修改" />
        </div>
      ) : confirmDel ? (
        <div className="card confirm-card">
          <h3>删除账目</h3>
          <p>确定删除「{confirmDel.title}」（{confirmDel.date}，{fmtMoney(confirmDel.totalMinor, confirmDel.currency)}）？此操作不可恢复。</p>
          <div className="form-actions">
            <button className="danger" onClick={() => del(confirmDel.id)}>删除</button>
            <button className="ghost" onClick={() => setConfirmDel(null)}>取消</button>
          </div>
        </div>
      ) : showFxApply && pendingEntries.length ? (
        <FxApplier pendingEntries={pendingEntries} target={target} refresh={refresh} toast={toast} onClose={() => setShowFxApply(false)} />
      ) : (
        <>
          {/* 1) 标题 + 月份 */}
          <div className="dash-bar">
            <h2 className="dash-title">明细 · {month.replace("-", " 年 ")} 月</h2>
            <label className="fld inline">
              <span>月份</span>
              <select value={month} onChange={(e) => setMonth(e.target.value)}>
                {months.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </label>
          </div>

          {/* 2) 口径选择 + 汇率入口 */}
          <div className="dash-opts card">
            <div className="seg">
              <button className={mode === "per" ? "on" : ""} onClick={() => setMode("per")}>按原币种</button>
              <button className={mode === "unify" ? "on" : ""} onClick={() => setMode("unify")}>统一折算</button>
            </div>
            {mode === "per" ? (
              <label className="fld inline"><span>币种</span>
                <select value={cur || ""} onChange={(e) => setCur(e.target.value)}>
                  {currsInMonth.length
                    ? currsInMonth.map((c) => <option key={c} value={c}>{c} {labelOf(c)}</option>)
                    : <option value="">（本月无账目）</option>}
                </select>
              </label>
            ) : (
              <div className="fx-panel">
                <div className="fld inline"><span>折算为</span>
                  <CurrencyPicker value={target} onChange={setTarget} compact />
                </div>
                {neededRates.map((c) => (
                  <RateRow key={c} src={c} target={target} rates={rates} meta={meta}
                    setManual={setManual} restoreAuto={restoreAuto} />
                ))}
              </div>
            )}
          </div>

          {/* 3) 本月总支出（缺汇率状态如实表达，不用 0 冒充） */}
          <div className="dash-total card">
            <div>
              <span className="hint">本月总支出（{modeLabel}）</span>
              <b className="dash-amount">
                {mode === "per"
                  ? (cur ? fmtMoney(sumMinor, cur) : "—")
                  : convertedCount === 0
                    ? (scoped.length ? "—" : `${symOf(target) || ""}0.00`)
                    : convertedCount < scoped.length
                      ? <>已折算部分 {symOf(target) || ""}{totalYuanUnified.toLocaleString("zh-CN", { minimumFractionDigits: decimalsOf(target), maximumFractionDigits: decimalsOf(target) })}</>
                      : `${symOf(target) || ""}${totalYuanUnified.toLocaleString("zh-CN", { minimumFractionDigits: decimalsOf(target), maximumFractionDigits: decimalsOf(target) })}`}
              </b>
              <span className="hint">
                {scoped.length} 笔{mode === "unify" && pendingCount > 0
                  ? ` · 已折算 ${convertedCount} 笔 · ${pendingCount} 笔待折算` : ""}
                {mode === "unify" && snapCount > 0 ? ` · ${snapCount} 笔用已保存汇率快照` : ""}
              </span>
            </div>
            {mode === "unify" && pendingCount > 0 && (
              <p className="hint warn">
                <b>{convertedCount === 0 ? "支出待折算" : "折算未完成"}</b>：
                {convertedCount === 0
                  ? <>有 {pendingCount} 笔支出待折算（上面不是 0 支出）。</>
                  : <>上面是已折算部分；还有 {pendingCount} 笔缺 {pendingEntries.map((e) => e.currency).filter((v, i, a) => a.indexOf(v) === i).join("、")} 对 {target} 的汇率。</>}
                <button type="button" className="banner-recheck" onClick={() => setShowFxApply(true)}>自动补齐汇率</button>
              </p>
            )}
            {mode === "per" && currsInMonth.length > 1 && (
              <p className="hint">本月含多种币种（{currsInMonth.join("、")}），不同币种不能直接相加，正在分别查看。</p>
            )}
          </div>

          {/* 4+5) 图表区：桌面同行，手机上下 */}
          <div className="dash-charts">
            <div className="card chart-block">
              <h3>支出花在哪儿</h3>
              <Donut rows={catStats.rows} total={catStats.total}
                centerLabel={mode === "per" ? cur : target}
                centerAmount={mode === "per" && cur ? fmtMoney(sumMinor, cur)
                  : `${symOf(target) || ""}${totalYuanUnified.toLocaleString("zh-CN", { minimumFractionDigits: decimalsOf(target), maximumFractionDigits: decimalsOf(target) })}`}
                money={money}
                noData={mode === "unify" && pendingCount > 0 ? "pending" : scoped.length === 0 ? "empty" : null} />
            </div>
            <div className="card chart-block">
              <h3>每个人承担多少 <small className="hint">按分摊计算</small></h3>
              {memberStats.length === 0 ? (
                <div className="empty small">{scoped.length === 0 ? "本月还没有支出" : "补齐汇率后显示统计"}</div>
              ) : (
                <ul className="bar-list">
                  {memberStats.map((r) => (
                    <li key={r.name} className={`bar-row${r.pending && r.value === 0 ? " pending" : ""}`}>
                      <Avatar name={r.name} src={r.avatar} size={36} />
                      <span className="bar-name">{r.name}</span>
                      <span className="bar-val">{r.value === 0 && r.pending ? "待折算" : money(r.value)}{r.pending && r.value > 0 ? " ＋待折算" : ""}</span>
                      <div className="bar-track">
                        <div className={`bar-fill${r.pending && r.value === 0 ? " pend" : ""}`} style={{ width: `${memberMax > 0 ? Math.max(2, (r.value / memberMax) * 100) : 0}%` }} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {memberStats.length > 0 && memberStats.some((r) => !r.pending) && (
                <p className="hint">承担合计 = 当前口径总支出
                  （{mode === "per" && cur ? fmtMoney(memberStats.reduce((a, r) => a + r.value, 0), cur)
                    : `${symOf(target) || ""}${memberStats.reduce((a, r) => a + r.value, 0).toFixed(2)}`}）</p>
              )}
            </div>
          </div>

          {/* 6) 账目明细列表 */}
          <div className="ledger-bar">
            <p className="hint">共 {entries.length} 笔（本月 {monthEntries.length} 笔）</p>
            <button className="ghost" onClick={undo}>撤销最近一次入账</button>
          </div>
          {monthEntries.length === 0 && <div className="empty">本月还没有账目，去「记一笔」记第一笔吧。</div>}
          {listMonths.map(({ m, list }) => (
            <div key={m} className="month-group">
              <ul className="entry-list">
                {list.map((e) => {
                  const c = catOf(e.categoryId);
                  return (
                    <li key={e.id}
                      ref={(el) => { itemRefs.current[String(e.id)] = el; }}
                      className={`entry-item${String(highlight) === String(e.id) ? " hl" : ""}`}>
                      <div className="entry-main">
                        <b className="entry-title">
                          <span className="cat-badge" style={{ background: `${c.color}33`, borderColor: `${c.color}88` }} title={c.label}>{c.icon} {c.label}</span>
                          {e.title}
                          {e.source === "ai" && <span className="badge-ai">AI</span>}
                        </b>
                        <span className="entry-meta">
                          {e.date} · {e.payerName} 付 · {fmtMoney(e.totalMinor, e.currency)}
                        </span>
                        <span className="entry-ppl">
                          {e.splits.map((s) => `${s.name} ${fmtMoney(s.minor, e.currency)}`).join("、")}
                        </span>
                      </div>
                      <div className="entry-ops">
                        <button onClick={() => setEditing(e)}>编辑</button>
                        <button className="danger-text" onClick={() => setConfirmDel(e)}>删除</button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </>
      )}
    </section>
  );
}

/* ---- 分类环形图（SVG stroke-dasharray；无数据空环；待折算 ≠ 没有支出） ---- */
function Donut({ rows, total, centerLabel, centerAmount, money, noData }) {
  const R = 80;          // viewBox 半径（CSS 缩放到响应尺寸）
  const C = 2 * Math.PI * R;
  let offset = 0;
  const segs = rows.map((r) => {
    const frac = total > 0 ? r.value / total : 0;
    const seg = { ...r, len: frac * C, offset };
    offset += seg.len;
    return seg;
  });

  return (
    <div className="donut-wrap">
      <svg viewBox="0 0 200 200" className="donut" role="img" aria-label="分类环形图">
        {total <= 0 ? (
          <circle cx="100" cy="100" r={R} fill="none" stroke="rgba(52,76,84,.12)" strokeWidth="26" />
        ) : (
          segs.map((s) => (
            <circle key={s.id} cx="100" cy="100" r={R} fill="none" stroke={s.color}
              strokeWidth="26" strokeDasharray={`${s.len} ${C - s.len}`} strokeDashoffset={-s.offset}
              pathLength={C} transform="rotate(-90 100 100)" />
          ))
        )}
        <text x="100" y="92" textAnchor="middle" className="donut-cur">{centerLabel}</text>
        <text x="100" y="118" textAnchor="middle" className="donut-amt">{total <= 0 ? (noData === "pending" ? "—" : "0") : centerAmount}</text>
      </svg>
      {total <= 0 ? (
        <div className="empty small">{noData === "pending" ? "补齐汇率后显示统计" : "本月还没有支出"}</div>
      ) : (
        <ul className="cat-list">
          {rows.map((r) => (
            <li key={r.id}>
              <span className="cat-dot" style={{ background: r.color }} />
              <span className="cat-name">{r.icon} {r.label}</span>
              <b className="cat-amt">{money(r.value)}</b>
              <span className="cat-pct">{r.pct}%</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
