"use client";

/**
 * The stepper footer is five conditionally-shown buttons, not the shared
 * Cancel/Save pair — so it keeps its own implementation and only borrows
 * `buttonClass` for the look.
 */

import { useFormikContext } from "formik";

import { buttonClass } from "@/components/ui";

import { useStepper } from "./stepper";
import type { FormValues } from "./types";

export function Footer() {
  const {
    currentStepKey,
    currentStep,
    totalSteps,
    canGoNext,
    canGoPrevious,
    goToNextStep,
    goToPreviousStep,
    isLastStep,
    stepIsValid,
    allStepsValid,
  } = useStepper();
  const { submitForm, isSubmitting } = useFormikContext<FormValues>();

  const showSaveAndAddLater =
    stepIsValid("BASIC_INFO") && !allStepsValid && isLastStep;
  const showSkip =
    currentStepKey !== "BASIC_INFO" &&
    currentStep !== totalSteps &&
    !stepIsValid(currentStepKey);

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
          disabled={!allStepsValid || isSubmitting}
          className={buttonClass({ variant: "primary" })}
        >
          {isSubmitting ? "Saving…" : "Save"}
        </button>
      )}
    </div>
  );
}
