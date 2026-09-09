"use client";

import { useFormikContext } from "formik";

import { buttonClass } from "@/components/ui";

import { useStepper } from "./stepper";
import type { FormValues } from "./types";

export function Footer() {
  const {
    steps,
    currentStep,
    canGoNext,
    canGoPrevious,
    goToNextStep,
    goToPreviousStep,
    isLastStep,
  } = useStepper();
  const { submitForm, isSubmitting } = useFormikContext<FormValues>();

  const showSaveAndAddLater =
    currentStep === steps.length &&
    !steps[steps.length - 1].isValid &&
    steps[0].isValid;
  const showSkip =
    currentStep !== 1 &&
    currentStep !== steps.length &&
    !steps[currentStep - 1].isValid;

  return (
    <div className="flex w-full items-center justify-end gap-3">
      {showSaveAndAddLater && (
        <button
          type="button"
          onClick={submitForm}
          disabled={isSubmitting}
          className={buttonClass({ variant: "ghost" })}
        >
          Save and add details later
        </button>
      )}
      {showSkip && (
        <button
          type="button"
          onClick={goToNextStep}
          className={buttonClass({ variant: "ghost" })}
        >
          Skip
        </button>
      )}
      {canGoPrevious && (
        <button
          type="button"
          onClick={goToPreviousStep}
          className={buttonClass({ variant: "secondary" })}
        >
          Back
        </button>
      )}
      {!isLastStep && (
        <button
          type="button"
          onClick={goToNextStep}
          disabled={!canGoNext}
          className={buttonClass({ variant: "primary" })}
        >
          Next
        </button>
      )}
      {isLastStep && (
        <button
          type="button"
          onClick={submitForm}
          disabled={!steps[currentStep - 1].isValid || isSubmitting}
          className={buttonClass({ variant: "primary" })}
        >
          {isSubmitting ? "Saving…" : "Save"}
        </button>
      )}
    </div>
  );
}
