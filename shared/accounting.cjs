// Shared integer accounting: identity uses IDs; FX rounds totals then allocates remainders.
function fraction(value) {
 const s=String(value); if(!/^\d+(\.\d+)?$/.test(s)) throw Error('Invalid decimal');
 const [a,b='']=s.split('.'); return [BigInt(a+b),10n**BigInt(b.length)];
}
function convert(minor, rate, sourceDecimals, targetDecimals) {
 const [n,d]=fraction(rate); const num=BigInt(minor)*n*10n**BigInt(targetDecimals); const den=d*10n**BigInt(sourceDecimals);
 const result=Number((num+den/2n)/den); if(!Number.isSafeInteger(result)) throw Error('Amount out of range');return result;
}
function allocate(total, splits, originalTotal) {
 const den=BigInt(originalTotal); const rows=splits.map((s,i)=> {const n=BigInt(s.minor)*BigInt(total);return {...s,minor:Number(n/den),remainder:n%den,index:i};});
 let rest=total-rows.reduce((a,s)=>a+s.minor,0);
 const order=[...rows].sort((a,b)=>a.remainder===b.remainder?a.index-b.index:a.remainder>b.remainder?-1:1);
 for(let i=0;i<rest;i++) order[i%order.length].minor++;
 return rows.map(({remainder,index,...s})=>s);
}
function identity(id,name) {return id!=null ? String(id) : 'legacy:'+String(name).replace(/\s/g,'').toLowerCase();}
function convertEntry(entry,target,decimals,rates={}) {
 const rate=entry.currency===target?1:entry.fx?.[target]?.rate || rates[entry.currency];
 if(!(Number(rate)>0)) return null;
 const totalMinor=convert(entry.totalMinor,rate,decimals(entry.currency),decimals(target));
 return {...entry,totalMinor,splits:allocate(totalMinor,entry.splits,entry.totalMinor),currency:target};
}
function settle(entries,members=[],repayments=[]) {
 const map=new Map(); const add=(id,name,paid=0,share=0,repaid=0)=>{const key=identity(id,name);let r=map.get(key);if(!r){const m=members.find(m=>String(m.id)===String(id));r={id,key,name:m?.name||name,paid:0,share:0,repaid:0};map.set(key,r);}r.paid+=paid;r.share+=share;r.repaid+=repaid;};
 for(const e of entries){add(e.payerId,e.payerName,e.totalMinor);for(const s of e.splits)add(s.id,s.name,0,Number(s.minor));}
 for(const r of repayments){add(r.from_id,'',0,0,Number(r.minor));add(r.to_id,'',0,0,-Number(r.minor));}
 const balances=[...map.values()].map(r=>({...r,net:r.paid-r.share+r.repaid}));
 const debtors=balances.filter(r=>r.net<0).map(r=>({...r,rest:-r.net}));const creditors=balances.filter(r=>r.net>0).map(r=>({...r,rest:r.net}));
 const transfers=[];let i=0,j=0;while(i<debtors.length&&j<creditors.length){const amount=Math.min(debtors[i].rest,creditors[j].rest);transfers.push({from:debtors[i].name,to:creditors[j].name,fromId:debtors[i].id,toId:creditors[j].id,amount});debtors[i].rest-=amount;creditors[j].rest-=amount;if(!debtors[i].rest)i++;if(!creditors[j].rest)j++;}
 return {balances,transfers};
}
module.exports={convert,allocate,identity,convertEntry,settle};
