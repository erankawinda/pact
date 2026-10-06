import {useEffect, useRef, type ReactNode} from 'react';
import {nameInitials} from './profile';

export type IconName = 'plus' | 'back' | 'down' | 'expense' | 'balance' | 'people' | 'home' | 'trip' | 'check' | 'search' | 'close' | 'shopping' | 'menu' | 'arrow' | 'clock';
const paths: Record<IconName, ReactNode> = {
  plus: <path d="M12 5v14M5 12h14"/>,
  back: <path d="m14 6-6 6 6 6M8 12h12"/>,
  down: <path d="m6 9 6 6 6-6"/>,
  expense: <><path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z"/><path d="M9 8h6M9 12h6"/></>,
  balance: <><path d="M4 7h16v13H4V7Zm0 0V5l13-2v4"/><path d="M16 12h4v4h-4z"/></>,
  people: <><circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 4v2"/></>,
  home: <><path d="m3 10 9-7 9 7M5 9v12h14V9"/><path d="M9 21v-8h6v8"/></>,
  trip: <><path d="m2 18 7-12 6 12H2Zm11 0 4-8 5 8h-9M9 6V3h5l-2 2h-3"/></>,
  check: <path d="m5 12 4 4L19 6"/>,
  search: <><circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/></>,
  close: <path d="m6 6 12 12M18 6 6 18"/>,
  shopping: <><path d="M4 8h16l-2 12H6L4 8ZM9 8V6a3 3 0 0 1 6 0v2"/></>,
  menu: <><path d="M5 7h14M5 12h14M5 17h14"/></>,
  arrow: <path d="M4 12h15m-5-5 5 5-5 5"/>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
};
export function Icon({name}: {name: IconName}) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}
export function Brand() {
  return <div className="brand"><span className="brand-mark" aria-hidden="true">p.</span><span>Pact</span></div>;
}
export function Alert({text, children}: {text: string; children?: ReactNode}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (text) {ref.current?.focus({preventScroll: true});ref.current?.scrollIntoView({block:'nearest',behavior:'auto'});} }, [text]);
  return text ? <div className="alert" role="alert" ref={ref} tabIndex={-1}><p>{text}</p>{children}</div> : null;
}
export function Loading({text = 'Loading your household…'}: {text?: string}) {
  return <div className="loading" role="status"><span className="spinner" aria-hidden="true"/>{text}</div>;
}
export function Avatar({name}: {name: string}) {
  const initials = nameInitials(name);
  return <span className="avatar" aria-hidden="true">{initials || '?'}</span>;
}
export function ScreenHeading({title, subtitle, children}: {title: string; subtitle?: string; children?: ReactNode}) {
  return <div className="screen-heading"><div><h1 tabIndex={-1} data-screen-heading>{title}</h1>{subtitle && <p className="muted">{subtitle}</p>}</div>{children}</div>;
}
export function FormHeader({title, context, onBack, disabled = false}: {title: string; context: string; onBack: () => void; disabled?: boolean}) {
  return <><div className="form-top"><button className="text-button" onClick={onBack} disabled={disabled}><Icon name="back"/>Back</button><span className="muted truncate">{context}</span></div><ScreenHeading title={title}/></>;
}
export function moveToTop() {
  window.scrollTo({top: 0, behavior: 'auto'});
  requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-screen-heading]')?.focus({preventScroll: true}));
}
