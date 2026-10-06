export type ThemePreference = 'system' | 'light' | 'dark';
export const THEME_STORAGE_KEY = 'pact:theme';
type ThemeStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function nameInitials(name: string): string {
  return name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(part => Array.from(part)[0]).join('').toUpperCase();
}

export function normalizeDisplayName(value: string): string {
  const name = value.trim();
  // PostgreSQL char_length counts Unicode code points, unlike JS string.length.
  const length = [...name].length;
  if (length < 1 || length > 80) throw new Error('Enter a display name with 1 to 80 characters.');
  return name;
}

export function parseThemePreference(value: unknown): ThemePreference {
  return value === 'light' || value === 'dark' ? value : 'system';
}

export function readThemePreference(storage?: Pick<ThemeStorage, 'getItem'>): ThemePreference {
  try {
    return parseThemePreference((storage ?? globalThis.localStorage).getItem(THEME_STORAGE_KEY));
  } catch {
    return 'system';
  }
}

export function saveThemePreference(value: ThemePreference, storage?: ThemeStorage): boolean {
  try {
    const target = storage ?? globalThis.localStorage;
    target.setItem(THEME_STORAGE_KEY, value);
    return target.getItem(THEME_STORAGE_KEY) === value;
  } catch {
    return false;
  }
}
