import {useState,type FormEvent} from 'react';
import {categoryLabel,type Group,type Payment,type Snapshot} from './api';
import {message} from './errors';
import {displayDate,money,parseMoney,settlementSuggestions,today} from './money';
import {Alert,Avatar,Icon,ScreenHeading} from './ui';
import type {Mutation,Prompt} from './actions';
import type {Route,Screen} from './navigation';
function paymentStatus(payment:Payment){return payment.status==='confirmed'?(payment.confirmation_method==='automatic'?'Settled automatically':'Confirmed received'):payment.status[0].toUpperCase()+payment.status.slice(1);}
export type Navigate=(screen:Screen,options?:Partial<Omit<Route,'screen'>>,replace?:boolean)=>void;
export type ViewProps={group:Group;snapshot:Snapshot;userId:string;online:boolean;mutation:Mutation;navigate:Navigate;ask:(prompt:Prompt)=>void};
export function BalanceSummary({snapshot,userId}:{snapshot:Snapshot;userId:string}){
 const cents=snapshot.balances.find(b=>b.user_id===userId)?.cents??0;
 const parts=new Intl.NumberFormat('en-AU',{style:'currency',currency:'AUD'}).formatToParts(Math.abs(cents)/100);
 const currency=parts.find(part=>part.type==='currency')?.value??'$';
 const whole=parts.filter(part=>part.type==='integer'||part.type==='group').map(part=>part.value).join('');
 const fraction=parts.filter(part=>part.type==='decimal'||part.type==='fraction').map(part=>part.value).join('');
 const size=whole.length>=10?' wide':whole.length>=7?' compact':'';
 return <div className="balance-summary">
  <div className="balance-copy"><span className="balance-label"><Icon name={cents>0?'arrow-down':cents<0?'arrow-up':'check'}/>{cents>0?'You are owed':cents<0?'You owe':'All settled up'}</span></div>
  <strong className={`balance-amount${size}`}><span className="currency">{currency}</span><span className="whole">{whole}</span><span className="cents">{fraction}</span></strong>
  <small className="balance-caption">{cents===0?'Nothing to settle in this group':'After settled repayments and refunds'}</small>
 </div>;
}
export function Home({group,snapshot,userId,online,navigate}:ViewProps){
 const needed=snapshot.shopping.filter(i=>i.status==='needed');
 const pending=snapshot.payments.filter(p=>p.status==='pending'&&p.recipient_id===userId);
 const names=Object.fromEntries(snapshot.members.map(member=>[member.id,member.name]));
 return <>
  <ScreenHeading title={group.kind==='trip'?'Your trip':'Your household'} subtitle="A little less to keep track of."/>
  <BalanceSummary snapshot={snapshot} userId={userId}/>
  <button className="primary full" disabled={!online||!!group.archived_at} onClick={()=>navigate('expense')}><Icon name="plus"/>Add expense</button>
  <div className="home-shortcuts">
   <button className="shortcut" onClick={()=>navigate('shopping')}><span className="shortcut-head"><Icon name="shopping"/><Icon name="arrow-up"/></span><strong>{needed.length} {needed.length===1?'thing':'things'}</strong><span>On the shopping list</span></button>
   <button className={`shortcut${pending.length?' needs-attention':''}`} onClick={()=>navigate('balances')}><span className="shortcut-head"><Icon name={pending.length?'clock':'check'}/><Icon name="arrow-up"/></span><strong>{pending.length?`${pending.length} to confirm`:'All clear'}</strong><span>{pending.length?'Check money received':'Nothing for you to confirm'}</span></button>
  </div>
  <section className="home-section"><div className="section-title"><h2>Recent expenses</h2><button className="text-button" onClick={()=>navigate('expenses')}>View all <Icon name="arrow"/></button></div>
   {snapshot.expenses.length?<div className="list-panel">{snapshot.expenses.slice(0,3).map(e=><button className="simple-row row-button activity-row" key={e.id} onClick={()=>navigate('expenses')}><span className="activity-icon"><Icon name={e.category==='groceries'?'shopping':'expense'}/></span><span className="activity-copy"><strong>{e.description}</strong><small>{e.cash_actor_id===userId?'You':names[e.cash_actor_id]??'A former member'} paid · {displayDate(e.occurred_on)}{e.status!=='posted'?' · Voided':''}</small></span><strong className="nowrap">{money(e.amount_cents)}</strong></button>)}</div>:<p className="muted">Your shared purchases will appear here.</p>}
  </section>
  <div className="home-links"><button onClick={()=>navigate('people')}><Icon name="people"/>People & trips</button><button onClick={()=>navigate('activity')}><Icon name="clock"/>Activity</button></div>
 </>;
}
export function Expenses({group,snapshot,userId,online,mutation,navigate,ask,loadMore}:{loadMore:()=>Promise<void>}&ViewProps){
 const [search,setSearch]=useState(''),[category,setCategory]=useState(''),[from,setFrom]=useState(''),[to,setTo]=useState('');
 const names=Object.fromEntries(snapshot.members.map(m=>[m.id,m.name]));const organiser=snapshot.members.some(m=>m.id===userId&&m.role==='organiser'&&m.status==='active');
 const blocked=!online||!!group.archived_at||mutation.busy||!!mutation.pending;
 const visible=snapshot.expenses.filter(e=>[e.description,categoryLabel(e.category),e.note,names[e.cash_actor_id]].join(' ').toLowerCase().includes(search.trim().toLowerCase())&&(!category||e.category===category)&&(!from||e.occurred_on>=from)&&(!to||e.occurred_on<=to));
 return <><ScreenHeading title="Expenses"><button className="primary" onClick={()=>navigate('expense')} disabled={blocked}><Icon name="plus"/>Add expense</button></ScreenHeading>{snapshot.expenses.length>0&&<><label className="search-field"><Icon name="search"/><span className="sr-only">Search expenses</span><input type="search" placeholder="Search expenses" value={search} onChange={e=>setSearch(e.target.value)}/></label><details className="filters"><summary>Filter by date or category</summary><div className="filter-grid"><label>From<input type="date" value={from} onChange={e=>setFrom(e.target.value)}/></label><label>To<input type="date" value={to} onChange={e=>setTo(e.target.value)}/></label><label>Category<select value={category} onChange={e=>setCategory(e.target.value)}><option value="">All categories</option>{['groceries','takeaway','household','travel','other'].map(c=><option key={c} value={c}>{categoryLabel(c)}</option>)}</select></label><button onClick={()=>{setSearch('');setFrom('');setTo('');setCategory('');}}>Clear filters</button></div></details></>}{!visible.length&&<div className="empty-state"><span className="empty-icon"><Icon name="expense"/></span><h2>{snapshot.expenses.length?'No matching expenses':'No expenses yet'}</h2><p>{snapshot.expenses.length?'Try another name, date or category.':'Add a purchase and choose exactly who shares it.'}</p></div>}<div className="expense-list">{visible.map(e=>{const share=snapshot.shares.find(s=>s.expense_id===e.id&&s.user_id===userId);const refunds=snapshot.refunds.filter(r=>r.expense_id===e.id);const totalRefund=refunds.filter(r=>r.status==='posted').reduce((s,r)=>s+r.amount_cents,0);const canEdit=organiser||e.created_by===userId;return <details className="expense-row" key={e.id}><summary><span className="expense-label"><strong>{e.description}</strong><small>{e.cash_actor_id===userId?'You':names[e.cash_actor_id]} paid · {displayDate(e.occurred_on)}</small><span className="expense-share">{e.status!=='posted'?'Voided · kept in history':share?`Your original share ${money(share.share_cents)}`:'You’re not in this split'}{totalRefund>0&&' · Refund recorded'}</span></span><span className="expense-total"><strong>{money(e.amount_cents)}</strong><Icon name="down"/></span></summary><div className="expense-detail"><div className="section-title"><h3>Original split</h3><span className="muted">{e.split_mode==='equal'?'Equally':'Custom amounts'}</span></div>{snapshot.shares.filter(s=>s.expense_id===e.id).map(s=><div className="amount-row" key={s.user_id}><span>{names[s.user_id]}{s.user_id===userId?' (you)':''}</span><strong>{money(s.share_cents)}</strong></div>)}{e.note&&<p>{e.note}</p>}<p className="helper">{categoryLabel(e.category)} · Added by {names[e.created_by]??'a former member'}</p>{e.replaces_id&&<p className="callout">Corrected expense: {e.correction_reason}</p>}{refunds.map(r=><div className="refund-card" key={r.id}><div className="amount-row"><strong>{r.status==='posted'?'Refund':'Undone refund'}</strong><strong>{money(r.amount_cents)}</strong></div><p className="helper">{r.reason}</p>{r.status==='posted'&&<>{snapshot.refund_shares.filter(s=>s.refund_id===r.id).map(s=><div className="amount-row small" key={s.user_id}><span>{names[s.user_id]}</span><span>{money(s.share_cents)} returned</span></div>)}{(organiser||r.created_by===userId)&&<button className="text-button" disabled={blocked} onClick={()=>ask({title:'Undo this refund?',description:'The refund will be reversed in everyone’s balance. Its history is kept.',button:'Undo refund',reason:true,run:({reason})=>mutation.run('void_refund',{p_group:group.id,p_refund:r.id,p_reason:reason},'Undo refund')})}>Undo refund</button>}</>}</div>)}{canEdit&&e.status==='posted'&&<div className="inline-actions"><button disabled={blocked||totalRefund>0} onClick={()=>navigate('expense',{edit:e.id})}>Correct expense</button><button disabled={blocked||totalRefund>=e.amount_cents} onClick={()=>ask({title:'Record a refund',description:'Use this after the shop returns money to the original payer. Pact returns each person’s remaining share proportionally.',button:'Record refund',reason:true,amount:((e.amount_cents-totalRefund)/100).toFixed(2),run:({reason,amount})=>mutation.run('refund_expense',{p_group:group.id,p_expense:e.id,p_amount:parseMoney(amount),p_reason:reason},'Record refund')})}>Record refund</button><button className="text-button danger" disabled={blocked||totalRefund>0} onClick={()=>ask({title:'Void this expense?',description:'Remove its effect on balances. The original expense stays in history.',button:'Void expense',reason:true,run:({reason})=>mutation.run('void_expense',{p_group:group.id,p_expense:e.id,p_version:e.version,p_reason:reason},'Void expense')})}>Void expense</button></div>}{canEdit&&totalRefund>0&&<p className="helper">Undo the refunds before correcting or voiding this expense.</p>}</div></details>;})}</div>{snapshot.expenses.length<snapshot.expense_count&&<div className="load-more"><p className="helper">Showing {snapshot.expenses.length} of {snapshot.expense_count}. Filters apply to loaded expenses.</p><button onClick={()=>void loadMore()}>Load more expenses</button></div>}</>;
}
export function Balances({group,snapshot,userId,online,mutation,navigate,ask}:ViewProps){
 const names=Object.fromEntries(snapshot.members.map(m=>[m.id,m.name]));const organiser=snapshot.members.some(m=>m.id===userId&&m.role==='organiser');const blocked=!online||!!group.archived_at||mutation.busy||!!mutation.pending;
 let suggestions:ReturnType<typeof settlementSuggestions>=[],error='';try{suggestions=settlementSuggestions(snapshot.balances);}catch(e){error=message(e);}
 const pending=snapshot.payments.filter(p=>p.status==='pending');
 return <><ScreenHeading title="Balances"/><BalanceSummary snapshot={snapshot} userId={userId}/><div className="repayment-actions"><button className="primary full" onClick={()=>navigate('payment')} disabled={blocked}><Icon name="arrow-up"/>I paid</button><button className="full" onClick={()=>navigate('payment',{direction:'received'})} disabled={blocked}><Icon name="arrow-down"/>I received</button></div><p className="helper repayment-help">Pay outside Pact, then record it here. Payments settle immediately unless the recipient requires approval.</p><Alert text={error}/>{pending.length>0&&<section className="home-section pending-payments"><div className="section-title"><h2>Waiting for confirmation</h2><span className="count-badge">{pending.length}</span></div><div className="list-panel">{pending.map(p=><div className="payment-card" key={p.id}><div className="amount-row"><strong>{names[p.sender_id]} → {names[p.recipient_id]}</strong><strong>{money(p.amount_cents)}</strong></div><p className="helper">{displayDate(p.occurred_on)}{p.note&&` · ${p.note}`} · Not included in balances yet</p><div className="inline-actions">{p.recipient_id===userId&&<><button className="primary" disabled={blocked} onClick={()=>ask({title:'Have you received this money?',description:`Confirm you received ${money(p.amount_cents)} from ${names[p.sender_id]}.`,button:'Confirm received',run:()=>mutation.run('payment_action',{p_group:group.id,p_payment:p.id,p_action:'confirm',p_version:p.version,p_reason:''},'Confirm repayment')})}>Confirm received</button><button disabled={blocked} onClick={()=>ask({title:'Reject this repayment?',description:'Its status will show as rejected. Balances stay unchanged.',button:'Reject repayment',reason:true,run:({reason})=>mutation.run('payment_action',{p_group:group.id,p_payment:p.id,p_action:'reject',p_version:p.version,p_reason:reason},'Reject repayment')})}>Reject</button></>}{p.sender_id===userId&&<button disabled={blocked} onClick={()=>ask({title:'Cancel this record?',description:'Balances have not changed. Cancel only the repayment record, not a bank transfer.',button:'Cancel record',run:()=>mutation.run('payment_action',{p_group:group.id,p_payment:p.id,p_action:'cancel',p_version:p.version,p_reason:''},'Cancel repayment')})}>Cancel record</button>}</div></div>)}</div></section>}{suggestions.length>0&&<section className="home-section"><h2>Suggested repayments</h2><p className="helper">One way to settle the group. Check pending repayments before paying again.</p><div className="list-panel">{suggestions.map(s=><div className="payment-card" key={s.from+s.to}><div className="amount-row"><span>{names[s.from]} → {names[s.to]}</span><strong>{money(s.cents)}</strong></div>{s.from===userId&&snapshot.members.some(m=>m.id===s.to&&m.status==='active')&&<button className="text-button" disabled={blocked} onClick={()=>navigate('payment',{to:s.to,amount:(s.cents/100).toFixed(2)})}>I’ve paid this</button>}{s.to===userId&&snapshot.members.some(m=>m.id===s.from&&m.status==='active')&&<button className="text-button" disabled={blocked} onClick={()=>navigate('payment',{direction:'received',to:s.from,amount:(s.cents/100).toFixed(2)})}>I received this</button>}</div>)}</div></section>}<section className="home-section"><div className="section-title"><h2>Everyone</h2><span className="helper">{snapshot.members.length} {snapshot.members.length===1?'person':'people'}</span></div><div className="list-panel">{snapshot.members.map(m=>{const cents=snapshot.balances.find(b=>b.user_id===m.id)?.cents??0;return <div className={`person-row${m.id===userId?' is-you':''}`} key={m.id}><Avatar name={m.name} userId={m.status==='active'?m.id:undefined}/><span className="person-name">{m.name}<small>{m.id===userId?'You':m.status==='revoked'?'Former member':''}</small></span><span className="person-balance"><strong>{money(Math.abs(cents))}</strong><small>{cents>0?'is owed':cents<0?'owes':'settled up'}</small></span></div>;})}</div></section>{snapshot.payments.some(p=>p.status!=='pending')&&<details className="history-section"><summary>Repayment history</summary>{snapshot.payments.filter(p=>p.status!=='pending').map(p=><div className="payment-card" key={p.id}><div className="amount-row"><strong>{names[p.sender_id]} → {names[p.recipient_id]}</strong><strong>{money(p.amount_cents)}</strong></div><p className="helper">{paymentStatus(p)} · {displayDate(p.occurred_on)}{p.reason&&` · ${p.reason}`}</p><p className="helper">Recorded by {names[p.recorded_by??p.sender_id]??'a former member'}</p>{p.status==='confirmed'&&(p.recipient_id===userId||organiser)&&<button className="text-button" disabled={blocked} onClick={()=>ask({title:'Reverse this repayment?',description:'This removes its effect on balances and keeps a record of the reversal.',button:'Reverse repayment',reason:true,run:({reason})=>mutation.run('payment_action',{p_group:group.id,p_payment:p.id,p_action:'reverse',p_version:p.version,p_reason:reason},'Reverse repayment')})}>Reverse record</button>}</div>)}</details>}</>;
}
export function PaymentForm({group,snapshot,userId,online,mutation,navigate,route,ask}:ViewProps&{route:Route}){
 const members=snapshot.members.filter(m=>m.id!==userId&&m.status==='active');
 const names=Object.fromEntries(snapshot.members.map(m=>[m.id,m.name]));
 const [direction,setDirection]=useState<'sent'|'received'>(route.direction||'sent');
 const [other,setOther]=useState(route.to||members[0]?.id||'');
 const [amount,setAmount]=useState(route.amount),[date,setDate]=useState(today()),[note,setNote]=useState('');
 const [received,setReceived]=useState(false),[separate,setSeparate]=useState(false),[error,setError]=useState('');
 const receiving=direction==='received';
 const blocked=!online||!!group.archived_at||mutation.busy||!!mutation.pending;
 const sender=receiving?other:userId,recipient=receiving?userId:other;
 const recipientApproval=snapshot.members.find(m=>m.id===recipient)?.require_payment_approval;
 const policyKnown=typeof recipientApproval==='boolean';
 const sameDirection=snapshot.payments.filter(p=>p.sender_id===sender&&p.recipient_id===recipient);
 const pendingReceived=receiving?sameDirection.filter(p=>p.status==='pending'):[];
 let cents:number|null=null;
 try{cents=parseMoney(amount);}catch{/* Show amount validation when submitting. */}
 const matches=sameDirection.filter(p=>(p.status==='pending'||p.status==='confirmed')&&p.amount_cents===cents&&p.occurred_on===date);
 const duplicateNeedsReview=matches.length>0&&!separate;
 function resetConfirmation(){setReceived(false);setSeparate(false);setError('');}
 async function submit(e:FormEvent){
  e.preventDefault();setError('');
  if(blocked)return;
  try{
   if(!members.some(m=>m.id===other))throw new Error('Choose a current member.');
   if(!receiving&&!policyKnown)throw new Error('The recipient’s payment preference could not be loaded. Refresh before recording this payment.');
   if(pendingReceived.length)throw new Error('Review the repayment waiting for confirmation before adding another.');
   if(duplicateNeedsReview)throw new Error('Check the matching record below before adding a separate payment.');
   if(receiving&&!received)throw new Error('Confirm that you have received the money first.');
   if(await mutation.run('record_repayment',{
    p_group:group.id,p_other:other,p_direction:direction,p_amount:parseMoney(amount),
    p_date:date,p_note:note.trim(),p_separate:separate
   },receiving?'Confirm money received':'Record repayment'))navigate('balances',{},true);
  }catch(e){setError(message(e));}
 }
 return <>
  <ScreenHeading title={receiving?'Record money received':'Record a repayment'} subtitle={receiving?'Record money you have already received. Balances update when you confirm.':'Record money you have already sent. Nothing is transferred by Pact.'}/>
  <div className="segmented repayment-direction" role="group" aria-label="Payment direction">
   <button type="button" aria-pressed={!receiving} disabled={blocked} onClick={()=>{setDirection('sent');resetConfirmation();}}>I sent money</button>
   <button type="button" aria-pressed={receiving} disabled={blocked} onClick={()=>{setDirection('received');resetConfirmation();}}>I received money</button>
  </div>
  <p className="helper">{receiving?'Received by':'Paid by'} <strong>{names[userId]??'You'} (you)</strong>.</p>
  <form onSubmit={submit}>
   <label>{receiving?'Received from':'Paid to'}<select value={other} disabled={blocked} onChange={e=>{setOther(e.target.value);resetConfirmation();}} required><option value="" disabled>Choose a person</option>{members.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
   {!receiving&&<div className="callout repayment-policy" role="status"><strong>{!policyKnown?'Payment preference unavailable':recipientApproval?'Approval required':'No approval needed'}</strong><p>{!policyKnown?'Refresh to load this person’s payment preference before saving.':recipientApproval?`${names[other]} requires approval. This repayment will wait for their confirmation before balances change.`:`${names[other]} allows automatic settlement. Saving updates both people’s balances immediately.`}</p>{policyKnown&&<p className="helper">Their current preference applies when you save.</p>}</div>}
   {pendingReceived.length>0&&<section className="repayment-check" aria-labelledby="pending-repayments-title">
    <h2 id="pending-repayments-title">Already waiting for confirmation</h2>
    <p className="helper">{names[other]} has already recorded a payment to you. Confirm the matching record below. If its details are wrong, return to Balances to reject it first.</p>
    <div className="list-panel">{pendingReceived.map(p=><div className="payment-card" key={p.id}>
     <div className="amount-row"><strong>{names[p.sender_id]} → You</strong><strong>{money(p.amount_cents)}</strong></div>
     <p className="helper">{displayDate(p.occurred_on)}{p.note&&` · ${p.note}`}</p>
     <button type="button" className="primary" disabled={blocked} onClick={()=>ask({
      title:'Have you received this money?',description:`Confirm you received ${money(p.amount_cents)} from ${names[p.sender_id]}.`,button:'Confirm received',
      run:async()=>{const saved=await mutation.run('payment_action',{p_group:group.id,p_payment:p.id,p_action:'confirm',p_version:p.version,p_reason:''},'Confirm repayment');if(saved)navigate('balances',{},true);return saved;}
     })}>Confirm received</button>
    </div>)}</div>
    <button type="button" className="text-button" onClick={()=>navigate('balances')}>Back to balances</button>
   </section>}
   <div className="field-pair">
    <label>Amount · AUD<input required inputMode="decimal" disabled={blocked} value={amount} onChange={e=>{setAmount(e.target.value);resetConfirmation();}}/></label>
    <label>Date<input type="date" required disabled={blocked} value={date} onChange={e=>{setDate(e.target.value);resetConfirmation();}}/></label>
   </div>
   {receiving&&<p className="helper">Enter only what you actually received, including a partial payment. Nothing is transferred by Pact.</p>}
   <label>Note (optional)<input maxLength={500} disabled={blocked} value={note} onChange={e=>setNote(e.target.value)} placeholder="e.g. Bank transfer"/></label>
   {!pendingReceived.length&&matches.length>0&&<section className="repayment-check" aria-labelledby="matching-repayments-title">
    <h2 id="matching-repayments-title">Check this existing record</h2>
    <p className="helper">The same amount and date are already recorded between you and {names[other]}. Only add another record if it was a different transfer.</p>
    <div className="list-panel">{matches.map(p=><div className="payment-card" key={p.id}>
     <div className="amount-row"><strong>{money(p.amount_cents)}</strong><span>{p.status==='pending'?'Waiting for confirmation':paymentStatus(p)}</span></div>
     <p className="helper">{displayDate(p.occurred_on)} · Recorded by {names[p.recorded_by??p.sender_id]??'a former member'}{p.note&&` · ${p.note}`}</p>
    </div>)}</div>
    <label className="check-row repayment-confirmation"><input type="checkbox" disabled={blocked} checked={separate} onChange={e=>{setSeparate(e.target.checked);setReceived(false);}}/>This is a separate payment</label>
   </section>}
   {receiving&&<label className="check-row repayment-confirmation"><input type="checkbox" required disabled={blocked||pendingReceived.length>0} checked={received} onChange={e=>setReceived(e.target.checked)}/>I confirm I have received this money.</label>}
   <Alert text={error}/>
   <button className="primary full" disabled={blocked||!members.length||pendingReceived.length>0||duplicateNeedsReview||(receiving?!received:!policyKnown)}>{mutation.busy?'Saving…':receiving?'Confirm money received':'Record repayment'}</button>
   <p className="helper">{receiving?'Confirming adds this repayment to both people’s balances immediately.':!policyKnown?'Refresh to check the recipient’s payment preference.':recipientApproval?'Balances update after the recipient confirms they received it.':'Saving settles this repayment immediately. Nothing is transferred by Pact.'}</p>
  </form>
 </>;
}
