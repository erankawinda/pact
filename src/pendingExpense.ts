import type {ExpenseInput} from './api';
import {MAX_CENTS, splitEqual} from './money';

export type PendingExpense = {input: ExpenseInput; shares: Record<string, number>; names: Record<string, string>; replaces?:string|null; version?:number; reason?:string; purchase?:string|null; legacy?:boolean; autoPeople?:string[]; splitRemaining?:boolean};
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const key = (user: string, group: string) => `pact:pending-expense:${user}:${group}`;

export function readPending(user: string, group: string, storage: StorageLike = localStorage): PendingExpense | null {
  let raw = storage.getItem(key(user, group));
  // Bring 0.2's same-tab recovery forward without changing its request identity or RPC.
  if (!raw && typeof sessionStorage !== 'undefined' && storage === localStorage) {
    const old = sessionStorage.getItem(key(user, group));
    if (old) {
      raw = JSON.stringify({...JSON.parse(old), legacy:true});
      storage.setItem(key(user, group), raw);
      sessionStorage.removeItem(key(user, group));
    }
  }
  if (!raw) return null;
  const value = JSON.parse(raw) as PendingExpense;
  const invalid = () => {throw new Error('The unfinished save could not be read. Keep this tab open and contact the app owner.');};
  const input = value?.input;
  const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
  if (!input || input.p_group !== group || typeof input.p_request !== 'string' || !input.p_request ||
    !Number.isSafeInteger(input.p_amount) || input.p_amount < 1 || input.p_amount > MAX_CENTS ||
    typeof input.p_payer !== 'string' || !input.p_payer || typeof input.p_description !== 'string' || !input.p_description.trim() ||
    typeof input.p_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.p_date) ||
    typeof input.p_category !== 'string' || typeof input.p_note !== 'string' ||
    !Array.isArray(input.p_people) || !input.p_people.length || input.p_people.length > 100 ||
    input.p_people.some(id => typeof id !== 'string' || !id) || new Set(input.p_people).size !== input.p_people.length ||
    !['equal', 'exact'].includes(input.p_mode) || !record(value.shares) || !record(value.names)) invalid();
  const expected = input.p_mode === 'equal' ? splitEqual(input.p_amount, input.p_people) : input.p_exact;
  if (!record(expected) || Object.keys(value.shares).length !== input.p_people.length ||
    input.p_people.some(id => !Number.isSafeInteger(value.shares[id]) || value.shares[id] < 0 || value.shares[id] !== expected[id] || typeof value.names[id] !== 'string') ||
    typeof value.names[input.p_payer] !== 'string' || Object.values(value.shares).reduce((a, b) => a + b, 0) !== input.p_amount) invalid();
  return value;
}

export function rememberPending(user: string, value: PendingExpense, storage: StorageLike = localStorage): void {
  const name = key(user, value.input.p_group);
  const encoded = JSON.stringify(value);
  storage.setItem(name, encoded);
  if (storage.getItem(name) !== encoded) throw new Error('Save recovery is unavailable.');
}

export function clearPending(user: string, group: string, storage: StorageLike = localStorage): void {
  storage.removeItem(key(user, group));
}
