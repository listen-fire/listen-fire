"use client";

/**
 * `/settings/team` — who is on the team, who is invited, and the three acts an
 * admin has. Adding an address IS the invitation: nothing is emailed and the
 * person joins the next time they sign in, so the page says that rather than
 * promising a link. Removing a member signs them out.
 *
 */

import { useState } from "react";
import { UserMinus, UserPlus, X } from "lucide-react";

import { trpc } from "@/lib/trpc";
import { Button } from "@/components/ui";
import { usePageTitle } from "@/components/page-title";

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5">{children}</div>
  );
}

export default function TeamPage() {
  usePageTitle("Team — Listen-Fire");

  const overview = trpc.views.teamMembers.overview.useQuery();
  const utils = trpc.useUtils();
  const refresh = () => void utils.views.teamMembers.overview.invalidate();

  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [invited, setInvited] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const invite = trpc.views.teamMembers.invite.useMutation({
    onSuccess: () => {
      setInvited(email);
      setEmail("");
      setError(null);
      refresh();
    },
    onError: (e) => setError(e.message),
  });
  const revoke = trpc.views.teamMembers.revokeInvite.useMutation({
    onSuccess: refresh,
  });
  const remove = trpc.views.teamMembers.remove.useMutation({
    onSuccess: () => {
      setRemoveError(null);
      refresh();
    },
    onError: (e) => setRemoveError(e.message),
  });

  if (overview.isLoading || !overview.data) {
    return (
      <div className="py-10 text-center text-[13px] text-slate-400">Loading…</div>
    );
  }

  const { members, invites } = overview.data;
  const emailValid = /.+@.+\..+/.test(email);

  return (
    <div className="space-y-5">
      {/* Invite */}
      <Card>
        <p className="text-[13px] font-semibold text-slate-900">
          Add a teammate
        </p>
        <p className="mt-1 text-[12px] leading-relaxed text-slate-500">
          They join this workspace the next time they sign in with this address.
          Nothing is emailed — they just sign in with this address and land here.
        </p>
        <div className="mt-3 flex items-center gap-2">
          <input
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setInvited(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && emailValid) invite.mutate({ email });
            }}
            placeholder="teammate@company.com"
            disabled={invite.isLoading}
            data-testid="team-invite-email"
            className="w-64 max-w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[13px] text-slate-900 outline-none focus:border-primary/40 focus:ring-1 focus:ring-primary/20 disabled:bg-slate-50 disabled:text-slate-400"
          />
          <Button
            variant="primary"
            size="sm"
            onClick={() => invite.mutate({ email })}
            disabled={!emailValid || invite.isLoading}
            data-testid="team-invite-submit"
          >
            <UserPlus size={13} />
            {invite.isLoading ? "Adding…" : "Add"}
          </Button>
        </div>
        {error && (
          <p className="mt-2 text-[12px] text-red-600" data-testid="team-invite-error">
            {error}
          </p>
        )}
        {invited && !error && (
          <p className="mt-2 text-[12px] text-emerald-600" data-testid="team-invite-sent">
            {invited} can now sign in to this workspace.
          </p>
        )}
      </Card>

      {/* Pending invites */}
      {invites.length > 0 && (
        <Card>
          <p className="text-[13px] font-semibold text-slate-900">
            Invited, not yet signed in
          </p>
          <div className="mt-3 divide-y divide-slate-100">
            {invites.map((i) => (
              <div
                key={i.id}
                className="flex items-center justify-between gap-4 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-[13px] text-slate-700">{i.email}</p>
                  <p className="text-[11px] text-slate-400">
                    Added {new Date(i.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <button
                  onClick={() => revoke.mutate({ inviteId: i.id })}
                  disabled={revoke.isLoading}
                  className="flex shrink-0 items-center gap-1 text-[12px] font-medium text-slate-400 transition-colors hover:text-red-600"
                  data-testid="team-invite-revoke"
                >
                  <X size={12} />
                  Withdraw
                </button>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* Members */}
      <Card>
        <p className="text-[13px] font-semibold text-slate-900">Members</p>
        {removeError && (
          <p className="mt-2 text-[12px] text-red-600" data-testid="team-remove-error">
            {removeError}
          </p>
        )}
        <div className="mt-3 divide-y divide-slate-100">
          {members.map((m) => (
            <div
              key={m.userId}
              className="flex items-center justify-between gap-4 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-[13px] text-slate-700">
                  {m.username}
                </p>
                {m.email && (
                  <p className="truncate text-[11px] text-slate-400">{m.email}</p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-3">
                <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-500">
                  {m.access === "write" ? "Member" : "Read-only"}
                </span>
                <button
                  onClick={() => remove.mutate({ userId: m.userId })}
                  disabled={remove.isLoading}
                  className="flex items-center gap-1 text-[12px] font-medium text-slate-400 transition-colors hover:text-red-600"
                  data-testid="team-member-remove"
                >
                  <UserMinus size={12} />
                  Remove
                </button>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
