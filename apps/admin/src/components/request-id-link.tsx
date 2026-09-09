'use client';

import { trpc } from '@/lib/trpc';

// Renders a request id as a link to its Render logs. Reuses the server-side
// getLogsUrl helper (which owns the Render service id) rather than rebuilding
// the dashboard URL here. Safe to nest inside a ListRow <Link>: it stops the
// click from bubbling to the row's navigation.
export function RequestIdLink({
  requestId,
  className = '',
}: {
  requestId: string;
  className?: string;
}) {
  const getLogsUrl = trpc.views.admin.logs.getLogsUrl.useMutation({
    // Null when this deployment is not on Render — nothing to open.
    onSuccess: (url) => url && window.open(url, '_blank', 'noopener,noreferrer'),
  });

  const open = () => getLogsUrl.mutate({ requestId });

  return (
    <span
      role="link"
      tabIndex={0}
      title="Open Render logs for this request"
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
      className={`cursor-pointer font-mono text-blue-600 hover:underline ${className}`}
    >
      req {requestId.slice(0, 8)}
    </span>
  );
}
