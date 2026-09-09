"use client";

/**
 * "Create automation" modal — the manual path for users who already know
 * what they want, skipping the conversational setup agent. Asks for a
 * name + a source (where events come from), creates a blank
 * `automations.trigger`, and navigates to its detail page so the user can
 * author "What happens".
 *
 * The source list comes from the server (`views.triggers.listCreatableSources`),
 * which folds the adapter manifests with the team's connected credentials.
 * Sources that need a connection the team hasn't authorised yet still
 * appear — flagged "connect first" — so the picker shows the full menu of
 * what the system supports rather than hiding capabilities.
 *
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { trpc } from "@/lib/trpc";

export function CreateAutomationModal({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const utils = trpc.useUtils();

  const { data: sources, isLoading: sourcesLoading } =
    trpc.views.triggers.listCreatableSources.useQuery();

  const [name, setName] = useState("");
  const [sourceKind, setSourceKind] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const createMut = trpc.views.triggers.createAutomation.useMutation({
    onSuccess: ({ id }) => {
      void utils.views.triggers.list.invalidate();
      router.push(`/automations/${id}`);
    },
    onError: (err) => setError(err.message),
  });

  // Connected sources lead; the ones that still need a connection sink to
  // the bottom so the obvious choices come first.
  const orderedSources = useMemo(() => {
    if (!sources) return [];
    return [...sources].sort((a, b) => {
      if (a.connected !== b.connected) return a.connected ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [sources]);

  const selected = orderedSources.find((s) => s.adapterType === sourceKind);
  const canSubmit =
    name.trim().length > 0 && sourceKind !== null && !createMut.isLoading;

  function handleSubmit() {
    if (!canSubmit || !sourceKind) return;
    setError(null);
    createMut.mutate({ name: name.trim(), sourceKind });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      onClick={() => !createMut.isLoading && onClose()}
      data-testid="create-automation-modal"
    >
      <div
        className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-[15px] font-semibold text-gray-900">
          New automation
        </h2>
        <p className="mt-1 text-[13px] leading-relaxed text-gray-500">
          Name it and pick where its events come from. You&rsquo;ll set up
          what it does next.
        </p>

        <div className="mt-4 space-y-4">
          <div>
            <label
              htmlFor="automation-name"
              className="block text-[12px] font-medium text-gray-700"
            >
              Name
            </label>
            <input
              id="automation-name"
              type="text"
              value={name}
              autoFocus
              maxLength={200}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canSubmit) handleSubmit();
              }}
              placeholder="e.g. New leads to CRM"
              className="mt-1 w-full rounded-md border border-gray-200 px-3 py-1.5 text-[13px] text-gray-900 outline-none focus:border-primary-400 focus:ring-1 focus:ring-primary-200"
              data-testid="create-automation-name"
            />
          </div>

          <div>
            <span className="block text-[12px] font-medium text-gray-700">
              Where events come from
            </span>
            {sourcesLoading ? (
              <div className="mt-2 space-y-1.5">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div
                    key={i}
                    className="h-9 animate-pulse rounded-md bg-gray-100"
                    style={{ animationDelay: `${i * 60}ms` }}
                  />
                ))}
              </div>
            ) : (
              <div
                className="mt-2 max-h-56 space-y-1.5 overflow-y-auto"
                data-testid="create-automation-sources"
              >
                {orderedSources.map((source) => {
                  const isSelected = source.adapterType === sourceKind;
                  return (
                    <button
                      key={source.adapterType}
                      type="button"
                      onClick={() => setSourceKind(source.adapterType)}
                      data-testid={`create-automation-source-${source.adapterType}`}
                      className={`flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-[13px] transition ${
                        isSelected
                          ? "border-primary-400 bg-primary-50/50"
                          : "border-gray-200 hover:bg-gray-50"
                      }`}
                    >
                      <span className="font-medium text-gray-900">
                        {source.name}
                      </span>
                      {!source.connected && (
                        <span className="shrink-0 rounded-full bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-700">
                          Connect first
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
            {selected && !selected.connected && (
              <p className="mt-2 text-[12px] leading-relaxed text-amber-700">
                {selected.name} isn&rsquo;t connected yet. You can create the
                automation now, then connect {selected.name} before it can
                run.
              </p>
            )}
          </div>
        </div>

        {error && (
          <p className="mt-3 text-[12px] text-red-600" data-testid="create-automation-error">
            {error}
          </p>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={createMut.isLoading}
            className="rounded-md border border-gray-200 px-3 py-1.5 text-[13px] font-medium text-gray-700 transition hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="rounded-md bg-primary-600 px-3 py-1.5 text-[13px] font-medium text-white shadow-sm transition hover:bg-primary-700 disabled:opacity-50"
            data-testid="create-automation-submit"
          >
            {createMut.isLoading ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
