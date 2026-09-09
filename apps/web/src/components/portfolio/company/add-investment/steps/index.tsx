"use client";

import { useEffect } from "react";
import { useFormikContext } from "formik";

import { useStepper } from "../stepper";
import type { FormValues } from "../types";

import { BasicInfo } from "./basic-info";
import { LightDetail } from "./light-detail";
import { EquityDetails } from "./equity-details";
import { FundDetails } from "./fund-details";
import { ConvertibleDetails } from "./convertible-details";
import { SPVDetails } from "./spv-details";
import { SecondaryDetails } from "./secondary-details";
import { CoInvestors } from "./co-investors";

const stepIndexes = {
  BASIC_INFO: 1,
  LIGHT_DETAIL: 2,
  HEAVY_DETAIL: 3,
  CO_INVESTORS: 4,
} as const;

const fundStepIndexes = {
  BASIC_INFO: 1,
  FUND_DETAIL: 2,
  CO_INVESTORS: 3,
} as const;

function Steps() {
  const { setStepIndexMap, currentStepKey } = useStepper();
  const { values } = useFormikContext<FormValues>();

  useEffect(() => {
    if (values.entityType === "FUND") {
      setStepIndexMap(fundStepIndexes);
    } else {
      setStepIndexMap(stepIndexes);
    }
  }, [values, setStepIndexMap]);

  if (currentStepKey === "BASIC_INFO") {
    return <BasicInfo />;
  }

  if (currentStepKey === "LIGHT_DETAIL") {
    return <LightDetail />;
  }

  if (currentStepKey === "FUND_DETAIL") {
    return <FundDetails />;
  }

  if (currentStepKey === "HEAVY_DETAIL") {
    switch (values.investmentType) {
      case "EQUITY":
        return <EquityDetails />;
      case "CONVERTIBLE":
        return <ConvertibleDetails />;
      case "SPV":
        return <SPVDetails />;
      case "SECONDARY":
        return <SecondaryDetails />;
      default:
        return null;
    }
  }

  if (currentStepKey === "CO_INVESTORS") {
    return <CoInvestors />;
  }

  return null;
}

export { Steps, stepIndexes };
