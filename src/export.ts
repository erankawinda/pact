import type {Snapshot} from './api';
export function csvCell(value:unknown):string {
 let text=String(value??'');
 if(/^[\s]*[=+@-]/.test(text)||/^[\t\r\n]/.test(text))text="'"+text;
 return '"'+text.replaceAll('"','""')+'"';
}
export function ledgerCsv(snapshot:Snapshot):string {
 if(snapshot.expenses.length<snapshot.expense_count)throw new Error('The full history could not be loaded. Export was stopped to avoid an incomplete file.');
 const names=Object.fromEntries(snapshot.members.map(m=>[m.id,m.name]));
 const rows:unknown[][]=[['Type','ID','Date','Description','Paid by / Sender','Recipient','Amount AUD','Status','Related expense','Person','Share AUD','Note / Reason']];
 for(const e of snapshot.expenses){rows.push(['Expense',e.id,e.occurred_on,e.description,names[e.cash_actor_id],'',(e.amount_cents/100).toFixed(2),e.status,e.replaces_id,'','',e.note+' '+e.correction_reason]);for(const s of snapshot.shares.filter(s=>s.expense_id===e.id))rows.push(['Expense share',e.id,e.occurred_on,e.description,'','','',e.status,e.id,names[s.user_id],(s.share_cents/100).toFixed(2),'']);}
 for(const p of snapshot.payments)rows.push(['Repayment',p.id,p.occurred_on,'',names[p.sender_id],names[p.recipient_id],(p.amount_cents/100).toFixed(2),p.status,'','','',p.note+' '+p.reason]);
 for(const r of snapshot.refunds){rows.push(['Refund',r.id,r.created_at,'','','',(r.amount_cents/100).toFixed(2),r.status,r.expense_id,'','',r.reason]);for(const s of snapshot.refund_shares.filter(s=>s.refund_id===r.id))rows.push(['Refund share',r.id,r.created_at,'','','','',r.status,r.expense_id,names[s.user_id],(s.share_cents/100).toFixed(2),'']);}
 for(const b of snapshot.balances)rows.push(['Balance','','','','','',(b.cents/100).toFixed(2),'','',''+names[b.user_id],'','Positive = owed; negative = owes']);
 return '\ufeff'+rows.map(r=>r.map(csvCell).join(',')).join('\r\n');
}
export function download(name:string,content:string,type:string){const url=URL.createObjectURL(new Blob([content],{type}));const link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
