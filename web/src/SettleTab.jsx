import React,{useEffect,useState} from 'react';
import {api,fmtMoney} from './api';
import {decimalsOf} from './currencyMeta';
import accounting from '../../shared/accounting.cjs';
import Avatar from './Avatar';
import CurrencyPicker from './CurrencyPicker';
import {FxApplier} from './RateRow';
export default function SettleTab({entries,members,toast,refresh}) {
 const [unify,setUnify]=useState(false),[target,setTarget]=useState('CNY'),[repayments,setRepayments]=useState([]),[confirm,setConfirm]=useState(null),[busy,setBusy]=useState(false),[showFx,setShowFx]=useState(false);
 const load=()=>api.getRepayments().then(r=>setRepayments(r.repayments)).catch(e=>toast(e.message,true));
 useEffect(()=>{load();},[]);
 const groups=[...new Set(entries.map(e=>e.currency))].map(currency=>({currency,entries:entries.filter(e=>e.currency===currency)}));
 const converted=entries.map(e=>accounting.convertEntry(e,target,decimalsOf));
 const missing=entries.filter((e,i)=>!converted[i]);
 const panels=unify&&!missing.length?[{currency:target,entries:converted}]:groups;
 async function save(){setBusy(true);try {await api.addRepayment({...confirm,date:new Date().toLocaleDateString('en-CA'),requestId:crypto.randomUUID()});await load();setConfirm(null);toast('已记录转账，剩余待结算金额已更新');refresh();}catch(e){toast(e.message,true);}finally{setBusy(false);}}
 return <section className="settle-tab">
 <div className="section-intro"><h3>结算建议</h3></div>
 <div className="card settle-opts"><label className="switch"><input type="checkbox" checked={unify} onChange={e=>setUnify(e.target.checked)}/>统一折算预览</label>{unify&&<CurrencyPicker value={target} onChange={setTarget}/>}</div>
 {unify&&<p className="hint">使用与明细一致的已保存汇率。实际转账请关闭折算预览，按原币种记录；已有转账的剩余余额在原币种模式查看。</p>}
 {unify&&missing.length>0&&<div className="ai-banner warn">{missing.length} 笔待补齐历史汇率，暂按原币种显示。<button onClick={()=>setShowFx(true)}>补齐汇率</button></div>}
 {showFx&&missing.length>0&&<FxApplier pendingEntries={missing} target={target} refresh={refresh} toast={toast} onClose={()=>setShowFx(false)}/>}
 {!entries.length&&<div className="empty">还没有支出，记下第一笔后，这里会替你算好。</div>}
 {panels.map(g=>{const result=accounting.settle(g.entries,members,unify&&!missing.length?[]:repayments.filter(r=>r.currency===g.currency));return <div className="card settlement-card" key={g.currency}><div className="section-label"><h3>{g.currency}</h3><span className="hint">{g.entries.length} 笔</span></div><ul className="balance-list">{result.balances.map(b=><li key={b.key}><div className="st-row"><Avatar name={b.name} src={members.find(m=>String(m.id)===String(b.id))?.avatar} size={48}/><div><b>{b.name}</b><small className="hint">已付 {fmtMoney(b.paid,g.currency)} · 承担 {fmtMoney(b.share,g.currency)}</small></div></div><b className={b.net>0?'pos':b.net<0?'neg':''}>{b.net===0?'已结清':`${b.net>0?'应收':'应付'} ${fmtMoney(Math.abs(b.net),g.currency)}`}</b></li>)}</ul>{!result.transfers.length&&<p className="empty small">已经结清</p>}{result.transfers.map((t,i)=><div className="transfer-row transfer-action" key={i}><span><b>{t.from}</b> → <b>{t.to}</b></span><strong>{fmtMoney(t.amount,g.currency)}</strong>{!unify&&t.fromId&&t.toId&&<button className="glass-action" onClick={()=>setConfirm({fromId:t.fromId,toId:t.toId,minor:t.amount,currency:g.currency,from:t.from,to:t.to})}>标记已转账</button>}</div>)}</div>;})}
 {confirm&&<div className="confirm-overlay" role="dialog" aria-modal="true" aria-label="确认转账"><div className="card"><h3>确认已经完成转账？</h3><p>{confirm.from} → {confirm.to} · {fmtMoney(confirm.minor,confirm.currency)}</p><p className="hint">这里只记录转账，不会自动扣款。</p><div className="form-actions"><button disabled={busy} onClick={save}>确认记录</button><button disabled={busy} className="ghost" onClick={()=>setConfirm(null)}>取消</button></div></div></div>}
 {repayments.length>0&&<div className="card"><h3>已记录的转账</h3>{repayments.map(r=><div className="transfer-row" key={r.id}><span>{members.find(m=>String(m.id)===String(r.from_id))?.name} → {members.find(m=>String(m.id)===String(r.to_id))?.name}<small className="hint">{r.date}</small></span><b>{fmtMoney(r.minor,r.currency)}</b><button className="ghost" onClick={async()=>{try{await api.deleteRepayment(r.id);await load();toast('已撤销这次转账记录');}catch(e){toast(e.message,true);}}}>撤销记录</button></div>)}</div>}
 </section>;
}
