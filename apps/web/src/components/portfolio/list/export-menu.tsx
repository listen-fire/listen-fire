"use client";

/**
 * CSV export dropdown — ported from apps/app's Header.tsx download Menu,
 * minus the Google Sheets item (V-13: `pushToGoogleSheets` is deleted).
 */

import { useEffect, useRef, useState } from "react";
import { Download } from "lucide-react";

import { FormModal, useDisclosure } from "@/components/portfolio";
import { trpc } from "@/lib/trpc";
import { downloadCsv } from "./csv";
import { toApiFilter, toApiConfig } from "./api-params";
import type { PortfolioConfig, PortfolioFilter } from "./types";

export function ExportMenu({
  filter,
  config,
}: {
  filter: PortfolioFilter;
  config: PortfolioConfig;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const movementModal = useDisclosure();

  const { mutateAsync: getCSVExport, isLoading: csvLoading } =
    trpc.views.investments.getCSVExport.useMutation();
  const { mutateAsync: getPerCompanyMovementExport, isLoading: movementLoading } =
    trpc.views.investments.getPerCompanyMovementExport.useMutation();

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  async function exportCsv() {
    setOpen(false);
    const rows = await getCSVExport({
      filter: toApiFilter(filter),
      config: toApiConfig(config),
      grouping: filter.grouping,
    });
    const dateSlug = (config.valuationDate ? new Date(config.valuationDate) : new Date())
      .toISOString()
      .slice(0, 10);
    downloadCsv(rows, `listen-fire_export_${dateSlug}.csv`);
  }

  async function exportMovement({ fromDate, toDate }: { fromDate: string; toDate: string }) {
    const rows = await getPerCompanyMovementExport({
      filter: toApiFilter(filter),
      config: toApiConfig(config),
      range: { from: fromDate, to: toDate },
    });
    downloadCsv(rows, `per_company_movement_export_${new Date().toISOString().slice(0, 10)}.csv`);
    movementModal.onClose();
  }

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={csvLoading}
        className="flex h-8 items-center gap-1.5 rounded-lg border border-gray-200 px-2.5 text-[13px] text-gray-600 hover:bg-gray-50 disabled:opacity-50"
      >
        <Download size={14} />
        Export
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-48 rounded-lg border border-gray-100 bg-white py-1 shadow-lg">
          <button
            type="button"
            onClick={() => void exportCsv()}
            className="block w-full px-3 py-1.5 text-left text-[13px] text-gray-700 hover:bg-gray-50"
          >
            Export CSV
          </button>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              movementModal.onOpen();
            }}
            className="block w-full px-3 py-1.5 text-left text-[13px] text-gray-700 hover:bg-gray-50"
          >
            Movement CSV
          </button>
        </div>
      )}

      <MovementExportModal
        isOpen={movementModal.isOpen}
        onClose={movementModal.onClose}
        onSubmit={exportMovement}
        isLoading={movementLoading}
      />
    </div>
  );
}

function MovementExportModal({
  isOpen,
  onClose,
  onSubmit,
  isLoading,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (range: { fromDate: string; toDate: string }) => void;
  isLoading: boolean;
}) {
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");

  useEffect(() => {
    if (!isOpen) {
      setFromDate("");
      setToDate("");
    }
  }, [isOpen]);

  return (
    <FormModal
      isOpen={isOpen}
      onClose={onClose}
      title="Export movement CSV"
      footer={
        <button
          type="button"
          disabled={isLoading || !fromDate || !toDate}
          onClick={() => onSubmit({ fromDate, toDate })}
          className="rounded-lg bg-primary px-3 py-1.5 text-[13px] font-medium text-white hover:bg-primary-600 disabled:opacity-50"
        >
          Export
        </button>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-gray-500">From</span>
          <input
            type="date"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
            className="w-full rounded-md border border-gray-200 px-2 py-1.5 text-[13px]"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-gray-500">To</span>
          <input
            type="date"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
            className="w-full rounded-md border border-gray-200 px-2 py-1.5 text-[13px]"
          />
        </label>
      </div>
    </FormModal>
  );
}
