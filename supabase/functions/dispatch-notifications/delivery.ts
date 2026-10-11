/** Keep this allowlist aligned with private.push_endpoint_valid. Never follow provider redirects. */
export function isPushEndpoint(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 30 || value.length > 4096 || /[\s?#\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      (url.hostname === 'fcm.googleapis.com' || url.hostname === 'updates.push.services.mozilla.com' || /^[a-z0-9-]+\.push\.apple\.com$/.test(url.hostname)) &&
      url.pathname.length > 1 && value.startsWith('https://' + url.hostname + '/');
  } catch { return false; }
}
export function retrySeconds(header: string | null, attempts: number, now = Date.now()): number {
  const numeric = header !== null && /^\d+$/.test(header.trim()) ? Number(header) : NaN;
  const dated = header !== null ? Math.ceil((Date.parse(header) - now) / 1000) : NaN;
  const requested = Number.isFinite(numeric) ? numeric : Number.isFinite(dated) ? dated : 30 * 2 ** Math.max(0, attempts - 1);
  return Math.max(1, Math.min(86400, Math.ceil(requested)));
}
/** Compare fixed-size digests rather than leaking the secret's matching prefix. */
export async function equalSecret(supplied: string, expected: string): Promise<boolean> {
  if (supplied.length > 512 || expected.length < 32) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([supplied, expected].map(value => crypto.subtle.digest('SHA-256', encoder.encode(value))));
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < x.length; i++) difference |= x[i] ^ y[i];
  return difference === 0;
}
