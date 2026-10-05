import {test} from 'node:test';
import assert from 'node:assert/strict';
import {invitationToken} from '../src/invitations.ts';
import {clearPending, readPending, rememberPending, type PendingExpense} from '../src/pendingExpense.ts';
import {accessError, definitelyRejected, message} from '../src/errors.ts';
import {displayDate, parseMoney, exactShares} from '../src/money.ts';

function memoryStorage() {
  const values = new Map<string, string>();
  return {getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => {values.set(key, value);}, removeItem: (key: string) => {values.delete(key);}};
}
const pending: PendingExpense = {input: {p_group: 'home', p_request: 'request-1', p_description: 'Groceries', p_amount: 101, p_payer: 'a', p_people: ['b', 'c'], p_mode: 'equal', p_exact: null, p_date: '2026-10-04', p_category: 'groceries', p_note: ''}, shares: {b: 51, c: 50}, names: {a: 'A', b: 'B', c: 'C'}};

test('invitation accepts a full URL or code and rejects malformed values without following URLs', () => {
  const token = 'a'.repeat(64);
  assert.equal(invitationToken(` https://pact.example/#invite=${token} `), token);
  assert.equal(invitationToken(token), token);
  for (const value of ['a', 'b'.repeat(65), 'x'.repeat(64), `javascript:alert(1)#invite=${token}`, `https://pact.example/?invite=${token}`, '']) assert.equal(invitationToken(value), null);
});
test('unfinished expense recovers the exact request and remains isolated by user and group', () => {
  const storage = memoryStorage();
  rememberPending('a', pending, storage);
  assert.deepEqual(readPending('a', 'home', storage), pending);
  assert.equal(readPending('a', 'trip', storage), null);
  assert.equal(readPending('b', 'home', storage), null);
  clearPending('b', 'home', storage);
  assert.deepEqual(readPending('a', 'home', storage)?.input, pending.input);
  clearPending('a', 'home', storage);
  assert.equal(readPending('a', 'home', storage), null);
});
test('recovery fails closed when storage is corrupt or unavailable', () => {
  const storage = memoryStorage();
  storage.setItem('pact:pending-expense:a:home', '{broken');
  assert.throws(() => readPending('a', 'home', storage));
  storage.setItem('pact:pending-expense:a:home', JSON.stringify({...pending, input: {...pending.input, p_group: 'another'}}));
  assert.throws(() => readPending('a', 'home', storage));
  assert.throws(() => rememberPending('a', pending, {getItem: () => null, setItem: () => {}, removeItem: () => {}}));
});
test('network failures remain uncertain; confirmed server rejection is distinguishable', () => {
  assert.equal(definitelyRejected(new TypeError('Failed to fetch')), false);
  assert.equal(definitelyRejected({code: '504', message: 'timeout'}), false);
  assert.equal(definitelyRejected({code: '23514', message: 'constraint violation'}), true);
  assert.equal(accessError({code: '42501'}), true);
  assert.equal(accessError({message: 'network failed'}), false);
  assert.match(message({message: 'invalid_invitation'}), /expired/);
  assert.match(message({code: '42501', message: 'permission denied'}), /access/);
});
test('common amount entry styles preserve cents and malformed grouping is rejected', () => {
  assert.equal(parseMoney('.50'), 50);
  assert.equal(parseMoney('12.'), 1200);
  assert.equal(parseMoney(' 1,234.56 '), 123456);
  assert.equal(parseMoney('0', true), 0);
  for (const value of ['1,23', '1,23.00', '1 000', '1,000,00', '.001', '1,000,000.01']) assert.throws(() => parseMoney(value));
  for (const value of [-1, 0, NaN, 1.5, 100000001]) assert.throws(() => exactShares(value, ['a'], {a:'1'}));
  assert.equal(displayDate('2026-10-04'), '4 Oct 2026');
});
