"use client";

/**
 * Port of apps/app's AddRound/Stepper.tsx. Unlike AddInvestment's, this
 * stepper has a fixed step count, so steps are identified by index — kept as
 * it was rather than unified, because the two forms' validity rules differ.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

interface Step {
  id: number;
  isValid: boolean;
}

interface StepperContextType {
  currentStep: number;
  steps: Step[];
  goToNextStep: () => void;
  goToPreviousStep: () => void;
  goToStep: (step: number) => void;
  setStepValidity: (stepId: number, isValid: boolean) => void;
  canGoNext: boolean;
  canGoPrevious: boolean;
  isLastStep: boolean;
}

const StepperContext = createContext<StepperContextType | undefined>(undefined);

export function StepperProvider({
  children,
  totalSteps,
}: {
  children: ReactNode;
  totalSteps: number;
}) {
  const [currentStep, setCurrentStep] = useState(1);
  const [steps, setSteps] = useState<Step[]>(
    Array.from({ length: totalSteps }, (_, i) => ({
      id: i + 1,
      isValid: false,
    })),
  );

  const goToNextStep = useCallback(() => {
    if (currentStep < totalSteps) {
      setCurrentStep((prev) => prev + 1);
    }
  }, [totalSteps, setCurrentStep, currentStep]);

  const goToPreviousStep = useCallback(() => {
    if (currentStep > 1) {
      setCurrentStep((prev) => prev - 1);
    }
  }, [setCurrentStep, currentStep]);

  const goToStep = useCallback(
    (step: number) => {
      if (step >= 1 && step <= totalSteps) {
        setCurrentStep(step);
      }
    },
    [totalSteps, setCurrentStep],
  );

  const setStepValidity = useCallback((stepId: number, isValid: boolean) => {
    setSteps((prevSteps) =>
      prevSteps.map((step) =>
        step.id === stepId && step.isValid !== isValid
          ? { ...step, isValid }
          : step,
      ),
    );
  }, []);

  const value = useMemo(
    () => ({
      currentStep,
      steps,
      goToNextStep,
      goToPreviousStep,
      goToStep,
      setStepValidity,
      canGoNext: currentStep < totalSteps && steps[currentStep - 1].isValid,
      canGoPrevious: currentStep > 1,
      isLastStep: currentStep === totalSteps,
    }),
    [
      currentStep,
      steps,
      goToNextStep,
      goToPreviousStep,
      goToStep,
      setStepValidity,
      totalSteps,
    ],
  );

  return (
    <StepperContext.Provider value={value}>{children}</StepperContext.Provider>
  );
}

export function useStepper() {
  const context = useContext(StepperContext);
  if (context === undefined) {
    throw new Error("useStepper must be used within a StepperProvider");
  }
  return context;
}

export function Stepper() {
  const { currentStep, steps } = useStepper();

  return (
    <div className="flex w-full items-center gap-2">
      {steps.map((step, index) => {
        const isActive = step.id <= currentStep;
        return (
          <React.Fragment key={step.id}>
            {index > 0 && <div className="h-0.5 w-full bg-primary-100" />}
            <div
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[12px] ${
                isActive
                  ? step.id === currentStep
                    ? "bg-primary text-white"
                    : "bg-primary-300 text-white"
                  : "bg-gray-200 text-gray-500"
              }`}
            >
              {step.id}
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}
