"use client";

import { FormModal } from "@/components/portfolio";

import { AddRoundForm } from "./form";
import { Footer } from "./footer";
import { StepperProvider, Stepper } from "./stepper";
import { Steps, stepIndexes } from "./steps";
import type { Entity } from "./types";
import { useResetFormOnClose } from "./use-reset-form-on-close";

export function AddRound({
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
    <AddRoundForm entity={entity} onClose={onClose}>
      <StepperProvider totalSteps={Object.keys(stepIndexes).length}>
        <ResetFormOnClose isOpen={isOpen} />
        <FormModal
          isOpen={isOpen}
          onClose={onClose}
          title="Add Round"
          size="lg"
          footer={<Footer />}
        >
          <div className="flex h-[380px] w-full flex-col items-stretch gap-[30px]">
            <Stepper />
            <Steps />
          </div>
        </FormModal>
      </StepperProvider>
    </AddRoundForm>
  );
}

function ResetFormOnClose({ isOpen }: { isOpen: boolean }) {
  useResetFormOnClose({ isOpen });
  return null;
}

export type { Entity };
