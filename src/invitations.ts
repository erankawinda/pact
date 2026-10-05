export const INVITE_KEY = 'our-place-invite';

export function invitationToken(value: string): string | null {
  const input = value.trim();
  if (/^[a-f0-9]{64}$/.test(input)) return input;
  try {
    const url = new URL(input);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    const token = new URLSearchParams(url.hash.slice(1)).get('invite');
    return token && /^[a-f0-9]{64}$/.test(token) ? token : null;
  } catch { return null; }
}

export function storedInvite(): string {
  try { return sessionStorage.getItem(INVITE_KEY) ?? ''; } catch { return ''; }
}

export function clearInvite(): void {
  try { sessionStorage.removeItem(INVITE_KEY); } catch { /* Storage may be disabled. */ }
}

export function captureInvite(): string {
  const token = invitationToken(location.href);
  if (!token) return storedInvite();
  try {
    sessionStorage.setItem(INVITE_KEY, token);
    history.replaceState(history.state, '', location.pathname + location.search);
  } catch { /* The URL remains the recovery source when storage is unavailable. */ }
  return token;
}

export function rememberInvite(value: string): boolean {
  const token = invitationToken(value);
  if (!token) return false;
  try{sessionStorage.setItem(INVITE_KEY,token);return sessionStorage.getItem(INVITE_KEY)===token;}catch{return false;}
}
