"use client";

/**
 * Near-duplicate of AddInvestment's co-investors step, kept separate because
 * it differs: it addresses steps by index, is titled "Add Investors" (these
 * are the round's investors, not co-investors alongside ours), always shows
 * the remove button, and has no empty state.
 */

import { useEffect, useState } from "react";
import { useFormikContext } from "formik";
import { Plus, Shapes, Trash2, User } from "lucide-react";

import { trpc } from "@/lib/trpc";
import { Field, FormSelect } from "@/components/portfolio";
import { buttonClass } from "@/components/ui";

import type { FormValues } from "../types";
import { useStepper } from "../stepper";

import { stepIndexes } from ".";

const ICON = "h-4 w-4 text-gray-400";

type CoInvestorType = "NATURAL_PERSON" | "FUND";

type CoInvestor = {
  id: string;
  name: string;
  type: CoInvestorType;
};

export function CoInvestors() {
  const { values, setFieldValue } = useFormikContext<FormValues>();
  const { setStepValidity } = useStepper();
  const [newCoInvestorId, setNewCoInvestorId] = useState<string | undefined>();
  const [newCoInvestorName, setNewCoInvestorName] = useState("");
  const [newCoInvestorType, setNewCoInvestorType] =
    useState<CoInvestorType>("FUND");

  const { mutateAsync: getOtherInvestors } =
    trpc.views.portfolio.company.getOtherInvestors.useMutation();

  const handleAddCoInvestor = () => {
    if (!newCoInvestorName) return;

    const newCoInvestor: CoInvestor = {
      id: newCoInvestorId || "NEW",
      name: newCoInvestorName,
      type: newCoInvestorType,
    };

    setFieldValue("coInvestors", [
      ...(values.coInvestors || []),
      newCoInvestor,
    ]);
    setNewCoInvestorName("");
    setNewCoInvestorId(undefined);
  };

  const handleRemoveCoInvestor = (index: number) => {
    const updatedCoInvestors = [...(values.coInvestors || [])];
    updatedCoInvestors.splice(index, 1);
    setFieldValue("coInvestors", updatedCoInvestors);
  };

  useEffect(() => {
    setStepValidity(stepIndexes["CO_INVESTORS"], true);
  }, [values, setStepValidity]);

  return (
    <div className="flex w-full flex-col items-stretch gap-6">
      <span className="text-[15px] font-medium text-gray-900">
        Add Investors
      </span>

      <div className="flex flex-wrap items-start gap-4 rounded-lg border border-gray-100 bg-gray-50 p-3">
        <Field
          className="min-w-[180px] grow"
          label="Name"
          icon={<User className={ICON} />}
          required
        >
          <FormSelect<{ id: string; type: CoInvestorType }>
            autoFocus
            placeholder="Select an investor"
            value={
              newCoInvestorName
                ? {
                    label: newCoInvestorName,
                    value: {
                      id: newCoInvestorId || "NEW",
                      type: newCoInvestorType,
                    },
                  }
                : undefined
            }
            setValue={(value) => {
              setNewCoInvestorId(value?.value?.id || "NEW");
              setNewCoInvestorName(value?.label || "");
              if (value?.value?.type) setNewCoInvestorType(value.value.type);
            }}
            load={async (inputValue) => {
              const investors = await getOtherInvestors({
                entityId: values.entity === "NEW" ? undefined : values.entity,
                search: inputValue,
              });
              return investors.map((investor) => ({
                label: investor.name,
                value: {
                  id: investor.id,
                  type:
                    investor.type === "FUND"
                      ? ("FUND" as const)
                      : ("NATURAL_PERSON" as const),
                },
              }));
            }}
            onCreateOption={(name: string) => {
              setNewCoInvestorName(name);
              setNewCoInvestorId("NEW");
              return { id: "NEW", type: newCoInvestorType };
            }}
          />
        </Field>

        <Field
          className="w-[130px]"
          label="Type"
          icon={<Shapes className={ICON} />}
          required
        >
          <FormSelect<CoInvestorType>
            isDisabled={!!newCoInvestorId && newCoInvestorId !== "NEW"}
            value={{
              label: newCoInvestorType === "FUND" ? "Fund" : "Person",
              value: newCoInvestorType,
            }}
            setValue={(value) =>
              value?.value ? setNewCoInvestorType(value?.value) : null
            }
            options={[
              { label: "Fund", value: "FUND" },
              { label: "Person", value: "NATURAL_PERSON" },
            ]}
          />
        </Field>

        <button
          type="button"
          onClick={handleAddCoInvestor}
          disabled={!newCoInvestorName}
          className={`ml-auto self-end ${buttonClass({ variant: "secondary" })}`}
        >
          <Plus className="h-3.5 w-3.5" />
          Add
        </button>
      </div>

      {values.coInvestors && values.coInvestors.length > 0 ? (
        <div className="flex flex-col items-stretch gap-2">
          {values.coInvestors.map((coInvestor, index) => (
            <div
              key={index}
              className="flex items-center gap-4 border-b border-gray-100 pb-2 last:border-b-0 last:pb-0"
            >
              <div className="flex-1 text-[13px] text-gray-900">
                {coInvestor.name}
              </div>
              <div className="w-[100px] text-[12px] text-gray-500">
                {coInvestor.type === "FUND" ? "Fund" : "Person"}
              </div>
              <button
                type="button"
                aria-label="Remove investor"
                onClick={() => handleRemoveCoInvestor(index)}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-red-500 hover:bg-red-50"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
