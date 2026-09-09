"use client";

import { useEffect } from "react";
import { useFormikContext } from "formik";
import { Landmark } from "lucide-react";

import { trpc } from "@/lib/trpc";
import { Field, FormSelect } from "@/components/portfolio";

import type { FormValues } from "../types";
import { useStepper } from "../stepper";

import { EquityDetailsInner } from "./equity-details";

const ICON = "h-4 w-4 text-gray-400";

export function SecondaryDetails() {
  const { values, setFieldValue } = useFormikContext<FormValues>();
  const { setStepValidity } = useStepper();

  const { mutateAsync: getOtherInvestors } =
    trpc.views.portfolio.company.getOtherInvestors.useMutation();

  useEffect(() => {
    if (
      values.seller &&
      values.sellerName &&
      values.pricePerShare &&
      values.pricePerShareCurrency &&
      values.numberOfShares
    ) {
      setStepValidity("HEAVY_DETAIL", true);
    } else {
      setStepValidity("HEAVY_DETAIL", false);
    }
  }, [values, setStepValidity]);

  return (
    <div className="flex w-full flex-col items-stretch gap-6">
      <Field icon={<Landmark className={ICON} />} label="Seller" required>
        <FormSelect<string>
          autoFocus
          placeholder="Select a seller"
          value={
            values.seller
              ? {
                  label: values.sellerName || values.seller,
                  value: values.seller,
                }
              : undefined
          }
          setValue={(value) => {
            setFieldValue("seller", value?.value);
            setFieldValue("sellerName", value?.label);
          }}
          load={async (inputValue) => {
            const investors = await getOtherInvestors({
              entityId: values.entity === "NEW" ? undefined : values.entity,
              search: inputValue,
            });
            return investors.map((investor) => ({
              label: investor.name,
              value: investor.id,
            }));
          }}
          onCreateOption={(name: string) => {
            setFieldValue("seller", "NEW");
            setFieldValue("sellerName", name);
            return "NEW";
          }}
        />
      </Field>
      <EquityDetailsInner />
    </div>
  );
}
