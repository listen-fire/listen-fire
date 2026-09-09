"use client";

import { useFormikContext } from "formik";
import { useEffect } from "react";

import { useStepper } from "./stepper";

export function useResetFormOnClose({ isOpen }: { isOpen: boolean }) {
  const { resetForm } = useFormikContext();
  const { goToStep } = useStepper();

  useEffect(() => {
    if (!isOpen) {
      resetForm();
      goToStep(1);
    }
  }, [isOpen, resetForm, goToStep]);
}
