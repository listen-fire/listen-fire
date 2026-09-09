"use client";

/**
 * Point-of-contact avatar + reassignment menu (ported from apps/app's
 * PointOfContactSection). Chakra's Menu/Portal collapses to a small local
 * dropdown; team members come from `teamMembers.overview` (no `readonly`
 * flag on that endpoint, so unlike apps/app's original every member is
 * offered rather than only write-access ones).
 */

import { useEffect, useRef, useState } from "react";

import { useToast } from "@/components/portfolio";
import { trpc } from "@/lib/trpc";

function initials(name: string | null): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return parts
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

export function OwnerPicker({
  legalEntityId,
  ownerName,
  ownerImageUrl,
}: {
  legalEntityId: string;
  ownerName: string | null;
  ownerImageUrl: string | null;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const toast = useToast();
  const utils = trpc.useUtils();
  const { data: teamOverview } = trpc.views.teamMembers.overview.useQuery(undefined, {
    enabled: open,
  });
  const { mutateAsync: updatePointOfContact, isLoading } =
    trpc.views.investments.updatePointOfContact.useMutation();

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  async function assign(pointOfContactUserId: string | null) {
    try {
      await updatePointOfContact({ legalEntityId, pointOfContactUserId });
      toast.success("Point of contact updated");
      void utils.views.investments.getPortfolioInvestments.invalidate();
    } catch {
      toast.error("Couldn't update point of contact");
    }
    setOpen(false);
  }

  return (
    <div ref={ref} className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        title={ownerName ?? "Unassigned"}
        onClick={() => setOpen((v) => !v)}
        disabled={isLoading}
        className="flex h-7 w-7 items-center justify-center overflow-hidden rounded-full bg-gray-100 text-[11px] font-medium text-gray-500 ring-1 ring-white hover:ring-gray-200 disabled:opacity-50"
      >
        {ownerImageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- external avatar
          <img src={ownerImageUrl} alt={ownerName ?? ""} className="h-full w-full object-cover" />
        ) : (
          initials(ownerName)
        )}
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 max-h-64 w-48 overflow-y-auto rounded-lg border border-gray-100 bg-white py-1 shadow-lg">
          <button
            type="button"
            onClick={() => void assign(null)}
            className="block w-full px-3 py-1.5 text-left text-[12px] text-gray-500 hover:bg-gray-50"
          >
            None
          </button>
          {teamOverview?.members.map((member) => (
            <button
              key={member.userId}
              type="button"
              onClick={() => void assign(member.userId)}
              className="block w-full truncate px-3 py-1.5 text-left text-[12px] text-gray-700 hover:bg-gray-50"
            >
              {member.username}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
