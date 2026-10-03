// RateRow.jsx — 汇率行（1 源币 = [汇率] 目标币）+ useRates hook + FxApplier（自动补齐汇率）
// 行为约束（spec）：
//   - 自动获取：仅填充空输入（迟到报价不覆盖用户手动输入）
//   - 手动输入后显示「自定义」，保留「恢复自动汇率」
//   - 目标币变化 → 旧折合数字作废（重置重查）
//   - 快照（entries.fx）已保存的记录直接使用，不重复查询
//   - 失败/不支持：显示错误 + 保留手动入口，不无限重试
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, fmtMoney, minorToYuan } from "./api";
import { labelOf, symOf, metaOf } from "./currencyMeta";

/* ---- useRates：每源币种一行 { 输入值, 来源元数据 }；自动获取候选报价 ---- */
export function useRates(target) {
  const [rates, setRates] = useState({});   // src -> 输入框字符串
  const [meta, setMeta] = useState({});     // src -> {source:"api"|"manual", rateDate, fetchedAt, cached, busy, err, unsupported}
  const targetRef = useRef(target);
  const attempted = useRef({});             // src -> target（每次目标币变更后重置）

  /* 目标币变化：全部作废（不能沿用旧目标币的折合数字） */
  useEffect(() => {
    if (targetRef.current === target) return;
    targetRef.current = target;
    setRates({});
    setMeta({});
    attempted.current = {};
  }, [target]);

  const setManual = useCallback((src, v) => {
    setRates((r) => ({ ...r, [src]: v }));
    setMeta((m) => ({ ...m, [src]: v === "" ? { source: null } : { source: "manual" } }));
    /* 手动状态按「币种对」记录：切目标币后旧手动值不作数（见 autoFill） */
    const key = `${src}->${targetRef.current}`;
    if (String(v).trim() !== "") manualBy.current.add(key);
    else manualBy.current.delete(key);
  }, []);

  const fetchAuto = useCallback(async (src) => {
    setMeta((m) => ({ ...m, [src]: { ...(m[src] || {}), busy: true, err: null } }));
    const requestedTarget = targetRef.current;
    try {
      const r = await api.getRate(src, requestedTarget);
      if (targetRef.current !== requestedTarget) return {ok:false};
      setRates((prev) => {
        /* 迟到的 API 响应不覆盖用户刚输入的手动值（当前目标币下） */
        if (manualBy.current.has(`${src}->${targetRef.current}`)) return prev;
        return { ...prev, [src]: String(r.rate) };
      });
      if (!manualBy.current.has(`${src}->${requestedTarget}`)) setMeta((m) => ({ ...m, [src]: { source: "api", rateDate: r.rateDate, fetchedAt: r.fetchedAt, cached: r.cached, busy: false } }));
      return { ok: true, rate: r.rate, rateDate: r.rateDate };
    } catch (e) {
      if (targetRef.current !== requestedTarget) return {ok:false};
      const unsupported = e.status === 422;
      setMeta((m) => ({
        ...m,
        [src]: { ...(m[src] || {}), busy: false, source: (m[src] || {}).source === "manual" ? "manual" : null, err: e.message || "获取失败", unsupported },
      }));
      return { ok: false, message: e.message };
    }
  }, []);

  const metaRef = useRef(meta);
  metaRef.current = meta;
  const ratesRef = useRef(rates);
  ratesRef.current = rates;
  const manualBy = useRef(new Set());   // "src->target" 已手动输入的币种对

  const restoreAuto = useCallback((src) => {
    setRates((r) => ({ ...r, [src]: "" }));
    setMeta((m) => ({ ...m, [src]: { source: null, err: null, unsupported: false } }));
    manualBy.current.delete(`${src}->${targetRef.current}`);
    return fetchAuto(src);
  }, [fetchAuto]);

  /* 自动候选：进入视野的源币种自动查一次（仅填未被手动覆盖的输入；每个 src+target 只自动尝试一次） */
  const autoFill = useCallback((sources) => {
    for (const src of sources) {
      const key = `${src}->${targetRef.current}`;
      if (attempted.current[key]) continue;
      attempted.current[key] = true;
      /* 该币种对已被用户手动输入 → 不自动覆盖（切目标币后 key 变化，会正常自动查新币种对） */
      if (manualBy.current.has(key)) continue;
      fetchAuto(src);
    }
  }, [fetchAuto]);

  const clear = useCallback((src) => {
    setRates((r) => ({ ...r, [src]: "" }));
    setMeta((m) => ({ ...m, [src]: { source: null, err: null } }));
  }, []);

  return { rates, meta, setManual, fetchAuto, restoreAuto, autoFill, clear };
}

/* ---- 单行汇率编辑器：1 HKD = [输入] CNY [自动获取] + 来源小字 ---- */
export function RateRow({ src, target, rates, meta, setManual, restoreAuto }) {
  const m = meta[src] || {};
  const val = rates[src] || "";
  const srcLabel = `${src} ${labelOf(src)}`;
  return (
    <div className={`rate-row${m.err ? " err" : ""}`}>
      <span className="rate-pair"><b>1 {src}</b> =</span>
      <input type="number" min="0" step="0.0001" inputMode="decimal" value={val}
        placeholder="汇率" aria-label={`1 ${srcLabel} 兑多少 ${target}`}
        onChange={(e) => setManual(src, e.target.value)} />
      <span className="rate-pair to"><b>{target}</b></span>
      <button type="button" className="rate-btn" onClick={() => restoreAuto(src)} disabled={m.busy}>
        {m.busy ? "获取中…" : val && m.source === "manual" ? "恢复自动汇率" : "自动获取"}
      </button>
      <span className="rate-note">
        {m.busy ? "正在查询参考汇率…"
          : m.source === "api" ? `自动参考汇率 · 日期 ${m.rateDate || "?"} · Frankfurter${m.cached ? "（缓存）" : ""}`
          : m.source === "manual" ? "自定义汇率"
          : m.err ? (m.unsupported ? "暂无自动汇率，请手动填写" : `获取失败：${m.err}`)
          : "未获取"}
      </span>
      <a className="rate-src" href="https://frankfurter.dev" target="_blank" rel="noreferrer noopener">汇率来源</a>
    </div>
  );
}

/* ---- FxApplier：旧账目缺汇率时的「自动补齐」（逐笔按交易日期查询 → 预览 → 应用到这N笔） ---- */
export function FxApplier({ pendingEntries, target, refresh, toast, onClose }) {
  const [rows, setRows] = useState(() => pendingEntries.map((e) => ({
    id: e.id, title: e.title, date: e.date, currency: e.currency, totalMinor: e.totalMinor,
    rate: "", rateDate: null, source: null, status: "idle", err: null, manual: false,
  })));
  const [phase, setPhase] = useState("query");   // query|ready|applying|done
  const [applied, setApplied] = useState(0);

  const run = useCallback(async () => {
    setPhase("query");
    const out = [];
    for (const r of rows) {
      if (r.source) { out.push(r); continue; }   // 已有手动值不重查
      try {
        const resp = await api.getRate(r.currency, target, r.date);
        out.push({ ...r, rate: String(resp.rate), rateDate: resp.rateDate, source: "api", status: "ok" });
      } catch (e) {
        out.push({ ...r, status: "err", err: e.message || "查询失败" });
      }
    }
    setRows(out);
    setPhase("ready");
  }, [rows, target]);

  useEffect(() => { run(); /* eslint-disable-line */ }, []);

  const setRowManual = (i, v) => {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, rate: v, source: v ? "manual" : null, status: v ? "ok" : "idle", err: null } : r)));
  };

  const okRows = rows.filter((r) => Number(r.rate) > 0);
  const apply = async () => {
    setPhase("applying");
    try {
      const r = await api.applyFx(target, okRows.map((x) => ({ id: x.id, rate: Number(x.rate), rateDate: x.rateDate, source: x.source })));
      setApplied(r.applied);
      setPhase("done");
      toast(`已将汇率应用到 ${r.applied} 笔账目（保存为快照，不随最新报价变化）`);
      refresh();
    } catch (e) {
      toast(`应用失败：${e.message}`, true);
      setPhase("ready");
    }
  };

  if (phase === "done") {
    return (
      <div className="card fx-applier">
        <h3>自动补齐汇率 · 完成</h3>
        <p className="hint">已保存 {applied} 笔的汇率快照（含来源与实际报价日期）。历史账目不随每日最新汇率自动变化；如需更新，需重新确认应用。</p>
        <div className="form-actions"><button className="ghost" onClick={onClose}>关闭</button></div>
      </div>
    );
  }

  return (
    <div className="card fx-applier">
      <h3>自动补齐汇率（{target} {labelOf(target)}）</h3>
      <p className="hint">按每笔账目<b>交易日期</b>查询参考汇率；周末/假日自动用前一有效交易日（如实显示其日期）。先核对，再应用。</p>
      <ul className="fx-rows">
        {rows.map((r, i) => {
          const meta = r.currency && metaOf(r.currency);
          return (
            <li key={r.id} className={r.status === "err" ? "fx-err" : ""}>
              <span className="fx-entry">{r.date} · {r.title} · {fmtMoney(r.totalMinor, r.currency)}</span>
              <span className={`fx-rate${r.status === "err" ? " err" : ""}`}>
                <input disabled={phase === "query" || phase === "applying"} type="number" min="0" step="0.0001" value={r.rate}
                  placeholder={phase === "query" && r.status !== "err" ? "查询中…" : "手动填"}
                  onChange={(e) => setRowManual(i, e.target.value)} />
                <b>{r.currency}→{target}</b>
                <em>{r.status === "err" ? `暂无自动汇率（${r.err}）` : r.source === "api" ? `报价日 ${r.rateDate || "?"}` : r.source === "manual" ? "手动" : ""}</em>
              </span>
              {meta && meta.custom && <em className="curr-tag custom">自定义·手动</em>}
            </li>
          );
        })}
      </ul>
      {phase === "query" && <p className="hint">正在按交易日期逐笔查询…</p>}
      <div className="form-actions">
        <button className="primary" disabled={phase !== "ready" || !okRows.length} onClick={apply}>
          应用到这 {okRows.length} 笔
        </button>
        <button className="ghost" onClick={onClose}>取消</button>
      </div>
    </div>
  );
}
