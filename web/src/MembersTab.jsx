// MembersTab.jsx — 成员管理：人物卡片 + 新增 / 编辑（改名 + 手绘头像）/ 停用（确认框内说明）
// addReturn 模式：从「记一笔 → ＋添加成员」进入，「添加后返回记账」为主按钮，
// 保存成功后回记账并自动勾选新成员；重名时可选「使用已有成员」。
import React, { useState, useEffect, useRef } from "react";
import { api } from "./api";
import AvatarPad from "./AvatarPad";
import Avatar from "./Avatar";
import CurrencyPicker from "./CurrencyPicker";

export default function MembersTab({ members, refresh, toast, addReturn, onAdded, onExitAddReturn, profile, onCurrenciesChanged }) {
  const [name, setName] = useState("");
  const [showAdd,setShowAdd]=useState(false);
  useEffect(()=>{if(addReturn)setShowAdd(true);},[addReturn]);
  const [avatar, setAvatar] = useState(null);
  const [editing, setEditing] = useState(null);   // { member, name, avatar }
  const [busy, setBusy] = useState(false);
  const [dup, setDup] = useState(null);           // 重名提示 { name, existing }
  const [confirmOff, setConfirmOff] = useState(null); // 停用确认 { member }
  const addRef = useRef(null);

  /* addReturn 模式：自动定位新增区域 */
  useEffect(() => {
    if (addReturn && addRef.current) {
      addRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
      const inp = addRef.current.querySelector("input");
      if (inp) setTimeout(() => inp.focus({ preventScroll: true }), 350);
    }
  }, [addReturn]);

  const active = members.filter((m) => m.active);

  const add = async (e) => {
    e.preventDefault();
    const nm = name.trim();
    if (!nm || busy) return;
    setBusy(true);
    try {
      const r = await api.addMember(nm, avatar);
      setShowAdd(false);
      setName("");
      setAvatar(null);
      toast("成员已添加");
      refresh();
      if (addReturn && onAdded) onAdded(r.member.id);   // 回记账并勾选
    } catch (e2) {
      if (e2.status === 409) {
        const existing = members.find((m) => m.name === nm);
        setDup({ name: nm, existing });
      } else {
        toast(e2.message, true);
      }
    }
    setBusy(false);
  };

  const useExisting = () => {
    if (dup && dup.existing) {
      if (addReturn && onAdded) onAdded(dup.existing.id);
      else toast(`「${dup.existing.name}」已在成员列表`);
    }
    setDup(null);
    setName("");
  };

  const startEdit = (m) => setEditing({ member: m, name: m.name, avatar: null });

  const saveEdit = async () => {
    if (!editing || !editing.name.trim()) { toast("昵称不能为空", true); return; }
    try {
      const patch = { name: editing.name.trim() };
      if (editing.avatar) patch.avatar = editing.avatar;
      await api.patchMember(editing.member.id, patch);
      toast("已保存（新账目将使用新昵称，历史账目保留原快照）");
      setEditing(null);
      refresh();
    } catch (e) {
      if (e.status === 409) toast("该名字已被占用，请换一个", true);
      else toast(e.message, true);
    }
  };

  const toggleActive = async (m) => {
    try {
      await api.patchMember(m.id, { active: !m.active });
      toast(m.active ? `已停用 ${m.name}（历史账目不受影响）` : `已启用 ${m.name}`);
      setConfirmOff(null);
      refresh();
    } catch (e) { toast(e.message, true); }
  };

  return (
    <section className="members-tab">
      <div className="section-intro"><div className="section-label"><div><h3>成员</h3><p>{active.length} 位成员</p></div><button className="primary" onClick={()=>setShowAdd(true)}>＋ 添加成员</button></div></div>
      {!addReturn && (
        <div className="card ledger-settings">
          <h3>账本设置</h3>
          <div className="fld inline">
            <span>默认记账币种</span>
            <CurrencyPicker value={profile ? profile.default_currency : "CNY"} compact
              onCurrencyAdded={(c) => { toast(`已添加币种 ${c.code}${c.name ? ` ${c.name}` : ""}`); if (onCurrenciesChanged) onCurrenciesChanged(); }}
              onChange={async (code) => {
                try {
                  await api.putProfileCurrency(code);
                  toast(`默认记账币种已设为 ${code}（AI 未写币种时按此处理）`);
                  refresh();
                } catch (e) { toast(e.message, true); }
              }} />
          </div>
          <p className="hint">描述中未注明币种时，使用这里的默认币种；有歧义时会请你确认。</p>
        </div>
      )}

      {showAdd && <form className="card add-member" onSubmit={add} ref={addRef}>
        <h3>{addReturn ? "添加参与人" : "新成员"}</h3>
        {addReturn && <p className="hint">添加后直接回到记账，并自动勾选为参与人。草稿已保留。</p>}
        <label className="fld inline">
          <span>昵称</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="如：小满" maxLength={20} />
        </label>
        <label className="fld"><span>手绘头像（可选）</span></label>
        <AvatarPad onChange={setAvatar} />
        {avatar && <div className="ava-preview"><Avatar name={name || "?"} src={avatar} size={64} /><span className="hint">圆形预览</span></div>}
        <div className="form-actions">
          {addReturn ? (
            <>
              <button className="primary" disabled={busy || !name.trim()}>添加后返回记账</button>
              <button type="button" className="ghost" onClick={() => { if (onExitAddReturn) onExitAddReturn(); }}>取消，返回记账</button>
            </>
          ) : (
            <><button className="primary" disabled={busy || !name.trim()}>添加成员</button><button type="button" className="ghost" onClick={()=>setShowAdd(false)}>取消</button></>
          )}
        </div>
        {dup && (
          <div className="dup-box">
            <p>「{dup.name}」已是成员。重复创建会让账目分摊混乱。</p>
            <div className="form-actions">
              <button type="button" className="primary" onClick={useExisting}>
                {addReturn ? "使用已有成员并返回记账" : "使用已有成员"}
              </button>
              <button type="button" className="ghost" onClick={() => setDup(null)}>换个昵称</button>
            </div>
          </div>
        )}
      </form>}

      {editing && (
        <div className="card member-edit">
          <h3>编辑成员{editing.member.is_self ? "（我）" : ""}</h3>
          <div className="ava-preview">
            <Avatar name={editing.name} src={editing.avatar || editing.member.avatar} size={80} />
            <span className="hint">圆形预览（原图保留，可继续涂改）</span>
          </div>
          <label className="fld">
            <span>昵称{editing.member.is_self ? "（改名后当前登录者同步更新，历史账目仍用原快照）" : ""}</span>
            <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} maxLength={20} />
          </label>
          <label className="fld"><span>手绘头像（在原头像基础上继续涂改，或清空重画）</span></label>
          <AvatarPad initialSrc={editing.member.avatar || editing.avatar || undefined}
            onChange={(dataURL) => setEditing({ ...editing, avatar: dataURL })} />
          <div className="form-actions">
            <button className="primary" onClick={saveEdit}>保存</button>
            <button className="ghost" onClick={() => setEditing(null)}>取消</button>
            {!editing.member.is_self && editing.member.active && (
              <button className="danger" onClick={() => setConfirmOff(editing.member)}>停用</button>
            )}
            {!editing.member.is_self && !editing.member.active && (
              <button className="ghost" onClick={() => toggleActive(editing.member)}>启用</button>
            )}
          </div>
        </div>
      )}

      {confirmOff && (
        <div className="card confirm-card">
          <h3>停用 {confirmOff.name}？</h3>
          <p className="hint">停用后不出现在新账目的付款人/参与人选择里；历史账目保留当时的成员快照，统计与结算不受影响。可随时重新启用。</p>
          <div className="form-actions">
            <button className="danger" onClick={() => toggleActive(confirmOff)}>确认停用</button>
            <button className="ghost" onClick={() => setConfirmOff(null)}>取消</button>
          </div>
        </div>
      )}

      <div className="member-grid">
        {members.map((m) => (
          <div key={m.id} className={`member-card${m.active ? "" : " off"}`}>
            <Avatar name={m.name} src={m.avatar} size={80} me={m.is_self && m.active} />
            <b className="m-name">{m.name}{!m.active && <span className="badge-off">已停用</span>}</b>
            <div className="m-ops">
              <button onClick={() => startEdit(m)}>编辑</button>
              {!m.is_self && m.active && (
                <button className="danger-text" onClick={() => setConfirmOff(m)}>停用</button>
              )}
              {!m.is_self && !m.active && (
                <button onClick={() => toggleActive(m)}>启用</button>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
