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
