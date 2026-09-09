"use client";

/**
 * The exit / realisation surface: acquisitions, secondary sales,
 * dividends, wind downs and fund distributions.
 *
 * apps/app had one `AddDistribution` component with a transaction-type
 * dropdown, but all five call sites passed `type` explicitly — the
 * dropdown was unreachable. Split here into one component per exit kind,
 * which is what the funding section actually opens.
 */

import { FormModal } from "@/components/portfolio";

import { AcquisitionFormBody } from "./acquisition-body";
import { DividendsFormBody } from "./dividends-body";
import {
  AcquisitionForm,
  DividendsForm,
  FundDistributionForm,
  LiquidationForm,
  SecondarySaleForm,
} from "./form";
import { FundDistributionFormBody } from "./fund-distribution-body";
import { LiquidationFormBody } from "./liquidation-body";
import { SecondarySaleFormBody } from "./secondary-sale-body";
import { ResetFormOnClose } from "./shared";
import type { AddDistributionProps } from "./types";

export function AddAcquisition({
  company,
  isOpen,
  onClose,
}: AddDistributionProps) {
  return (
    <FormModal
      isOpen={isOpen}
      onClose={onClose}
      title="Add Acquisition"
      size="lg"
    >
      <AcquisitionForm company={company} onClose={onClose}>
        <ResetFormOnClose isOpen={isOpen} />
        <AcquisitionFormBody onClose={onClose} />
      </AcquisitionForm>
    </FormModal>
  );
}

export function AddSecondarySale({
  company,
  isOpen,
  onClose,
}: AddDistributionProps) {
  return (
    <FormModal
      isOpen={isOpen}
      onClose={onClose}
      title="Add Secondary Sale"
      size="lg"
    >
      <SecondarySaleForm company={company} onClose={onClose}>
        <ResetFormOnClose isOpen={isOpen} />
        <SecondarySaleFormBody company={company} />
      </SecondarySaleForm>
    </FormModal>
  );
}

export function AddDividends({
  company,
  isOpen,
  onClose,
}: AddDistributionProps) {
  return (
    <FormModal isOpen={isOpen} onClose={onClose} title="Add Dividends" size="lg">
      <DividendsForm company={company} onClose={onClose}>
        <ResetFormOnClose isOpen={isOpen} />
        <DividendsFormBody onClose={onClose} />
      </DividendsForm>
    </FormModal>
  );
}

export function AddLiquidation({
  company,
  isOpen,
  onClose,
}: AddDistributionProps) {
  return (
    <FormModal isOpen={isOpen} onClose={onClose} title="Add Wind Down" size="lg">
      <LiquidationForm company={company} onClose={onClose}>
        <ResetFormOnClose isOpen={isOpen} />
        <LiquidationFormBody company={company} onClose={onClose} />
      </LiquidationForm>
    </FormModal>
  );
}

export function AddFundDistribution({
  company,
  isOpen,
  onClose,
}: AddDistributionProps) {
  return (
    <FormModal
      isOpen={isOpen}
      onClose={onClose}
      title="Add Fund Distribution"
      size="lg"
    >
      <FundDistributionForm company={company} onClose={onClose}>
        <ResetFormOnClose isOpen={isOpen} />
        <FundDistributionFormBody onClose={onClose} />
      </FundDistributionForm>
    </FormModal>
  );
}

export type { AddDistributionProps };
