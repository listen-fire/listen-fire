/**
 * Port of apps/app's Portfolio/Profile/Section.tsx — a titled card wrapper
 * used to group a company page's sections (Overview, Investors, Updates, …).
 */

export function Section({
  title,
  action,
  children,
}: {
  title?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-stretch gap-3">
      {(title || action) && (
        <div className="flex items-center justify-between gap-3">
          {title && (
            <h2 className="text-[15px] font-medium text-gray-900">{title}</h2>
          )}
          {action}
        </div>
      )}
      <div className="rounded-xl border border-gray-100 p-4">{children}</div>
    </div>
  );
}
