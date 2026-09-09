"use client";

/**
 * Shared page scaffolding and hierarchy primitives — the one place the
 * app's information hierarchy is defined. Every page composes these so
 * titles, sections, list rows, buttons and badges read identically
 * everywhere.
 *
 */

import Link from "next/link";

// ─── Page scaffold ────────────────────────────────────────────────────

export function PageHeader({
  title,
  badge,
  actions,
}: {
  title: React.ReactNode;
  badge?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-gray-100 px-5">
      <div className="flex min-w-0 items-center gap-2.5">
        <h1 className="truncate text-base font-semibold text-gray-900">
          {title}
        </h1>
        {badge}
      </div>
      {actions && (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      )}
    </div>
  );
}

const BODY_WIDTHS = {
  narrow: "max-w-2xl",
  default: "max-w-3xl",
  wide: "max-w-4xl",
} as const;

export function PageBody({
  width = "default",
  children,
}: {
  width?: keyof typeof BODY_WIDTHS;
  children: React.ReactNode;
}) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className={`mx-auto w-full px-6 pb-12 pt-8 ${BODY_WIDTHS[width]}`}>
        {children}
      </div>
    </div>
  );
}

export function PageIntro({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-8 text-[13px] leading-relaxed text-gray-500">{children}</p>
  );
}

export function SectionHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex items-end justify-between gap-3">
      <div className="flex min-w-0 items-baseline gap-2.5">
        <h2 className="shrink-0 text-[13px] font-semibold text-gray-900">
          {title}
        </h2>
        {subtitle && (
          <span className="truncate text-[12px] text-gray-400">{subtitle}</span>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

// ─── Lists ────────────────────────────────────────────────────────────

export function CardList({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`divide-y divide-gray-100 overflow-hidden rounded-xl border border-gray-100 ${className}`}
    >
      {children}
    </div>
  );
}

export function ListRow({
  href,
  children,
  className = "",
  testId,
}: {
  href?: string;
  children: React.ReactNode;
  className?: string;
  testId?: string;
}) {
  const base = `flex items-center gap-3 px-4 py-3 ${className}`;
  if (href) {
    return (
      <Link
        href={href}
        data-testid={testId}
        className={`${base} transition-colors hover:bg-gray-50`}
      >
        {children}
      </Link>
    );
  }
  return (
    <div data-testid={testId} className={base}>
      {children}
    </div>
  );
}

// ─── Buttons ──────────────────────────────────────────────────────────

const BUTTON_VARIANTS = {
  primary: "bg-primary text-white hover:bg-primary-600",
  secondary: "border border-gray-200 text-gray-700 hover:bg-gray-50",
  ghost: "text-gray-500 hover:bg-gray-100 hover:text-gray-700",
  danger: "bg-red-600 text-white hover:bg-red-700",
} as const;

const BUTTON_SIZES = {
  md: "rounded-lg px-3 py-1.5 text-[13px]",
  sm: "rounded-md px-2.5 py-1 text-[12px]",
} as const;

export function buttonClass({
  variant = "secondary",
  size = "md",
}: {
  variant?: keyof typeof BUTTON_VARIANTS;
  size?: keyof typeof BUTTON_SIZES;
} = {}) {
  return `inline-flex cursor-pointer items-center gap-1.5 font-medium transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-default disabled:opacity-40 ${BUTTON_SIZES[size]} ${BUTTON_VARIANTS[variant]}`;
}

export function Button({
  variant,
  size,
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: keyof typeof BUTTON_VARIANTS;
  size?: keyof typeof BUTTON_SIZES;
}) {
  return (
    <button
      {...props}
      className={`${buttonClass({ variant, size })} ${className}`}
    />
  );
}

export function ButtonLink({
  href,
  variant,
  size,
  className = "",
  children,
}: {
  href: string;
  variant?: keyof typeof BUTTON_VARIANTS;
  size?: keyof typeof BUTTON_SIZES;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`${buttonClass({ variant, size })} ${className}`}
    >
      {children}
    </Link>
  );
}

// ─── Badges ───────────────────────────────────────────────────────────

const BADGE_TONES = {
  gray: "bg-gray-100 text-gray-500",
  blue: "bg-blue-50 text-blue-600",
  emerald: "bg-emerald-50 text-emerald-700",
  amber: "bg-amber-50 text-amber-700",
  red: "bg-red-50 text-red-700",
  violet: "bg-violet-50 text-violet-600",
  sky: "bg-sky-50 text-sky-700",
  primary: "bg-primary-50 text-primary-700",
} as const;

export function Badge({
  tone = "gray",
  title,
  testId,
  children,
}: {
  tone?: keyof typeof BADGE_TONES;
  title?: string;
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      title={title}
      data-testid={testId}
      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${BADGE_TONES[tone]}`}
    >
      {children}
    </span>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────

export function EmptyState({
  icon,
  title,
  caption,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  caption?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-gray-200 px-6 py-10 text-center">
      {icon && <div className="text-gray-300">{icon}</div>}
      <div className="text-[13px] text-gray-500">{title}</div>
      {caption && (
        <div className="max-w-sm text-[12px] leading-relaxed text-gray-400">
          {caption}
        </div>
      )}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
