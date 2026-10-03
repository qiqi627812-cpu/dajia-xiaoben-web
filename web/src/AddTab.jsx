// AddTab.jsx — 记一笔（FOCUS 面板内）
// 默认「描述一笔」；另有「上传小票」「手动填写」。
// AI 单请求在途：等待期间禁止重复提交；8s 后可取消；取消/超时保留全部输入；
// 迟到结果不覆盖新输入（请求序号守卫）。图片先压缩再上传。
import React, { useState, useRef, useEffect } from "react";
import { api, fmtMoney, yuanToMinor } from "./api";
import EntryForm from "./EntryForm";

const MODES = [
  { key: "ai", label: "描述一笔" },
  { key: "photo", label: "上传小票" },
  { key: "manual", label: "手动填写" },
];
const SLOW_MS = 8000;      // 8s 后提示可取消
const FRONT_TIMEOUT = 30000; // 前端超时 30s（后端 25s 会先回）

export default function AddTab({ members, profile, refresh, toast, onSaved, prefill, initialMode, active, onRequestAddMember, autoSelectId, onCurrenciesChanged }) {
  const [mode, setMode] = useState(initialMode || "ai");
  const [text, setText] = useState(prefill || "");
  const [photo, setPhoto] = useState(null);   // { base64, mime, name }
  const [aiState, setAiState] = useState("idle"); // idle|busy|draft|error|not_configured|check_failed
  const [aiMsg, setAiMsg] = useState("");
  const [slow, setSlow] = useState(false);    // 超过 8s
  const [draft, setDraft] = useState(null);
  const [autoSave,setAutoSave] = useState(true);
  const [formKey, setFormKey] = useState(0);
  const fileInput = useRef(null);
  const abortRef = useRef(null);              // 在途请求的 AbortController
  const reqSeq = useRef(0);                   // 请求序号：迟到结果作废
  const slowTimer = useRef(null);
  const timeoutTimer = useRef(null);
  const textKeep = useRef("");

  /* 宿主指定的预填/入口模式（prop 变化时生效，不清空已有草稿） */
  useEffect(() => {
    if (prefill) { setText((t) => (t ? t : prefill)); setMode("ai"); }
  }, [prefill]);
  useEffect(() => {
    if (initialMode) setMode(initialMode);
  }, [initialMode]);

  /* ---- AI 配置状态探测（可重复、带节流、无定时轮询） ----
     - 进入本面板（active=true）即查（5s 节流防抖）；
     - 窗口重新可见且上次是失败/未配置时按 60s 间隔查；
     - banner 提供「重新检查」手动触发；
     - 区分「确认未配置」（configured:false）与「检查失败」（网络/服务异常）；
     - 探测结果只影响提示横幅，不拦截提交——提交永远以服务端真实响应为准。 */
  const probeSeq = useRef(0);
  const lastProbeAt = useRef(0);
  const probeAI = useRef();
  probeAI.current = () => {
    const mySeq = ++probeSeq.current;
    lastProbeAt.current = Date.now();
    api.aiStatus().then((r) => {
      if (probeSeq.current !== mySeq) return;
      if (r && r.configured === false) {
        setAiState((s) => (s === "busy" || s === "draft" ? s : "not_configured"));
        setAiMsg("ARK_API_KEY 缺失，AI 功能停用；可先手动记账");
      } else {
        /* configured:true 或响应异常结构 → 撤掉未配置/检查失败横幅（真实可用性以下次实际调用为准） */
        setAiState((s) => (s === "not_configured" || s === "check_failed" ? "idle" : s));
        setAiMsg("");
      }
    }).catch(() => {
      if (probeSeq.current !== mySeq) return;
      setAiState((s) => (s === "busy" || s === "draft" ? s : "check_failed"));
      setAiMsg("AI 状态检查失败（服务无响应）");
    });
  };

  /* 挂载先探一次 */
  useEffect(() => { probeAI.current(); }, []);
  /* 每次进入面板刷新（5s 内不重复） */
  useEffect(() => {
    if (active && Date.now() - lastProbeAt.current > 5000) probeAI.current();
  }, [active]);
  /* 窗口重新可见：上次失败/未配置且距上次探测 > 60s 才查（不做定时轮询） */
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      const st = aiStateRef.current;
      if ((st === "not_configured" || st === "check_failed") &&
          Date.now() - lastProbeAt.current > 60000) probeAI.current();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
  const aiStateRef = useRef(aiState);
  aiStateRef.current = aiState;

  const clearTimers = () => {
    if (slowTimer.current) { clearTimeout(slowTimer.current); slowTimer.current = null; }
    if (timeoutTimer.current) { clearTimeout(timeoutTimer.current); timeoutTimer.current = null; }
    setSlow(false);
  };

  /* 小票压缩：长边 ≤1280、JPEG 0.82（票据文字可读优先） */
  const pickPhoto = (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    if (f.size > 6 * 1024 * 1024) { setAiMsg("图片超过 6MB，请压缩后重试"); setAiState("error"); return; }
    const url = URL.createObjectURL(f);
    const img = new Image();
    img.onload = () => {
      const MAX = 1280;
      const scale = Math.min(1, MAX / Math.max(img.width, img.height));
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(img.width * scale));
      c.height = Math.max(1, Math.round(img.height * scale));
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      const dataUrl = c.toDataURL("image/jpeg", 0.82);
      const comma = dataUrl.indexOf(",");
      setPhoto({ base64: dataUrl.slice(comma + 1), mime: "image/jpeg", name: f.name });
    };
    img.onerror = () => { URL.revokeObjectURL(url); setAiMsg("图片读取失败"); setAiState("error"); };
    img.src = url;
  };

  const runAi = async () => {
    setAiMsg("");
    if (aiState === "busy") return;              // 单请求在途：忽略重复提交
    if (mode === "ai" && !text.trim()) { setAiState("error"); setAiMsg("请先输入描述文字"); return; }
    if (mode === "photo" && !photo) { setAiState("error"); setAiMsg("请先选择小票图片"); return; }
    /* 提交以服务端实际响应为准：清掉旧的未配置/检查失败横幅，让服务器给新答案 */
    if (aiState === "not_configured" || aiState === "check_failed") setAiState("idle");
    textKeep.current = text;
    const mySeq = ++reqSeq.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setAiState("busy");
    slowTimer.current = setTimeout(() => setSlow(true), SLOW_MS);
    timeoutTimer.current = setTimeout(() => {
      if (reqSeq.current === mySeq) controller.abort("timeout");
    }, FRONT_TIMEOUT);
    try {
      const payload = mode === "ai" ? { text } : { imageBase64: photo.base64, mime: photo.mime };
      const r = await api.aiParse(payload, { signal: controller.signal });
      if (reqSeq.current !== mySeq) return;     // 迟到结果：丢弃
      clearTimers();
      if (r.draft?.createdMembers?.length) { await refresh(); toast(`已添加成员：${r.draft.createdMembers.join("、")}，可在成员页修改`); }
      const d=r.draft;
      if(d?.currencyAdded && onCurrenciesChanged) await onCurrenciesChanged();
      const canAuto=autoSave && d?.title && d?.date && d?.currency && d?.totalMinor>0 && d?.payerId && d?.participants?.length && (d.confidence ?? 0)>=0.9 && !(d.warnings||[]).some(w=>!w.startsWith('未写币种'));
      if(canAuto) {
        const result=await api.addEntry({...d,requestId:d.requestId,splits:d.splitSuggestion,categoryId:d.categoryId,source:'ai',fx:d.fx?{[d.fx.quote]:{...d.fx,from:d.currency,source:'manual',rateDate:d.date}}:{}});
        resetAi();await refresh();toast('已整理并入账，可在明细中修改或撤销');if(onSaved)onSaved(result.entry.id);return;
      }
      setDraft(r.draft);
      setAiState("draft");
      /* AI 识别出未加入常用的标准币种 → 服务端已自动加入，提示并刷新目录（全站可用） */
      if (r.draft && r.draft.currencyAdded && r.draft.currency) {
        toast(`已添加币种 ${r.draft.currency}（常用列表）`);
        if (onCurrenciesChanged) onCurrenciesChanged();
      }
    } catch (e) {
      if (reqSeq.current !== mySeq) return;     // 已被新请求取代
      clearTimers();
      abortRef.current = null;
      if (e.name === "AbortError" || e.aborted || /aborted/i.test(String(e.message || ""))) {
        setAiState("error");
        setAiMsg("请求已取消（输入已保留，可重试或手动填写）");
      } else if (e.status === 502 && e.payload && e.payload.status === "not_configured") {
        setAiState("not_configured");
        setAiMsg(e.payload.message || "AI 未配置");
      } else {
        setAiState("error");
        setAiMsg(e.message || "识别失败");
        setText(textKeep.current); // 保留用户输入
      }
    }
  };

  const cancelAi = () => {
    if (abortRef.current) { abortRef.current.abort("user"); }
  };

  const saveDraft = (entry) => {
    const conf = draft?.confidence ?? null;
    const warns = draft?.warnings || null;
    return api.addEntry({ ...entry, source: "ai", aiConfidence: conf, aiWarnings: warns })
      .then((r) => {
        resetAi();
        refresh();
        toast("已入账（AI 草稿确认）");
        if (onSaved) onSaved(r.entry.id);
      })
      .catch((e) => toast(`入账失败：${e.message}`, true));
  };

  const resetAi = () => {
    clearTimers();
    abortRef.current = null;
    reqSeq.current++;
    setAiState("idle"); setDraft(null); setAiMsg(""); setText("");
    setPhoto(null); if (fileInput.current) fileInput.current.value = "";
  };

  const draftToInitial = (d) => ({
    title: d.title || "",
    categoryId: d.categoryId,
    fx: d.fx ? {[d.fx.quote]: {...d.fx, from:d.currency, source:"manual", rateDate:d.date}} : {},
    date: d.date || new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Hong_Kong"}).format(new Date()),
    currency: d.currency || "",                 // AI 未能确定 → 空值强制确认（currencyText 提示）
    currencyText: d.currencyText || null,
    totalMinor: d.totalMinor != null ? d.totalMinor : null,
    totalYuan: d.totalMinor == null && d.totalYuan != null ? d.totalYuan : null,
    payerId: d.payerId != null ? d.payerId : null,
    payerName: d.payerName || "",
    participantIds: (d.participants || []).map((p) => p.id),
    splits: (d.splitSuggestion && d.splitSuggestion.length) ? d.splitSuggestion : null,
    note: null,
    items: d.items,
  });

  const busy = aiState === "busy";

  return (
    <section className="add-tab">
      <div className="seg big">
        {MODES.map((m) => (
          <button key={m.key} className={mode === m.key ? "on" : ""}
            disabled={busy}
            onClick={() => { setMode(m.key); setAiMsg(""); }}>{m.label}</button>
        ))}
      </div>

      {mode !== "manual" && <label className="auto-save-toggle"><input type="checkbox" checked={autoSave} onChange={e=>setAutoSave(e.target.checked)} disabled={busy}/>信息完整时自动入账 <span className="hint">有疑问时仍会请你核对，入账后可撤销</span></label>}
      {mode === "manual" && (
        <div className="card">
          <EntryForm key={formKey} members={members} profile={profile}
            onRequestAddMember={onRequestAddMember} autoSelectId={autoSelectId}
            onCurrencyAdded={(c) => { toast(`已添加币种 ${c.code}${c.name ? ` ${c.name}` : ""}`); if (onCurrenciesChanged) onCurrenciesChanged(); }}
            onSave={(entry) => api.addEntry(entry)
              .then((r) => {
                toast("已入账");
                setFormKey((k) => k + 1);
                refresh();
                if (onSaved) onSaved(r.entry.id);
              })
              .catch((e) => toast(`入账失败：${e.message}`, true))}
            submitLabel="入账" />
        </div>
      )}

      {mode === "ai" && (
        <div className="card ai-card">
          <label className="fld">
            <span>用一句话描述这笔账</span>
            <textarea rows="3" value={text} onChange={(e) => setText(e.target.value)}
              placeholder="例：昨天和yiyi吃饭，我付了100，平摊" />
          </label>
          <div className="form-actions">
            <button className="primary" onClick={runAi} disabled={busy}>
              {busy ? "AI 整理中…" : "让 AI 整理"}
            </button>
            {busy && slow && (
              <button className="ghost" onClick={cancelAi}>还在整理，可以取消</button>
            )}
          </div>
        </div>
      )}

      {mode === "photo" && (
        <div className="card ai-card">
          <label className="fld">
            <span>上传小票照片（自动压缩后识别）</span>
            <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp" onChange={pickPhoto} disabled={busy} />
          </label>
          {photo && <p className="hint">已选：{photo.name}（已压缩）</p>}
          <div className="form-actions">
            <button className="primary" onClick={runAi} disabled={busy || !photo}>
              {busy ? "AI 整理中…" : "识别小票"}
            </button>
            {busy && slow && (
              <button className="ghost" onClick={cancelAi}>还在整理，可以取消</button>
            )}
          </div>
        </div>
      )}

      {busy && !slow && <div className="ai-banner busy">AI 整理中…</div>}

      {(aiState === "not_configured" || aiState === "check_failed") && (
        <div className={`ai-banner ${aiState === "not_configured" ? "warn" : "err"}`}>
          <b>{aiState === "not_configured" ? "未配置" : "状态检查失败"}</b>：{aiMsg}
          <button type="button" className="banner-recheck" onClick={() => probeAI.current()}>重新检查</button>
        </div>
      )}

      {aiState === "error" && (
        <div className="ai-banner err"><b>识别失败</b>：{aiMsg}（输入已保留，可切「手动填写」）</div>
      )}

      {aiState === "draft" && draft && (
        <div className="card draft-card">
          <div className="draft-head">
            <b>待核对</b>
            {draft.confidence != null && <span className="conf">置信度 {(draft.confidence * 100).toFixed(0)}%</span>}
            {draft.warnings?.length > 0 && (
              <details className="warnings"><summary>AI 提示 {draft.warnings.length} 条</summary>
                <ul>{draft.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
              </details>
            )}
          </div>
          <p className="hint">AI 草稿，核对后确认入账：</p>
          <EntryForm key={draft.requestId || draft.title} autoSelectId={autoSelectId} initial={draftToInitial(draft)} members={members} profile={profile} onRequestAddMember={onRequestAddMember}
            onCurrencyAdded={(c) => { toast(`已添加币种 ${c.code}${c.name ? ` ${c.name}` : ""}`); if (onCurrenciesChanged) onCurrenciesChanged(); }}
            onSave={saveDraft} onCancel={resetAi} submitLabel="确认入账" />
        </div>
      )}
    </section>
  );
}
