"use client";

import { useStepper } from "../stepper";

import { RoundDetails } from "./round-details";
import { CoInvestors } from "./co-investors";

const stepIndexes = {
  ROUND_DETAILS: 1,
  CO_INVESTORS: 2,
} as const;

function Steps() {
  const { currentStep } = useStepper();

  if (currentStep === stepIndexes["ROUND_DETAILS"]) {
    return <RoundDetails />;
  }

  if (currentStep === stepIndexes["CO_INVESTORS"]) {
    return <CoInvestors />;
  }

  return null;
}

export { Steps, stepIndexes };
