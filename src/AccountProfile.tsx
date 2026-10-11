import {useEffect, useLayoutEffect, useRef, useState, type FormEvent} from 'react';
import {fetchOwnProfile, reauthenticate, rpc, type Group, type Snapshot} from './api';
import {authError, definitelyRejected, message} from './errors';
import {normalizeDisplayName, parseThemePreference, readThemePreference, saveThemePreference, THEME_STORAGE_KEY, type ThemePreference} from './profile';
import {Alert, Avatar, Loading} from './ui';

export type AppearancePreference = {
  preference: ThemePreference;
  notice: string;
  choose: (preference: ThemePreference) => void;
};

export function useAppearance(): AppearancePreference {
  const [preference, setPreference] = useState<ThemePreference>(() => readThemePreference());
  const [notice, setNotice] = useState('');

  useLayoutEffect(() => {
    if (preference === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.dataset.theme = preference;
    // Both media-specific tags must follow an explicit choice; System restores them.
    for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
      const dark = preference === 'dark' || (preference === 'system' && meta.media.includes('dark'));
      meta.content = dark ? '#112019' : '#f5f7f5';
    }
  }, [preference]);

  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === THEME_STORAGE_KEY || event.key === null) {
        setPreference(readThemePreference());
        setNotice('');
      }
    };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, []);

  function choose(next: ThemePreference) {
    setPreference(next);
    setNotice(saveThemePreference(next) ? '' : 'Appearance changed for now. This browser could not save your preference.');
  }

  return {preference, notice, choose};
}

export function Appearance({appearance}: {appearance: AppearancePreference}) {
  return <section className="card" aria-labelledby="appearance-heading">
    <h2 id="appearance-heading">Appearance</h2>
    <label><span className="sr-only">Appearance</span>
      <select value={appearance.preference} onChange={event => appearance.choose(parseThemePreference(event.target.value))} aria-describedby="appearance-help">
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
    <p id="appearance-help" className="helper">Saved on this device. System follows your phone or computer's appearance.</p>
    {appearance.notice && <p className="helper" role="status">{appearance.notice}</p>}
  </section>;
}

export function PaymentApproval({userId, online, onSaved}: {
  userId: string;
  online: boolean;
  onSaved: () => void;
}) {
  const [saved, setSaved] = useState<boolean | null>(null);
  const [requireApproval, setRequireApproval] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [retryValue, setRetryValue] = useState<boolean | null>(null);
  const flight = useRef(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError('');
    setNeedsAuth(false);
    setSaved(null);
    void rpc<boolean>('get_payment_preferences', {}).then(value => {
      if (typeof value !== 'boolean') throw new Error('Your payment preference could not be loaded. Try again.');
      if (!active) return;
      setSaved(value);
      setRequireApproval(value);
      setRetryValue(null);
      setSaveError('');
      setNotice('');
    }).catch(error => {
      if (active) {setLoadError(message(error)); setNeedsAuth(authError(error));}
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => {active = false;};
  }, [userId, attempt]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (flight.current || !online || saved === null) return;
    // Retry an uncertain response with exactly the same preference. Setting the
    // same boolean again is safe and cannot duplicate a repayment.
    const requested = retryValue ?? requireApproval;
    flight.current = true;
    setSaving(true);
    setSaveError('');
    setNotice('');
    setNeedsAuth(false);
    try {
      const value = await rpc<boolean>('set_payment_preferences', {p_require_approval: requested});
      if (typeof value !== 'boolean') throw new Error('We could not confirm your saved preference. Try saving again.');
      setSaved(value);
      setRequireApproval(value);
      setRetryValue(null);
      setNotice('Payment preference saved.');
      onSaved();
    } catch (error) {
      setSaveError(message(error));
      setNeedsAuth(authError(error));
      if (!definitelyRejected(error)) setRetryValue(requested);
    } finally {
      flight.current = false;
      setSaving(false);
    }
  }

  function signInAgain() {
    void reauthenticate().catch(error => {
      if (loadError) setLoadError(message(error));
      else setSaveError(message(error));
    });
  }

  return <section className="card" aria-labelledby="payment-approval-heading">
    <h2 id="payment-approval-heading">Payment approval</h2>
    <p className="helper">Choose how repayments to you are settled across all your households and trips.</p>
    {loading ? <Loading text="Loading your payment preference…"/> : loadError ? <Alert text={loadError}>
      <button disabled={!online} onClick={() => setAttempt(value => value + 1)}>Try loading payment preference again</button>
      {needsAuth && <button disabled={!online} onClick={signInAgain}>Sign in again</button>}
    </Alert> : <form onSubmit={save}>
      <label className="check-row payment-preference-toggle"><input type="checkbox" checked={requireApproval} disabled={saving || retryValue !== null} aria-describedby="payment-approval-help" onChange={event => {setRequireApproval(event.target.checked); setNotice(''); setSaveError('');}}/>Require my approval for repayments to me</label>
      <p id="payment-approval-help" className="helper">{requireApproval ? 'On: a payment someone records to you waits for your confirmation before balances change.' : 'Off: a payment someone records to you settles immediately. You can reverse an incorrect record from Balances.'}</p>
      <p className="helper">Your saved choice applies to new records only. Payments already waiting for confirmation still need your review.</p>
      <Alert text={saveError}>{needsAuth && <button type="button" disabled={!online || saving} onClick={signInAgain}>Sign in again</button>}</Alert>
      {retryValue !== null && <p className="helper" role="status">The save could not be confirmed. Save again to confirm the same preference, or reload to check its current value.</p>}
      {notice && <p className="notice" role="status">{notice}</p>}
      <button className="primary" disabled={!online || saving || (retryValue === null && requireApproval === saved)}>{saving ? 'Saving…' : 'Save payment preference'}</button>
    </form>}
  </section>;
}

export function Profile({userId, group, snapshot, online, onSaved}: {
  userId: string;
  group?: Group;
  snapshot: Snapshot | null;
  online: boolean;
  onSaved: () => void;
}) {
  const [savedName, setSavedName] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [notice, setNotice] = useState('');
  const [saving, setSaving] = useState(false);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const flight = useRef(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError('');
    setNeedsAuth(false);
    void fetchOwnProfile(userId).then(displayName => {
      if (!active) return;
      setSavedName(displayName);
      setName(displayName);
    }).catch(error => {
      if (active) {setLoadError(message(error)); setNeedsAuth(authError(error));}
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [userId, attempt]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (flight.current || !online || savedName === null) return;
    setSaveError('');
    setNotice('');
    let displayName: string;
    try { displayName = normalizeDisplayName(name); }
    catch (error) { setSaveError(message(error)); return; }
    setNeedsAuth(false);
    flight.current = true;
    setSaving(true);
    try {
      const saved = await rpc<string>('update_profile', {p_display_name: displayName});
      setSavedName(saved);
      setName(saved);
      setNotice('Profile saved.');
      onSaved();
    } catch (error) {
      // A failed response may follow a committed update. Keep the same input for retry.
      setSaveError(message(error));
      setNeedsAuth(authError(error));
    } finally {
      flight.current = false;
      setSaving(false);
    }
  }

  function signInAgain() {
    void reauthenticate().catch(error => {
      if (loadError) setLoadError(message(error));
      else setSaveError(message(error));
    });
  }

  const membership = snapshot?.members.find(member => member.id === userId && member.status === 'active');
  return <section className="card" aria-labelledby="profile-heading">
    <h2 id="profile-heading">Your profile</h2>
    {loading ? <Loading text="Loading your profile…"/> : loadError ? <Alert text={loadError}>
      <button disabled={!online} onClick={() => setAttempt(value => value + 1)}>Try loading profile again</button>
      {needsAuth && <button disabled={!online} onClick={signInAgain}>Sign in again</button>}
    </Alert> : <form onSubmit={save}>
      <div className="profile-summary"><Avatar name={savedName ?? ''}/><strong>{savedName}</strong></div>
      <label>Display name
        <input required value={name} autoComplete="nickname" aria-describedby="profile-name-help" disabled={saving} onChange={event => {setName(event.target.value); setNotice('');}}/>
      </label>
      <p id="profile-name-help" className="helper">Use 1–80 characters. This name is visible to people in your households and trips, including on earlier expenses.</p>
      <Alert text={saveError}>{needsAuth && <button type="button" disabled={!online || saving} onClick={signInAgain}>Sign in again</button>}</Alert>
      {notice && <p className="notice" role="status">{notice}</p>}
      <button className="primary" disabled={!online || saving || name.trim() === savedName}>{saving ? 'Saving…' : 'Save profile'}</button>
    </form>}
    {group && membership && <p className="helper profile-membership">{group.kind === 'household' ? 'Household' : 'Trip'}: <strong>{group.name}</strong> · {membership.role === 'organiser' ? 'Organiser' : 'Member'}</p>}
  </section>;
}
