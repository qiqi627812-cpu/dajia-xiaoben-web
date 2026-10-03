// App.jsx — 大家小本：统一状态机宿主层
// 权威状态：mode(closed|book|focus) / activePage / spreadIdx / tid
// 所有导航走唯一入口 navigate()；过期回调按 tid 作废；FOCUS 四页常驻挂载保草稿。
import React, { useEffect, useRef, useState, useCallback } from "react";
import { api, fmtMoney, catOf } from "./api";
import { applyCurrencies } from "./currencyMeta";
import AvatarPad from "./AvatarPad";
import AddTab from "./AddTab";
import LedgerTab from "./LedgerTab";
import SettleTab from "./SettleTab";
import MembersTab from "./MembersTab";
import Avatar from "./Avatar";
import accounting from "../../shared/accounting.cjs";

const SPREADS = [
  { left: "members", right: "add" },
  { left: "ledger", right: "settle" },
];
const SECTION_TITLE = { members: "成员", add: "记一笔", ledger: "明细", settle: "结算" };
const SECTION_SPREAD = { members: 0, add: 0, ledger: 1, settle: 1 };
const NAV_SECTION = { "成员": "members", "记一笔": "add", "明细": "ledger", "结算": "settle" };
const PAGE_BASIS_W = 480;
const PAGE_BASIS_H = 540;

function PageLayer({ quad, basisW = PAGE_BASIS_W, basisH = PAGE_BASIS_H, className, children }) {
  if (!quad) return null;
  const { tl, tr, bl } = quad;
  const a = (tr[0] - tl[0]) / basisW;
  const b = (tr[1] - tl[1]) / basisW;
  const c = (bl[0] - tl[0]) / basisH;
  const d = (bl[1] - tl[1]) / basisH;
  return (
    <div className={className} style={{
      position: "absolute", left: 0, top: 0, width: basisW, height: basisH,
      transform: `matrix(${a},${b},${c},${d},${tl[0]},${tl[1]})`,
      transformOrigin: "0 0",
    }}>{children}</div>
  );
}

/* 每币种净额 → 最多 max 条「谁给谁」建议（贪心配对，不分币种加总）；
   币种清单由账目动态推导（不再写死四币种） */
function settleLines(entries,max=3,members=[]) {
 return [...new Set(entries.map(e=>e.currency))].flatMap(currency=>accounting.settle(entries.filter(e=>e.currency===currency),members).transfers.map(t=>({...t,minor:t.amount,currency}))).slice(0,max);
}

export default function App() {
  /* ---- 权威状态（唯一来源） ---- */
  const [mode, setMode] = useState("closed");     // closed | book | focus
  const [activePage, setActivePage] = useState(null); // members|add|ledger|settle（仅 focus 有意义）
  const [spreadIdx, setSpreadIdx] = useState(0);
  const [miniReady, setMiniReady] = useState(false);  // 书处于完整展开姿态（book-open 后）
  const [quad, setQuad] = useState(null);
  const [profile, setProfile] = useState(null);
  const [members, setMembers] = useState([]);
  const [entries, setEntries] = useState([]);
  const [onboarding, setOnboarding] = useState(false);
  const [miniVisible, setMiniVisible] = useState(false); // 翻页动画期间短暂隐藏
  const [emph, setEmph] = useState(null);
  const [highlightId, setHighlightId] = useState(null);
  const [toastMsg, setToastMsg] = useState(null);
  const [currencies, setCurrencies] = useState(null);   // 币种目录（共享配置；null=加载中）

  /* 「＋ 添加成员」流：从记一笔进入成员页（草稿因面板常驻挂载自动保留） */
  const [addMemberCtx, setAddMemberCtx] = useState(null);  // { active: true }
  const [addReturnId, setAddReturnId] = useState(null);    // 新成员 id → EntryForm 自动勾选

  const iframeRef = useRef(null);
  const tidRef = useRef(0);
  const pendingRef = useRef(null);   // { tid, expect: 'book-open' }
  const modeRef = useRef(mode);
  const spreadRef = useRef(spreadIdx);
  const activeRef = useRef(activePage);
  modeRef.current = mode; spreadRef.current = spreadIdx; activeRef.current = activePage;

  const toast = useCallback((msg, isErr) => {
    setToastMsg({ msg, isErr });
    setTimeout(() => setToastMsg(null), 3200);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [p, m, e, c] = await Promise.all([api.getProfile(), api.getMembers(), api.getEntries(), api.getCurrencies()]);
      setProfile(p.profile);
      setMembers(m.members);
      setEntries(e.entries);
      applyCurrencies(c);
      setCurrencies(c);
    } catch (e2) {
      toast(`数据加载失败：${e2.message}`, true);
    }
  }, [toast]);

  /* 币种目录变化（添加币种/AI 自动加入）→ 重新拉取并全站生效 */
  const onCurrenciesChanged = useCallback(async () => {
    try {
      const c = await api.getCurrencies();
      applyCurrencies(c);
      setCurrencies(c);
    } catch { /* 静默：下次 refresh 兜底 */ }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  /* 功能页共享一个滚动容器；切页时总是从页首开始，避免上一页的
     scrollTop 让新页面标题和首个操作入口被裁掉。 */
  useEffect(() => {
    if (mode !== "focus" || !activePage) return;
    const body = document.querySelector(".focus-body");
    if (body) body.scrollTo({ top: 0, behavior: "instant" });
  }, [mode, activePage]);

  const stage1 = () => {
    try { return iframeRef.current?.contentWindow?.__stage1 || null; } catch { return null; }
  };
  const bookPhase = () => {
    const s = stage1();
    if (!s) return "unknown";
    try { return typeof s.phase === "function" ? s.phase() : s.phase; } catch { return "unknown"; }
  };
  const postToBook = (msg) => {
    try { iframeRef.current?.contentWindow?.postMessage({ ...msg, tid: msg.tid ?? tidRef.current }, "*"); } catch { /* 忽略 */ }
  };

  const readQuad = useCallback(() => {
    try {
      const q = iframeRef.current?.contentWindow?.__stage1?.pageQuad?.();
      if (q) setQuad(q);
      return q;
    } catch { return null; }
  }, []);

  const emphasize = useCallback((side) => {
    setEmph({ side, key: Date.now() });
    setTimeout(() => setEmph(null), 900);
  }, []);

  /* ---- 唯一导航入口：最后一次点击生效 ---- */
  const navigate = useCallback((target) => {
    const tid = ++tidRef.current;
    pendingRef.current = null;
    setMiniVisible(false);

    if (target.type === "focus") {
      setMode("focus");
      setActivePage(target.page);
      postToBook({ type: "djbk:focus", on: true, tid });
      return;
    }
    if (target.type === "book") {
      const ph = bookPhase();
      setMode("book");
      setActivePage(null);
      postToBook({ type: "djbk:focus", on: false, tid });
      if (ph === "open") {
        setMiniReady(true);
        setMiniVisible(true);
        setTimeout(readQuad, 60);
      } else {
        /* 闭合/打开中：命令开书，姿势到位（book-open 事件）后才显示预览 */
        setMiniReady(false);
        pendingRef.current = { tid, expect: "book-open" };
        const s1 = stage1();
        if (ph === "closed" && s1) s1.open();
        else postToBook({ type: "djbk:open", tid });
      }
      return;
    }
    if (target.type === "closed") {
      setMode("closed");
      setActivePage(null);
      setMiniReady(false);
      setQuad(null);
      const s1 = stage1();
      if (bookPhase() === "open" && s1) s1.close();
      else postToBook({ type: "djbk:close", tid });
    }
  }, [readQuad]);

  /* ---- ＋添加成员（来自记一笔）：跳成员页，保存后带 id 回记账 ---- */
  const requestAddMember = useCallback(() => {
    setAddMemberCtx({ active: true });
    setMode("focus");
    setActivePage("members");
    postToBook({ type: "djbk:focus", on: true, tid: ++tidRef.current });
  }, []);

  const finishAddMember = useCallback((memberId) => {
    setAddReturnId(String(memberId));
    setAddMemberCtx(null);
    setMode("focus");
    setActivePage("add");
    postToBook({ type: "djbk:focus", on: true, tid: ++tidRef.current });
    toast("已添加并勾选为参与人");
  }, [toast]);

  const cancelAddMember = useCallback(() => {
    setAddMemberCtx(null);
    setMode("focus");
    setActivePage("add");
    postToBook({ type: "djbk:focus", on: true, tid: ++tidRef.current });
  }, []);

  /* ---- 顶部导航点击规则 ---- */
  const onNav = useCallback((nav) => {
    if (nav === "账本") {
      if (modeRef.current === "book" && !pendingRef.current) return; // 重复点击：保持，不重置
      navigate({ type: "book" });
      return;
    }
    const section = NAV_SECTION[nav];
    if (!section) return;
    if (modeRef.current === "focus" && activeRef.current === section) return; // 重复点击：保持
    setAddMemberCtx(null);   // 顶部普通入口进入成员页 = 普通成员管理流程
    navigate({ type: "focus", page: section });
  }, [navigate]);

  /* ---- 书内事件（核对来源窗口 + tid） ---- */
  useEffect(() => {
    const onMsg = (e) => {
      const w = iframeRef.current?.contentWindow;
      if (!w || e.source !== w) return;      // 只信自家 iframe
      const d = e.data || {};
      const cur = tidRef.current;
      switch (d.type) {
        case "djbk:book-open": {
          if (pendingRef.current && pendingRef.current.tid !== cur) { pendingRef.current = null; return; }
          const wasPending = pendingRef.current?.expect === "book-open";
          pendingRef.current = null;
          if (modeRef.current === "focus") return;     // 已切走：过期事件
          setMode("book");
          setActivePage(null);
          setMiniReady(true);
          setMiniVisible(true);
          setOnboarding((ob) => (profile ? false : !ob ? true : ob));
          setTimeout(() => { readQuad(); if (wasPending && pendingNavRef.current) { /* 保留旧语义 */ } }, 60);
          break;
        }
        case "djbk:book-closed": {
          if (modeRef.current === "focus") return;
          setMode("closed");
          setActivePage(null);
          setMiniReady(false);
          setMiniVisible(false);
          setQuad(null);
          break;
        }
        case "djbk:book-ready": {
          /* 引擎刚就绪：补发导航选中态（初始 useEffect 早于 iframe 监听器注册） */
          const nav = (modeRef.current === "focus" && activeRef.current)
            ? (Object.keys(NAV_SECTION).find((k) => NAV_SECTION[k] === activeRef.current) || "账本")
            : "账本";
          postToBook({ type: "djbk:nav-active", nav });
          break;
        }
        case "djbk:nav":
          onNav(d.nav);
          break;
        case "djbk:arrow": {
          if (modeRef.current !== "book") return;
          const next = spreadRef.current + d.dir;
          if (next < 0 || next >= SPREADS.length) return;
          const s1 = stage1();
          if (s1) s1.flipBook(d.dir);
          break;
        }
        case "djbk:flip-start":
          if (modeRef.current !== "book") return;
          setMiniVisible(false);
          break;
        case "djbk:flip-done": {
          if (modeRef.current !== "book") return;
          setSpreadIdx((i) => Math.min(Math.max(i + d.dir, 0), SPREADS.length - 1));
          setTimeout(() => { if (modeRef.current === "book") { readQuad(); setMiniVisible(true); } }, 100);
          break;
        }
        default:
          break;
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [profile, onNav, readQuad]);

  const pendingNavRef = useRef(null);

  /* 箭头可用性同步 */
  useEffect(() => {
    postToBook({ type: "djbk:arrows", prev: spreadIdx > 0, next: spreadIdx < SPREADS.length - 1 });
  }, [spreadIdx, mode]);

  /* 导航选中态同步（由统一状态推导，与悬停/焦点无关）：
     CLOSED / BOOK → 账本；FOCUS → 对应功能页 */
  useEffect(() => {
    let nav = "账本";
    if (mode === "focus" && activePage) {
      nav = Object.keys(NAV_SECTION).find((k) => NAV_SECTION[k] === activePage) || "账本";
    }
    postToBook({ type: "djbk:nav-active", nav });
  }, [mode, activePage]);

  useEffect(() => {
    const onResize = () => { if (mode === "book") readQuad(); };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [mode, readQuad]);

  /* 入账成功：FOCUS 内直接跳明细并高亮 */
  const onEntrySaved = useCallback((entryId) => {
    refresh();
    setHighlightId(String(entryId));
    setTimeout(() => setHighlightId(null), 4500);
    if (modeRef.current === "focus") setActivePage("ledger");
  }, [refresh]);

  /* 回到书页：返回对应预览组（成员/记一笔→第一组；明细/结算→第二组） */
  const backToBook = useCallback(() => {
    const page = activeRef.current;
    const want = page ? SECTION_SPREAD[page] : spreadRef.current;
    if (modeRef.current === "book") return;
    if (want !== spreadRef.current) {
      setSpreadIdx(want);
      postToBook({ type: "djbk:arrows", prev: want > 0, next: want < SPREADS.length - 1 });
    }
    navigate({ type: "book" });
  }, [navigate]);

  const spread = SPREADS[spreadIdx];
  const showMini = mode === "book" && miniReady && miniVisible && quad && !onboarding;
  const focusVisible = mode === "focus" && activePage;

  return (
    <div className="app-root">
      <iframe ref={iframeRef} className="book-frame" src="book/book.html" title="大家小本" allow="fullscreen" />

      {/* BOOK：双页实时预览（mode=book 且展开姿态到位才显示） */}
      {showMini && (
        <div className="mini-layer">
          <PageLayer quad={quad.left} className={`mini-page${emph?.side === "left" ? " emph" : ""}`}>
            <MiniSection section={spread.left} key={`l${spreadIdx}`}
              members={members} entries={entries} profile={profile}
              onOpen={(extra) => navigate({ type: "focus", page: spread.left, extra })} />
          </PageLayer>
          <PageLayer quad={quad.right} className={`mini-page${emph?.side === "right" ? " emph" : ""}`}>
            <MiniSection section={spread.right} key={`r${spreadIdx}`}
              members={members} entries={entries} profile={profile}
              onOpen={(extra) => navigate({ type: "focus", page: spread.right, extra })} />
          </PageLayer>
        </div>
      )}

      {/* BOOK：合上小本（仅 BOOK 提供） */}
      {mode === "book" && (
        <button className="close-book" onClick={() => navigate({ type: "closed" })}>合上小本</button>
      )}

      {/* 首访引导 */}
      {mode === "book" && onboarding && miniReady && (
        <div className="onboard-wrap">
          <OnboardingCard onDone={async (nickname, avatar) => {
            try {
              await api.putProfile(nickname, avatar);
              await refresh();
              setOnboarding(false);
              toast("小本准备好了，先把这次一起记账的朋友添加进来吧");
              navigate({type:"focus",page:"members"});
            } catch (e) { toast(`保存失败：${e.message}`, true); }
          }} />
        </div>
      )}

      {/* FOCUS：居中大操作面板；四页常驻挂载（隐藏不卸载）→ 草稿保留 */}
      <div className={`focus-layer${focusVisible ? "" : " is-hidden"}`} aria-hidden={!focusVisible}>
        <div className="focus-panel">
          <header className="focus-head">
            <div><h2>{SECTION_TITLE[activePage] || "大家小本"}</h2></div>
            <button className="back-btn" onClick={backToBook}>← 回到书页</button>
          </header>
          <div className="focus-body">
            <div className={`fp-page${activePage === "members" ? " on" : ""}`}>
              <MembersTab members={members} refresh={refresh} toast={toast}
                profile={profile} onCurrenciesChanged={onCurrenciesChanged}
                addReturn={!!(addMemberCtx && addMemberCtx.active)}
                onAdded={finishAddMember}
                onExitAddReturn={cancelAddMember} />
            </div>
            <div className={`fp-page${activePage === "add" ? " on" : ""}`}>
              <AddTab members={members} profile={profile}
                refresh={refresh} toast={toast} onSaved={onEntrySaved}
                active={activePage === "add"}
                onRequestAddMember={requestAddMember}
                autoSelectId={addReturnId}
                onCurrenciesChanged={onCurrenciesChanged} />
            </div>
            <div className={`fp-page${activePage === "ledger" ? " on" : ""}`}>
              <LedgerTab entries={entries} members={members} profile={profile}
                refresh={refresh} toast={toast} highlight={highlightId} />
            </div>
            <div className={`fp-page${activePage === "settle" ? " on" : ""}`}>
              <SettleTab entries={entries} members={members} refresh={refresh} toast={toast} />
            </div>
          </div>
        </div>
      </div>

      {toastMsg && <div className={`toast${toastMsg.isErr ? " err" : ""}`}>{toastMsg.msg}</div>}
    </div>
  );
}

/* ================= 书页预览（唯一一套；不可输入，点击进入 FOCUS） ================= */
function MiniSection({ section, members, entries, profile, onOpen }) {
  void profile;
  const active = members.filter((m) => m.active);
  const month = (() => {
    const d = new Date();
    return `${d.getFullYear()}年${d.getMonth() + 1}月`;
  })();

  const inner = () => {
    switch (section) {
      case "members": {
        const shown = active.slice(0, 6);
        const layout = shown.length <= 1 ? "one" : shown.length <= 4 ? "two" : "three";
        return (
          <>
            <h4 className="mp-title">成员</h4>
            <div className={`mp-figures ${layout}`}>
              {shown.map((m) => (
                <div key={m.id} className="mp-fig">
                  <Avatar name={m.name} src={m.avatar} size={layout === "one" ? 104 : layout === "two" ? 84 : 68} me={m.is_self} />
                  <span className="mp-fig-name">{m.name}</span>
                </div>
              ))}
            </div>
            {active.length > 6 && <div className="mp-more">共 {active.length} 位成员</div>}
            <div className="mp-entry" onClick={(e) => { e.stopPropagation(); onOpen(); }}>管理成员 →</div>
          </>
        );
      }
      case "add":
        return (
          <>
            <h4 className="mp-title">记一笔</h4>
            <div className="mp-chips">
              <button className="mp-chip" onClick={(e) => { e.stopPropagation(); onOpen(); }}>描述一笔</button>
              <button className="mp-chip" onClick={(e) => { e.stopPropagation(); onOpen(); }}>上传小票</button>
            </div>
            <div className="mp-recent">
              {entries.slice(0, 2).map((e2) => (
                <div key={e2.id} className="mp-row">
                  <span>{e2.title}</span><b>{fmtMoney(e2.totalMinor, e2.currency)}</b>
                </div>
              ))}
              {entries.length === 0 && <div className="mp-row"><span className="mp-dim">还没有账目</span></div>}
            </div>
          </>
        );
      case "ledger":
        return (
          <>
            <h4 className="mp-title">明细 <small>{month}</small></h4>
            <div className="mp-recent">
              {entries.slice(0, 4).map((e2) => {
                const c = catOf(e2.categoryId);
                return (
                  <div key={e2.id} className="mp-row">
                    <span><i className="mp-cat" style={{ background: `${c.color}44` }}>{c.icon}</i>{e2.date.slice(5)} {e2.title}</span>
                    <b>{fmtMoney(e2.totalMinor, e2.currency)}</b>
                  </div>
                );
              })}
              {entries.length === 0 && <div className="mp-row"><span className="mp-dim">还没有账目</span></div>}
            </div>
            <div className="mp-entry" onClick={(e) => { e.stopPropagation(); onOpen(); }}>查看全部 →</div>
          </>
        );
      case "settle": {
        const lines = settleLines(entries, 3);
        return (
          <>
            <h4 className="mp-title">结算</h4>
            <div className="mp-recent">
              {lines.map((l, i) => (
                <div key={i} className="mp-row">
                  <span>{l.from} → {l.to}</span>
                  <b>{fmtMoney(l.minor, l.currency)}</b>
                </div>
              ))}
              {lines.length === 0 && <div className="mp-row"><span className="mp-dim">记一笔后查看结算</span></div>}
            </div>
          </>
        );
      }
      default:
        return null;
    }
  };

  return (
    <div className="mini-inner" onClick={() => onOpen()} role="button"
      tabIndex={0} aria-label={`打开${SECTION_TITLE[section]}页面`}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(); } }}>
      {inner()}
    </div>
  );
}

/* 首次进入：昵称 + 手绘头像 */
function OnboardingCard({ onDone }) {
  const [nickname, setNickname] = useState("");
  const [avatar, setAvatar] = useState(null);
  const [err, setErr] = useState("");

  const submit = (e) => {
    e.preventDefault();
    if (!nickname.trim()) { setErr("先写个昵称吧"); return; }
    onDone(nickname.trim(), avatar);
  };

  return (
    <form className="onboard-card" onSubmit={submit}>
      <h2>我是谁？</h2>
      <label className="fld">
        <span>昵称</span>
        <input autoFocus value={nickname} onChange={(e) => setNickname(e.target.value)} placeholder="如：qiqi" maxLength={20} />
      </label>
      <AvatarPad onChange={setAvatar} />
      {err && <p className="form-err">{err}</p>}
      <button className="primary" type="submit">开始记账</button>
    </form>
  );
}
