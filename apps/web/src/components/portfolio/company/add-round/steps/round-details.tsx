"use client";

import { useEffect, useMemo } from "react";
import { useFormikContext } from "formik";
import { format } from "date-fns";
import { BarChart3, Banknote, Clock, Landmark, Layers } from "lucide-react";

import { trpc } from "@/lib/trpc";
import {
  Field,
  FormSelect,
  FutureDateWarning,
  TextInput,
  formatNumber,
  startCase,
} from "@/components/portfolio";

import { currencyOptions, type FormValues } from "../types";
import { useStepper } from "../stepper";

import { stepIndexes } from ".";

import { CurrencyIsoCode } from "#trpc";

const ICON = "h-4 w-4 text-gray-400";

export function RoundDetails() {
  const { values, setFieldValue } = useFormikContext<FormValues>();
  const { setStepValidity } = useStepper();

  useEffect(() => {
    if (values["roundName"] && values["date"]) {
      setStepValidity(stepIndexes["ROUND_DETAILS"], true);
    } else {
      setStepValidity(stepIndexes["ROUND_DETAILS"], false);
    }
  }, [values, setStepValidity]);

  const handleChange = (
    field: string,
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const numericValue = e.target.value
      .replace(/[^\d.]/g, "")
      .replace(/(\..*)\./g, "$1");
    setFieldValue(field, numericValue);
  };

  return (
    <div className="flex w-full flex-col items-stretch gap-8 overflow-x-hidden">
      <div className="grid w-full grid-cols-2 gap-2">
        <RoundName />
        <RoundDate />
      </div>
      <div className="flex w-full flex-col items-stretch gap-4">
        <Field icon={<Landmark className={ICON} />} label="Total raised">
          <div className="flex w-full items-start gap-2">
            <div className="w-[110px] shrink-0">
              <FormSelect<CurrencyIsoCode>
                value={
                  values.currency
                    ? { label: values.currency, value: values.currency }
                    : undefined
                }
                setValue={(value) => setFieldValue("currency", value?.value)}
                options={currencyOptions}
              />
            </div>
            <TextInput
              className="grow"
              value={
                values.totalRaisedAmount
                  ? formatNumber(values.totalRaisedAmount, true)
                  : ""
              }
              placeholder="Total raised"
              onChange={(e) => handleChange("totalRaisedAmount", e)}
            />
          </div>
        </Field>
        <Field icon={<BarChart3 className={ICON} />} label="Valuation">
          <div className="flex w-full items-start gap-2">
            <div className="w-[110px] shrink-0">
              <FormSelect<CurrencyIsoCode>
                isDisabled
                value={
                  values.currency
                    ? { label: values.currency, value: values.currency }
                    : undefined
                }
                setValue={(value) => setFieldValue("currency", value?.value)}
                options={currencyOptions}
              />
            </div>
            <TextInput
              className="grow"
              value={
                values.valuationAmount
                  ? formatNumber(values.valuationAmount, true)
                  : ""
              }
              placeholder="Valuation"
              onChange={(e) => handleChange("valuationAmount", e)}
            />
          </div>
        </Field>
        <Field icon={<Banknote className={ICON} />} label="Price per share">
          <div className="flex w-full items-start gap-2">
            <div className="w-[110px] shrink-0">
              <FormSelect<CurrencyIsoCode>
                isDisabled
                value={
                  values.currency
                    ? { label: values.currency, value: values.currency }
                    : undefined
                }
                setValue={(value) => setFieldValue("currency", value?.value)}
                options={currencyOptions}
              />
            </div>
            <TextInput
              className="grow"
              value={
                values.pricePerShare
                  ? formatNumber(values.pricePerShare, true)
                  : ""
              }
              placeholder="0.20"
              onChange={(e) => handleChange("pricePerShare", e)}
            />
          </div>
        </Field>
      </div>
    </div>
  );
}

function RoundName() {
  const { values, setFieldValue } = useFormikContext<FormValues>();
  const { data: rounds } =
    trpc.views.portfolio.company.getRoundNamesForLegalEntity.useQuery(
      { legalEntityId: values.entity! },
      { enabled: !!values.entity && values.entity !== "NEW" },
    );

  const value = useMemo(
    () =>
      values.roundName
        ? { label: values.roundName, value: values.roundName }
        : undefined,
    [values.roundName],
  );

  const options = useMemo(() => {
    if (!rounds) return [];
    return rounds
      .map((round) =>
        round.round_name ? startCase(round.round_name.toLowerCase()) : undefined,
      )
      .filter((name): name is string => !!name && name !== "Unknown")
      .map((name) => ({
        label: name,
        value: name,
      }));
  }, [rounds]);

  return (
    <Field label="Round name" icon={<Layers className={ICON} />} required>
      <FormSelect<string>
        placeholder="e.g. Seed, Series A"
        value={value}
        setValue={(value) => {
          const correspondingRound = rounds?.find(
            (round) =>
              round.round_name &&
              startCase(round.round_name.toLowerCase()) === value?.value,
          );
          setFieldValue("roundName", value?.value);
          setFieldValue(
            "date",
            correspondingRound?.date
              ? format(new Date(correspondingRound.date), "yyyy-MM-dd")
              : undefined,
          );
        }}
        options={options}
        onCreateOption={(name: string) => {
          setFieldValue("roundName", name);
          return name;
        }}
      />
    </Field>
  );
}

function RoundDate() {
  const { values, setFieldValue } = useFormikContext<FormValues>();

  return (
    <Field label="Date" icon={<Clock className={ICON} />} required>
      <TextInput
        type="date"
        value={values["date"] ?? ""}
        onChange={(e) => setFieldValue("date", e.target.value)}
      />
      <FutureDateWarning value={values["date"] ?? ""} />
    </Field>
  );
}
