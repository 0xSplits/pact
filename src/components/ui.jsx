// Small reusable UI primitives for React pages. Each maps onto the
// design-system classes in src/app.css (.cta, .deflist, .notice, .act, ...)
// so vanilla pages and React pages render identically.
import React from 'react';
import { basescanAddress, shortAddr } from '../lib/format.js';

const cx = (...parts) => parts.filter(Boolean).join(' ');

export const Loading = () => <span className="t-muted">Loading…</span>;

// Muted secondary text, usually paired with a primary value inside a Field.
export const Sub = ({ children }) => <span className="t-muted">{children}</span>;

export function SectionTitle({ className, children }) {
  return <h2 className={cx('mt-0 text-lg font-bold mb-2', className)}>{children}</h2>;
}

export function DefList({ className, children }) {
  return <dl className={cx('deflist', className)}>{children}</dl>;
}

// One label/value row inside a DefList. `align` covers the dd layouts used in
// the app: 'baseline' value pairs, 'center' icon rows, 'none' plain block.
export function Field({ label, loading = false, align = 'baseline', children }) {
  const dd = align === 'baseline' ? 'flex items-baseline space-x-2'
    : align === 'center' ? 'flex items-center gap-2'
    : undefined;
  return (
    <>
      <dt>{label}</dt>
      <dd className={dd}>{loading ? <Loading /> : children}</dd>
    </>
  );
}

// External link for an onchain address. Defaults to Basescan and the
// shortened address; pass href/children to point elsewhere (e.g. Splits
// Explorer) or to change the link text.
export function AddressLink({ address, href, className = 'value-link', children }) {
  return (
    <a className={className} href={href || basescanAddress(address)} target="_blank" rel="noreferrer">
      {children ?? shortAddr(address)}
    </a>
  );
}

const BUTTON_VARIANTS = { primary: 'cta', secondary: 'secondary-action', warning: 'warning-action' };

export function Button({ variant = 'primary', className, children, ...props }) {
  return (
    <button className={cx(BUTTON_VARIANTS[variant] || BUTTON_VARIANTS.primary, className)} type="button" {...props}>
      {children}
    </button>
  );
}

// Inline text-style button (.act) used in table rows. tone: 'danger' | 'muted'.
export function TextButton({ tone, className, children, ...props }) {
  return (
    <button className={cx('act', tone, className)} type="button" {...props}>
      {children}
    </button>
  );
}

// Dotted notice box.
export function Notice({ className, children }) {
  return <div className={cx('notice', className)}>{children}</div>;
}
