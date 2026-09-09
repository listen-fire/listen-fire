"use client";

import { useFormikContext } from "formik";

import { FormModal } from "@/components/portfolio";

import { AddInvestmentForm } from "./form";
import { Footer } from "./footer";
import { StepperProvider, Stepper } from "./stepper";
import { Steps, stepIndexes } from "./steps";
import type { Entity, FormValues } from "./types";
import { useResetFormOnClose } from "./use-reset-form-on-close";

export function AddInvestment({
  entity,
  isOpen,
  onClose,
}: {
  entity?: Entity | null;
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  return (
    <AddInvestmentForm entity={entity} onClose={onClose}>
      <StepperProvider initialStepIndexMap={stepIndexes}>
        <ResetFormOnClose isOpen={isOpen} />
        <Body isOpen={isOpen} onClose={onClose} />
      </StepperProvider>
    </AddInvestmentForm>
  );
}

function ResetFormOnClose({ isOpen }: { isOpen: boolean }) {
  useResetFormOnClose({ isOpen });
  return null;
}

function Body({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const { values } = useFormikContext<FormValues>();
  const title = values["entityName"]
    ? `Add Investment in ${values["entityName"]}`
    : "Add Investment";

  return (
    <FormModal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      size="lg"
      footer={<Footer />}
    >
      <div className="flex min-h-[360px] w-full flex-col items-stretch gap-[30px]">
        <Stepper />
        <Steps />
      </div>
    </FormModal>
  );
}

export type { Entity };
