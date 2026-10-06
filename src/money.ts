export const MAX_CENTS = 100_000_000;
export function parseMoney(value: string, allowZero = false): number {
  let text = value.trim();
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d{0,2})?$/.test(text)) text = text.replaceAll(',', '');
  if (!/^(?:\d{1,7}(?:\.\d{0,2})?|\.\d{1,2})$/.test(text)) throw new Error('Enter an amount such as 12.50, with up to two decimal places.');
  const [whole, fraction = ''] = text.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (cents > MAX_CENTS || cents < (allowZero ? 0 : 1)) throw new Error(`Enter an amount between ${allowZero ? '$0' : '$0.01'} and $1,000,000.`);
  return cents;
}
export function splitEqual(cents: number, ids: string[]): Record<string, number> {
  if (!Number.isSafeInteger(cents) || cents < 1 || cents > MAX_CENTS) throw new Error('Invalid amount.');
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error('Choose at least one person to share this expense.');
  const sorted = [...ids].sort();
  return Object.fromEntries(sorted.map((id, i) => [id, Math.floor(cents / ids.length) + (i < cents % ids.length ? 1 : 0)]));
}
export function exactShares(cents: number, ids: string[], inputs: Record<string,string>): Record<string, number> {
  if (!Number.isSafeInteger(cents) || cents < 1 || cents > MAX_CENTS) throw new Error('Enter a valid total amount.');
  if (!ids.length || new Set(ids).size !== ids.length) throw new Error('Choose at least one person.');
  const shares = Object.fromEntries(ids.map(id => [id, parseMoney(inputs[id] ?? '', true)]));
  if (Object.values(shares).reduce((a, b) => a + b, 0) !== cents) throw new Error('Each share must add up to the total.');
  return shares;
}

/** Blank is unknown; an entered zero is an explicit share. Never mutate the inputs. */
export function planCustomSplit(cents: number | null, ids: string[], inputs: Record<string, string>, splitRemaining = false) {
  const shares: Record<string, number> = {};
  const blankIds: string[] = [], invalidIds: string[] = [];
  let enteredCents = 0, inputError = '';
  for (const id of ids) {
    const value = inputs[id] ?? '';
    if (!value.trim()) { blankIds.push(id); continue; }
    try { shares[id] = parseMoney(value, true); enteredCents += shares[id]; }
    catch (e) { invalidIds.push(id); inputError ||= (e as Error).message; }
  }
  const validPeople = ids.length > 0 && new Set(ids).size === ids.length;
  const total = cents !== null && Number.isSafeInteger(cents) && cents >= 1 && cents <= MAX_CENTS ? cents : null;
  const remainingCents = total === null || invalidIds.length ? null : total - enteredCents;
  const canSplitRemaining = validPeople && !invalidIds.length && remainingCents !== null && remainingCents >= 0 && blankIds.length > 1;
  const autoIds = validPeople && !invalidIds.length && remainingCents !== null && remainingCents >= 0 &&
    (blankIds.length === 1 || splitRemaining) ? [...blankIds].sort() : [];
  if (autoIds.length) {
    // splitEqual intentionally rejects a zero expense; a zero remainder is valid.
    Object.assign(shares, remainingCents === 0 ? Object.fromEntries(autoIds.map(id => [id, 0])) : splitEqual(remainingCents!, autoIds));
  }
  const suggestedTotal = validPeople && !invalidIds.length && !blankIds.length && enteredCents > 0 && enteredCents <= MAX_CENTS ? enteredCents : null;
  let issue: string | null = null;
  if (!validPeople) issue = 'Choose at least one person to share this expense.';
  else if (invalidIds.length) issue = `Check the custom amounts. ${inputError}`;
  else if (enteredCents > MAX_CENTS) issue = 'The entered shares exceed the maximum total of $1,000,000.';
  else if (total === null) issue = "Enter the total above, or enter everyone's share.";
  else if (remainingCents! < 0) issue = `${money(-remainingCents!)} over the total. Reduce the entered shares or increase the total.`;
  else if (blankIds.length && !autoIds.length) issue = `${money(remainingCents!)} left for ${blankIds.length} people. Enter their shares or split the remainder equally.`;
  else if (!blankIds.length && remainingCents !== 0) issue = `${money(remainingCents!)} left to allocate.`;
  return {shares, blankIds, invalidIds, autoIds, enteredCents, remainingCents, canSplitRemaining, suggestedTotal, issue};
}
export function displayDate(value: string): string {
  const date = new Date(value + 'T12:00:00Z');
  return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('en-AU', {day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'}).format(date);
}
export function money(cents: number): string {
  return new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD' }).format(cents / 100);
}
export function today(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Melbourne', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
export function settlementSuggestions(balances:{user_id:string;cents:number}[]):{from:string;to:string;cents:number}[] {
 if(balances.some(b=>!Number.isSafeInteger(b.cents))||balances.reduce((s,b)=>s+b.cents,0)!==0)throw new Error('Balances do not add up. Refresh before recording a repayment.');
 const debtors=balances.filter(b=>b.cents<0).map(b=>({id:b.user_id,left:-b.cents})).sort((a,b)=>b.left-a.left||a.id.localeCompare(b.id));
 const creditors=balances.filter(b=>b.cents>0).map(b=>({id:b.user_id,left:b.cents})).sort((a,b)=>b.left-a.left||a.id.localeCompare(b.id));
 const result:{from:string;to:string;cents:number}[]=[];let d=0,c=0;
 while(d<debtors.length&&c<creditors.length){const cents=Math.min(debtors[d].left,creditors[c].left);result.push({from:debtors[d].id,to:creditors[c].id,cents});debtors[d].left-=cents;creditors[c].left-=cents;if(!debtors[d].left)d++;if(!creditors[c].left)c++;}
 return result;
}
