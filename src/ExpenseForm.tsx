import {useEffect, useRef, useState, type FormEvent} from 'react';
import {rpc, reauthenticate, type Expense, type Group, type Snapshot} from './api';
import {authError, definitelyRejected, message} from './errors';
import {displayDate, money, parseMoney, planCustomSplit, splitEqual, today} from './money';
import {clearPending, readPending, rememberPending, type PendingExpense} from './pendingExpense';
import {Alert, Avatar, FormHeader, Icon, moveToTop} from './ui';

type Draft = {description:string;amount:string;payer:string;people:string[];mode:'equal'|'exact';exact:Record<string,string>;date:string;category:string;note:string;reason:string;splitRemaining?:boolean};
export function ExpenseForm({group, snapshot, userId, online, onBack, onSaved, initial, purchaseId, purchaseName}: {
  group: Group; snapshot: Snapshot; userId: string; online: boolean; onBack: () => void; onSaved: () => void;
  initial?:Expense; purchaseId?:string; purchaseName?:string;
}) {
  const draftKey = `pact:draft:${userId}:${group.id}:${initial?.id ?? purchaseId ?? 'new'}`;
  const [recovery] = useState(() => {
    try { return {value: readPending(userId, group.id), error: ''}; }
    catch { return {value: null, error: 'An unfinished save could not be read. Contact the app owner before adding this expense again.'}; }
  });
  const [start] = useState(() => {
    const shares=snapshot.shares.filter(s=>s.expense_id===initial?.id);
    const base:Draft={description:initial?.description??purchaseName??'',amount:initial?(initial.amount_cents/100).toFixed(2):'',payer:initial?.cash_actor_id??userId,people:shares.map(s=>s.user_id),mode:initial?.split_mode==='exact'?'exact':'equal',exact:Object.fromEntries(shares.map(s=>[s.user_id,(s.share_cents/100).toFixed(2)])),date:initial?.occurred_on??today(),category:initial?.category??(group.kind==='trip'?'travel':'groceries'),note:initial?.note??'',reason:''};
    try {
      const raw=localStorage.getItem(draftKey);
      if(raw){const d=JSON.parse(raw);if(d&&typeof d.description==='string'&&typeof d.amount==='string'&&typeof d.payer==='string'&&Array.isArray(d.people)&&d.people.every((v:unknown)=>typeof v==='string')&&['equal','exact'].includes(d.mode)&&d.exact&&typeof d.exact==='object'&&Object.values(d.exact).every(v=>typeof v==='string')&&typeof d.date==='string'&&typeof d.category==='string'&&typeof d.note==='string'&&typeof d.reason==='string')return {...base,...d} as Draft;}
    }catch{/* The user can still enter a fresh draft; pending saves fail closed above. */}
    return base;
  });
  const [description, setDescription] = useState(start.description);
  const [amount, setAmount] = useState(start.amount);
  const [payer, setPayer] = useState(start.payer);
  const [people, setPeople] = useState<string[]>(start.people);
  const [mode, setMode] = useState<'equal' | 'exact'>(start.mode);
  const [exact, setExact] = useState<Record<string, string>>(start.exact);
  const [splitRemaining, setSplitRemaining] = useState(start.splitRemaining === true);
  const [focusedShare, setFocusedShare] = useState<string | null>(null);
  const [date, setDate] = useState(start.date);
  const [category, setCategory] = useState(start.category);
  const [note, setNote] = useState(start.note);
  const [reason,setReason]=useState(start.reason);
  const [storageError,setStorageError]=useState('');
  const [needsAuth,setNeedsAuth]=useState(false);
  const [membershipNotice,setMembershipNotice]=useState('');
  const [review, setReview] = useState<PendingExpense | null>(recovery.value);
  const [uncertain, setUncertain] = useState(Boolean(recovery.value));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(recovery.error);
  const [discard, setDiscard] = useState(false);
  const inFlight = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const initialDate = useRef(date);
  const members = snapshot.members.filter(m => m.status === 'active');
  const dirty = Boolean(description || amount || people.length || note || payer !== userId || date !== initialDate.current || category !== (group.kind === 'trip' ? 'travel' : 'groceries') || mode !== 'equal' || review);

  useEffect(() => {
    if(review)return;
    try {localStorage.setItem(draftKey,JSON.stringify({description,amount,payer,people,mode,exact,date,category,note,reason,splitRemaining}));setStorageError('');}
    catch {setStorageError('Your browser cannot keep this draft. Allow site storage before saving or leaving this screen.');}
  },[draftKey,description,amount,payer,people,mode,exact,date,category,note,reason,splitRemaining,review]);
  const memberKey=members.map(m=>m.id).sort().join(',');
  useEffect(()=>{
    if(review)return;
    const allowed=new Set(members.map(m=>m.id));
    if(people.some(id=>!allowed.has(id))||!allowed.has(payer)) {
      setPeople(old=>old.filter(id=>allowed.has(id)));
      if(!allowed.has(payer))setPayer('');
      setMembershipNotice('The people in this household changed. Check the payer and people sharing this cost.');
    }
  },[memberKey,review]);
  useEffect(() => {
    if (discard) dialog.current?.showModal();
    else dialog.current?.close();
  }, [discard]);
  useEffect(moveToTop, []);
  // Clear resolved validation on input changes, never on background refreshes.
  useEffect(() => {
    if (!review && !recovery.error) setError('');
  }, [description, amount, payer, people, mode, exact, splitRemaining, date, category, note]);

  let cents = 0;
  try { cents = parseMoney(amount); } catch { /* Show validation when the user reviews. */ }
  let liveShares: Record<string, number> = {};
  if (cents && people.length && mode === 'equal') liveShares = splitEqual(cents, people);
  const customSplit = planCustomSplit(cents || null, people, exact, splitRemaining);
  let totalIsEmpty = !amount.trim();
  try { totalIsEmpty ||= parseMoney(amount, true) === 0; } catch { /* Keep an invalid total visible for correction. */ }
  const suggestedTotal = mode === 'exact' && totalIsEmpty ? customSplit.suggestedTotal : null;

  function leave() {
    if (busy) return;
    if (storageError && dirty) setDiscard(true); else onBack();
  }
  function preview(event: FormEvent) {
    event.preventDefault(); setError('');
    if (recovery.error) { setError(recovery.error); return; }
    try {
      const total = parseMoney(amount);
      if (!description.trim()) throw new Error('Give the expense a short name, such as Groceries.');
      if (!date) throw new Error('Choose a date under Date, category & note.');
      if (!members.some(m => m.id === payer)) throw new Error('Choose who paid.');
      if (people.some(id=>!members.some(m=>m.id===id))) throw new Error('Check the people sharing this expense.');
      if(initial && !reason.trim())throw new Error('Add a short reason for the correction.');
      const split = planCustomSplit(total, people, exact, splitRemaining);
      if (mode === 'exact' && split.issue) throw new Error(split.issue);
      const shares = mode === 'equal' ? splitEqual(total, people) : split.shares;
      setReview({replaces:initial?.id??null,version:initial?.version,reason:reason.trim(),purchase:purchaseId??null,shares, autoPeople:mode==='exact'?split.autoIds:[], splitRemaining, names: Object.fromEntries(snapshot.members.map(m => [m.id, m.name])), input: {
        p_group: group.id, p_request: crypto.randomUUID(), p_description: description.trim(), p_amount: total,
        p_payer: payer, p_people: [...people].sort(), p_mode: mode, p_exact: mode === 'exact' ? shares : null,
        p_date: date, p_category: category, p_note: note.trim(),
      }});
      moveToTop();
    } catch (e) { setError(message(e)); }
  }
  async function save() {
    if (!review || inFlight.current || !online || recovery.error) return;
    // Persist the exact request before sending it so a reload can safely retry it.
    try { rememberPending(userId, review); }
    catch { setError('Your browser could not keep the save recovery details. Allow site storage, then try again. Nothing was sent.'); return; }
    inFlight.current = true; setBusy(true); setError(''); setNeedsAuth(false);
    try {
      if(review.legacy)await rpc<string>('create_expense',review.input);
      else await rpc<string>('save_expense',{p_input:review.input,p_replaces:review.replaces??null,p_version:review.version??null,p_reason:review.reason??'',p_purchase:review.purchase??null});
      try { clearPending(userId, group.id); } catch { /* The same saved request remains safe to retry. */ }
      try {localStorage.removeItem(`pact:draft:${userId}:${group.id}:${review.replaces??review.purchase??'new'}`);}catch{/* Confirmed operation remains safe to check again. */}
      onSaved();
    } catch (e) {
      if (authError(e)) {
        setNeedsAuth(true);setUncertain(true);setError('Sign in again to finish checking this expense. Your save details are kept safely on this device.');
      } else if (definitelyRejected(e)) {
        try { clearPending(userId, group.id); } catch { /* Retain recovery if storage is unavailable. */ }
        setUncertain(false); setError(message(e));
      } else {
        setUncertain(true);
        setError('We could not confirm the save. Check this save to finish it safely; it will not create a second expense.');
      }
    } finally { inFlight.current = false; setBusy(false); }
  }
  function editReview() {
    if (!review || uncertain || busy) return;
    // Also fills the form if a recovered request was definitely rejected by the server.
    const input = review.input;
    setReason(review.reason??'');
    setDescription(input.p_description); setAmount((input.p_amount / 100).toFixed(2)); setPayer(input.p_payer);
    setPeople(input.p_people); setMode(input.p_mode); setDate(input.p_date); setCategory(input.p_category); setNote(input.p_note);
    const automatic = new Set(Array.isArray(review.autoPeople) ? review.autoPeople.filter(id => input.p_people.includes(id)) : []);
    setExact(Object.fromEntries(Object.entries(review.shares).map(([id, value]) => [id, automatic.has(id) ? '' : (value / 100).toFixed(2)])));
    setSplitRemaining(review.splitRemaining === true);
    setFocusedShare(null);
    setReview(null); setError(''); moveToTop();
  }
  return <section className="form-page expense-form">
    <FormHeader title={review ? 'Check your expense' : initial ? 'Correct expense' : 'Add an expense'} context={group.name} onBack={review && !uncertain ? editReview : leave} disabled={busy}/>
    {!online && <p className="callout">You’re offline. Reconnect to save or check this expense.</p>}
    {review ? <>
      {uncertain && <div className="callout recovery"><div><strong>This save needs checking</strong><p>Your original details are saved on this device. Check this request to confirm or finish it safely.</p></div></div>}
      <div className="review-card"><p className="review-description">{review.input.p_description}</p><strong className="review-amount">{money(review.input.p_amount)}</strong><p className="muted">{review.names[review.input.p_payer] ?? 'Member'} paid · {displayDate(review.input.p_date)}</p></div>
      <div className="section-title"><h2>Who pays what</h2><span className="muted">{review.input.p_mode === 'equal' ? 'Equal split' : 'Custom amounts'}</span></div>
      <div className="list-panel">{Object.entries(review.shares).map(([id, share]) => <div className="person-row" key={id}><Avatar name={review.names[id] ?? 'Member'}/><span className="person-name">{review.names[id] ?? 'Member'}{id === userId && <small>You</small>}</span><strong>{money(share)}</strong></div>)}</div>
      {!review.input.p_people.includes(review.input.p_payer) && <p className="helper">The payer is not sharing this expense. The selected people cover the full amount.</p>}
      {review.input.p_note && <p className="expense-note">{review.input.p_note}</p>}
      <Alert text={error}>{needsAuth && <button onClick={()=>void reauthenticate().catch(e=>setError(message(e)))}>Sign in again</button>}</Alert>
      <div className="form-actions"><button onClick={editReview} disabled={busy || uncertain}>Edit</button><button className="primary" onClick={save} disabled={busy || !online || !!recovery.error}>{busy ? (uncertain ? 'Checking…' : 'Saving…') : uncertain ? 'Check this save' : 'Save expense'}</button></div>
      <p className="helper">{uncertain ? 'You can return later. Pact keeps this request on this device until it is confirmed.' : 'This records who owes what. No money is transferred.'}</p>
    </> : <form onSubmit={preview}>
      {membershipNotice&&<p className="callout">{membershipNotice}</p>}
      <Alert text={storageError}/>
      <div className="amount-field"><label htmlFor="expense-amount">Amount <span className="muted">· AUD</span></label><div><span aria-hidden="true">$</span><input id="expense-amount" required inputMode="decimal" autoComplete="off" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00"/></div></div>
      <label>What was it for?<input required maxLength={120} value={description} onChange={e => setDescription(e.target.value)} placeholder="e.g. Groceries" autoComplete="off"/></label>
      <label>Who paid?<select value={payer} required onChange={e => setPayer(e.target.value)}><option value="" disabled>Choose a person</option>{members.map(m => <option key={m.id} value={m.id}>{m.name}{m.id === userId ? ' (you)' : ''}</option>)}</select></label>
      <fieldset className="split-section"><legend>Split between</legend><p className="helper">Tap everyone sharing this expense.</p>
        <div className="split-tools"><div className="segmented" role="group" aria-label="Split method"><button type="button" aria-pressed={mode === 'equal'} onClick={() => setMode('equal')}>Equally</button><button type="button" aria-pressed={mode === 'exact'} onClick={() => setMode('exact')}>Custom amounts</button></div><button className="text-button" type="button" onClick={() => setPeople(people.length === members.length ? [] : members.map(m => m.id))}>{people.length === members.length ? 'Clear' : 'Select all'}</button></div>
        {mode === 'exact' && <p className="helper" id="custom-split-help">Enter the amounts you know. One blank share is calculated automatically. Clear an amount to let Pact calculate it again.</p>}
        <div className="list-panel split-list">{members.map(member => {
          const selected = people.includes(member.id);
          const automatic = customSplit.autoIds.includes(member.id);
          const calculated = automatic ? (customSplit.shares[member.id] / 100).toFixed(2) : '';
          return <div className={`split-row ${selected ? 'selected' : ''}`} key={member.id}>
            <label className="person-toggle"><input type="checkbox" checked={selected} onChange={e => setPeople(old => e.target.checked ? [...old, member.id] : old.filter(id => id !== member.id))}/><span className="checkbox-mark" aria-hidden="true">{selected && <Icon name="check"/>}</span><span className="person-name">{member.name}{member.id === userId && <small>You</small>}</span></label>
            {selected && mode === 'exact' ? <label className={`exact-input ${automatic ? 'automatic-share' : ''}`}><span className="sr-only">{member.name}'s share</span><input inputMode="decimal" autoComplete="off" aria-label={`${member.name}'s share`} aria-describedby={automatic ? `auto-share-${member.id}` : 'custom-split-help'} aria-invalid={customSplit.invalidIds.includes(member.id) || undefined} placeholder={calculated || '—'} value={automatic && focusedShare !== member.id ? calculated : exact[member.id] ?? ''} onFocus={() => setFocusedShare(member.id)} onBlur={() => setFocusedShare(null)} onChange={e => setExact(old => ({...old, [member.id]: e.target.value}))}/>{automatic && <small className="auto-share-label" id={`auto-share-${member.id}`}>Auto<span className="sr-only">: {money(customSplit.shares[member.id])}. Enter an amount to change it.</span></small>}</label> : selected && liveShares[member.id] !== undefined ? <strong className="share-amount">{money(liveShares[member.id])}</strong> : null}
          </div>;
        })}</div>
        <p className={`split-status ${mode === 'exact' && cents && customSplit.issue ? 'needs-attention' : ''}`} aria-live="polite">
          {!people.length ? 'No one selected yet.' : mode === 'equal' ? `${people.length} ${people.length === 1 ? 'person' : 'people'} selected${cents ? ' · shares shown above' : ''}` : customSplit.issue ?? `Total matches · ${money(cents)}${customSplit.autoIds.length ? ` · ${customSplit.autoIds.length} ${customSplit.autoIds.length === 1 ? 'share' : 'shares'} calculated automatically` : ''}`}
        </p>
        {mode === 'exact' && customSplit.canSplitRemaining && !splitRemaining && <button type="button" className="subtle full" onClick={() => setSplitRemaining(true)}>Split remaining equally</button>}
        {suggestedTotal !== null && <button type="button" className="subtle full" onClick={() => setAmount((suggestedTotal / 100).toFixed(2))}>Use {money(suggestedTotal)} as total</button>}
      </fieldset>
      <details className="optional-fields"><summary><span>Date, category & note<small>{displayDate(date)} · {category === 'takeaway' ? 'Takeout' : category[0].toUpperCase() + category.slice(1)}</small></span><Icon name="down"/></summary><div className="optional-content">
        <label>Date<input type="date" value={date} onChange={e => setDate(e.target.value)}/></label>
        <label>Category<select value={category} onChange={e => setCategory(e.target.value)}>{Object.entries({groceries: 'Groceries', takeaway: 'Takeout', household: 'Household', travel: 'Travel', other: 'Other'}).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>Note <span className="muted">(optional)</span><textarea maxLength={1000} rows={2} value={note} onChange={e => setNote(e.target.value)} placeholder="Anything the others should know?"/></label>
      </div></details>
      {initial&&<label>Reason for correction<input required maxLength={500} value={reason} onChange={e=>setReason(e.target.value)} placeholder="e.g. The receipt total was wrong"/></label>}
      <Alert text={error}/><button className="primary full" disabled={!!recovery.error||!!storageError}>Review expense</button>
      <p className="helper">Draft saved on this device. You can come back to finish it.</p>
      <button type="button" className="text-button full" onClick={()=>setDiscard(true)}>Discard draft</button>
    </form>}
    <dialog ref={dialog} aria-labelledby="discard-title" onCancel={e => {e.preventDefault(); setDiscard(false);}}><h2 id="discard-title">Discard this expense?</h2><p>You have not saved it yet.</p><div className="form-actions"><button className="primary" autoFocus onClick={() => setDiscard(false)}>Keep editing</button><button onClick={()=>{localStorage.removeItem(draftKey);onBack();}}>Discard</button></div></dialog>
  </section>;
}
