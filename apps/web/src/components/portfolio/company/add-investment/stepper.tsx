"use client";

/**
 * Port of apps/app's AddInvestment/Stepper.tsx. The step *set* is dynamic —
 * `setStepIndexMap` swaps between the company ladder (basic → light → heavy →
 * co-investors) and the fund ladder (basic → fund → co-investors) — so a step
 * is identified by its key, never by its position.
 */

import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

interface StepperContextType {
  currentStep: number;
  currentStepKey: string;
  setStepIndexMap: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  goToNextStep: () => void;
  goToPreviousStep: () => void;
  goToStep: (step: number) => void;
  setStepValidity: (stepId: string, isValid: boolean) => void;
  stepIsValid: (stepId: string) => boolean;
  allStepsValid: boolean;
  canGoNext: boolean;
  canGoPrevious: boolean;
  isLastStep: boolean;
  totalSteps: number;
}

const StepperContext = createContext<StepperContextType | undefined>(undefined);

export function StepperProvider({
  children,
  initialStepIndexMap,
}: {
  children: ReactNode;
  initialStepIndexMap: Record<string, number>;
}) {
  const [stepIndexMap, setStepIndexMap] = useState(initialStepIndexMap);
  const [currentStep, setCurrentStep] = useState(1);
  const [validityMap, setValidityMap] = useState<Record<string, boolean>>({});

  const totalSteps = useMemo(
    () => Object.keys(stepIndexMap).length,
    [stepIndexMap],
  );
  const currentStepKey = useMemo(
    () => Object.keys(stepIndexMap)[currentStep - 1],
    [stepIndexMap, currentStep],
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

  const setStepValidity = useCallback((stepName: string, isValid: boolean) => {
    setValidityMap((prev) =>
      prev[stepName] === isValid ? prev : { ...prev, [stepName]: isValid },
    );
  }, []);

  const value = useMemo(
    () => ({
      setStepIndexMap,
      currentStep,
      currentStepKey,
      goToNextStep,
      goToPreviousStep,
      goToStep,
      setStepValidity,
      stepIsValid: (stepName: string) => validityMap[stepName] === true,
      allStepsValid: Object.keys(stepIndexMap).every(
        (key) => validityMap[key] === true,
      ),
      canGoNext: currentStep < totalSteps && validityMap[currentStepKey] === true,
      canGoPrevious: currentStep > 1,
      isLastStep: currentStep === totalSteps,
      totalSteps,
    }),
    [
      currentStep,
      currentStepKey,
      goToNextStep,
      goToPreviousStep,
      goToStep,
      setStepValidity,
      totalSteps,
      setStepIndexMap,
      validityMap,
      stepIndexMap,
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
  const { currentStep, totalSteps } = useStepper();

  return (
    <div className="flex w-full items-center gap-2">
      {Array.from({ length: totalSteps }).map((_, index) => {
        const isActive = index + 1 <= currentStep;
        return (
          <React.Fragment key={index + 1}>
            {index > 0 && <div className="h-0.5 w-full bg-primary-100" />}
            <div
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[12px] ${
                isActive
                  ? index + 1 === currentStep
                    ? "bg-primary text-white"
                    : "bg-primary-300 text-white"
                  : "bg-gray-200 text-gray-500"
              }`}
            >
              {index + 1}
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );
}
