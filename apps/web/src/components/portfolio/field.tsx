"use client";

/**
 * Port of apps/app's Portfolio/Profile/Field.tsx (VStack + HStack over
 * Chakra) — label row with an icon, a required-asterisk or "(optional)"
 * hint, optional right-aligned content, then the control underneath.
 */

export function Field({
  icon,
  label,
  children,
  required,
  rightContent,
  className = "",
}: {
  icon: React.ReactNode;
  label: string;
  children?: React.ReactNode;
  required?: boolean;
  rightContent?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex flex-col items-stretch gap-2 ${className}`}>
      <div className="flex items-center gap-2">
        {icon}
        <span className="text-[13px] font-medium text-gray-900">
          {label}
          {required ? (
            <span className="ml-0.5 text-red-500">*</span>
          ) : (
            <span className="ml-1 text-[12px] text-gray-400">(optional)</span>
          )}
        </span>
        {rightContent && (
          <div className="ml-auto flex items-center gap-2">{rightContent}</div>
        )}
      </div>
      {children}
    </div>
  );
}
