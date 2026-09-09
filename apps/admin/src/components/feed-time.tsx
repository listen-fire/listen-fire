'use client';

import { trpc } from '@/lib/trpc';

// The timestamp doubles as the link to this request's Render logs. It reuses the
// server-side getLogsUrl helper (same as RequestIdLink) and, like that
// component, is a role="link" span that stops propagation — safe to sit inside
// the row's own <Link>, whose click goes to the event detail instead.
export function FeedTime({ label, requestId }: { label: string; requestId: string | null }) {
  const getLogsUrl = trpc.views.admin.logs.getLogsUrl.useMutation({
    // Null when this deployment is not on Render — nothing to open.
    onSuccess: (url) => url && window.open(url, '_blank', 'noopener,noreferrer'),
  });

  if (!requestId) {
    return <span className="shrink-0 text-[12px] tabular-nums text-gray-400">{label}</span>;
  }

  const open = () => getLogsUrl.mutate({ requestId });

  return (
    <span
      role="link"
      tabIndex={0}
      title={`View logs · req ${requestId.slice(0, 8)}`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        open();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          e.stopPropagation();
          open();
        }
      }}
      className="shrink-0 cursor-pointer text-[12px] tabular-nums text-gray-400 underline decoration-dotted decoration-gray-300 underline-offset-2 hover:text-blue-600 hover:decoration-blue-600"
    >
      {label}
    </span>
  );
}
