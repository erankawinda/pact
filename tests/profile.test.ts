import {test} from 'node:test';
import assert from 'node:assert/strict';
import {nameInitials, normalizeDisplayName, parseThemePreference, readThemePreference, saveThemePreference, THEME_STORAGE_KEY} from '../src/profile';

test('avatar initials preserve astral Unicode characters', () => {
  assert.equal(nameInitials('  alex   smith '), 'AS');
  assert.equal(nameInitials('🌿 🌻'), '🌿🌻');
  assert.equal(nameInitials('李 小明'), '李小');
  assert.equal(nameInitials('   '), '');
});

test('profile names trim Unicode whitespace and count code points like PostgreSQL', () => {
  assert.equal(normalizeDisplayName('\uFEFF\u00a0  Alex Smith \u3000\n'), 'Alex Smith');
  assert.equal(normalizeDisplayName('李 小明'), '李 小明');
  assert.equal(normalizeDisplayName('🌿'.repeat(80)), '🌿'.repeat(80));
  assert.throws(() => normalizeDisplayName('🌿'.repeat(81)), /1 to 80/);
  assert.throws(() => normalizeDisplayName('\uFEFF\u00a0\u3000\t\r\n'), /1 to 80/);
  assert.throws(() => normalizeDisplayName('a'.repeat(81)), /1 to 80/);
});

test('appearance preferences handle missing, invalid and unavailable browser storage', () => {
  for (const value of [null, undefined, '', 'automatic', {}, 1]) assert.equal(parseThemePreference(value), 'system');
  for (const value of ['system', 'light', 'dark'] as const) assert.equal(parseThemePreference(value), value);
  const values = new Map<string, string>();
  const storage = {getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => {values.set(key, value);}};
  assert.equal(readThemePreference(storage), 'system');
  assert.equal(saveThemePreference('dark', storage), true);
  assert.equal(values.get(THEME_STORAGE_KEY), 'dark');
  assert.equal(readThemePreference(storage), 'dark');
  assert.equal(saveThemePreference('system', storage), true);
  assert.equal(readThemePreference(storage), 'system');
  const unavailable = {getItem: () => {throw new Error('Storage blocked');}, setItem: () => {throw new Error('Storage blocked');}};
  assert.equal(readThemePreference(unavailable), 'system');
  assert.equal(saveThemePreference('light', unavailable), false);
  assert.equal(saveThemePreference('dark', {getItem: () => null, setItem: () => {}}), false);
});
