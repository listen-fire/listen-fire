"use client";

import { useEffect } from "react";
import { useFormikContext } from "formik";
import { Landmark } from "lucide-react";

import { trpc } from "@/lib/trpc";
import { Field, FormSelect } from "@/components/portfolio";

import type { FormValues } from "../types";
import { useStepper } from "../stepper";

const ICON = "h-4 w-4 text-gray-400";

export function SPVDetails() {
  const { values, setFieldValue } = useFormikContext<FormValues>();
  const { setStepValidity } = useStepper();

  const { mutateAsync: getSPVsForEntity } =
    trpc.views.portfolio.company.getSPVsForEntity.useMutation();

  useEffect(() => {
    if (values.spv && values.spvName) {
      setStepValidity("HEAVY_DETAIL", true);
    } else {
      setStepValidity("HEAVY_DETAIL", false);
    }
  }, [values, setStepValidity]);

  return (
    <div className="flex w-full flex-col items-stretch gap-6">
      <Field icon={<Landmark className={ICON} />} label="SPV" required>
        <FormSelect<string>
          autoFocus
          loading={false}
          placeholder="SPV name"
          value={
            values.spv && values.spvName
              ? {
                  label: values.spvName,
                  value: values.spv,
                }
              : undefined
          }
          setValue={(value) => {
            setFieldValue("spv", value?.value);
            setFieldValue("spvName", value?.label);
          }}
          load={async () => {
            const spvs =
              values.entity && values.entity !== "NEW"
                ? await getSPVsForEntity({ entityId: values.entity })
                : [];
            return spvs.map((spv) => ({ label: spv.name, value: spv.id }));
          }}
          onCreateOption={(name: string) => {
            setFieldValue("spv", "NEW");
            setFieldValue("spvName", name);
            return "NEW";
          }}
        />
      </Field>
    </div>
  );
}
