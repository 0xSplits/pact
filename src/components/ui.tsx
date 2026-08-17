// Small reusable UI primitives for React pages. Each maps onto the
// design-system classes in src/app.css (.cta, .deflist, .notice, .act, ...)
// so vanilla pages and React pages render identically.
import type { ButtonHTMLAttributes, ReactNode } from "react";
import type { Address } from "viem";
import { basescanAddress, shortAddr } from "../lib/format.ts";

const cx = (...parts: Array<string | false | null | undefined>) =>
  parts.filter(Boolean).join(" ");

export const Loading = () => <span className="t-muted">Loading…</span>;

// Check-mark glyph shared by the wallet menu, buy status dot, and status badge.
export const CheckIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="3"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="m5 12 4 4L19 6" />
  </svg>
);

// Muted secondary text, usually paired with a primary value inside a Field.
export const Sub = ({ children }: { children: ReactNode }) => (
  <span className="t-muted">{children}</span>
);

export function SectionTitle({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <h2 className={cx("mt-0 text-lg font-bold mb-2", className)}>{children}</h2>
  );
}

export function DefList({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <dl className={cx("deflist", className)}>{children}</dl>;
}

// One label/value row inside a DefList. `align` covers the dd layouts used in
// the app: 'baseline' value pairs, 'center' icon rows, 'none' plain block.
export function Field({
  label,
  loading = false,
  align = "baseline",
  children,
}: {
  label: ReactNode;
  loading?: boolean;
  align?: "baseline" | "center" | "none";
  children?: ReactNode;
}) {
  const dd =
    align === "baseline"
      ? "flex items-baseline space-x-2"
      : align === "center"
        ? "flex items-center gap-2"
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
export function AddressLink({
  address,
  href,
  className = "value-link",
  children,
}: {
  address?: Address;
  href?: string;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <a
      className={className}
      href={href || basescanAddress(address || "")}
      target="_blank"
      rel="noreferrer"
    >
      {children ?? shortAddr(address)}
    </a>
  );
}

const BUTTON_VARIANTS = {
  primary: "cta",
  secondary: "secondary-action",
  warning: "warning-action",
};

export function Button({
  variant = "primary",
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof BUTTON_VARIANTS;
}) {
  return (
    <button
      className={cx(
        BUTTON_VARIANTS[variant] || BUTTON_VARIANTS.primary,
        className,
      )}
      type="button"
      {...props}
    >
      {children}
    </button>
  );
}

// Inline text-style button (.act) used in table rows. tone: 'danger' | 'muted'.
export function TextButton({
  tone,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: "danger" | "muted";
}) {
  return (
    <button className={cx("act", tone, className)} type="button" {...props}>
      {children}
    </button>
  );
}

// Signature block shared by the agreement pages: a script-font preview of the
// typed name above the actual input, wired to the same data-error tooltip as
// the other agreement fields (pair with useErrorTip on the page).
export function SignatureBlock({
  id,
  value,
  error,
  className,
  onChange,
  onBlur,
}: {
  id: string;
  value: string;
  error?: string | undefined;
  className?: string | undefined;
  onChange: (value: string) => void;
  onBlur: () => void;
}) {
  return (
    <div className={cx("signature-row", className)}>
      <div className="signature-inner">
        <span className="signature-by">By:</span>
        <div className="signature-block">
          <div className="signature-preview" aria-hidden="true">
            {value || "\u00a0"}
          </div>
          <label className="sr-only" htmlFor={id}>
            Name
          </label>
          <input
            id={id}
            className={cx("blank signature-input", error && "error")}
            data-error={error || undefined}
            aria-invalid={!!error}
            type="text"
            placeholder="Name (required, private)"
            autoComplete="name"
            required
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onBlur={onBlur}
          />
        </div>
      </div>
    </div>
  );
}

// Dotted notice box.
export function Notice({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return <div className={cx("notice", className)}>{children}</div>;
}
