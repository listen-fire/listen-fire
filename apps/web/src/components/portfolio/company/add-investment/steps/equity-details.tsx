"use client";

import { useEffect } from "react";
import { useFormikContext } from "formik";
import { BarChart3, Banknote, Landmark, Package, Tag } from "lucide-react";

import { Field, FormSelect, TextInput, formatNumber } from "@/components/portfolio";

import { currencyOptions, type FormValues } from "../types";
import { useStepper } from "../stepper";

import { toMaxFixed } from "./utils";

import { CurrencyIsoCode, ValuationType } from "#trpc";

const ICON = "h-4 w-4 text-gray-400";

export function EquityDetails() {
  const { values } = useFormikContext<FormValues>();
  const { setStepValidity } = useStepper();

  useEffect(() => {
    if (
      values["pricePerShare"] &&
      values["pricePerShareCurrency"] &&
      values["numberOfShares"]
    ) {
      setStepValidity("HEAVY_DETAIL", true);
    } else {
      setStepValidity("HEAVY_DETAIL", false);
    }
  }, [values, setStepValidity]);

  return <EquityDetailsInner />;
}

export function EquityDetailsInner() {
  const { values, setFieldValue, touched, setFieldTouched } =
    useFormikContext<FormValues>();

  const handlePriceChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const numericValue = e.target.value
      .replace(/[^\d.]/g, "")
      .replace(/(\..*)\./g, "$1");
    setFieldValue("pricePerShare", numericValue);

    // Update investment amount if number of shares is touched
    if (touched.numberOfShares && values.numberOfShares) {
      const amount = toMaxFixed(
        Number(numericValue) * Number(values.numberOfShares),
        6,
      );
      setFieldValue("investmentAmount", amount);
    }
    // Update number of shares if not touched or empty
    else if (
      values.investmentAmount &&
      (!touched.numberOfShares || !values.numberOfShares)
    ) {
      const shares = Math.floor(
        Number(values.investmentAmount) / Number(numericValue),
      ).toString();
      setFieldValue("numberOfShares", shares);
    }
  };

  const handleSharesChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const numericValue = e.target.value.replace(/\D/g, "");
    setFieldValue("numberOfShares", numericValue);

    if (touched.pricePerShare && values.pricePerShare) {
      const amount = toMaxFixed(
        Number(numericValue) * Number(values.pricePerShare),
        6,
      );
      setFieldValue("investmentAmount", amount);
    } else if (
      values.investmentAmount &&
      (!touched.pricePerShare || !values.pricePerShare)
    ) {
      const price = (
        Number(values.investmentAmount) / Number(numericValue)
      ).toString();
      setFieldValue("pricePerShare", price);
    }
  };

  // Set default currencies to match investment currency
  useEffect(() => {
    if (values.investmentCurrency) {
      setFieldValue("pricePerShareCurrency", values.investmentCurrency);
      setFieldValue("valuationCurrency", values.investmentCurrency);
      setFieldValue("totalRaisedCurrency", values.investmentCurrency);
    }
  }, [values.investmentCurrency, setFieldValue]);

  const derivedAmount =
    values.pricePerShare && values.numberOfShares
      ? toMaxFixed(
          Number(values.pricePerShare) * Number(values.numberOfShares),
          6,
        )
      : undefined;

  return (
    <div className="flex w-full flex-col items-stretch gap-8 overflow-x-hidden">
      <Field icon={<Landmark className={ICON} />} label="Investment Amount">
        <div className="flex w-full items-start gap-2">
          <div className="w-[110px] shrink-0">
            <FormSelect<CurrencyIsoCode>
              value={
                values.investmentCurrency
                  ? {
                      label: values.investmentCurrency,
                      value: values.investmentCurrency,
                    }
                  : undefined
              }
              setValue={(value) =>
                setFieldValue("investmentCurrency", value?.value)
              }
              options={currencyOptions}
              isDisabled
            />
          </div>
          <div className="relative grow">
            <TextInput
              value={
                values.investmentAmount
                  ? formatNumber(values.investmentAmount, true)
                  : ""
              }
              placeholder="Amount invested"
              disabled
            />
            {derivedAmount && values.investmentAmount !== derivedAmount ? (
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[12px] text-gray-500">
                ({derivedAmount})
              </span>
            ) : null}
          </div>
        </div>
      </Field>
      <Field
        icon={<Banknote className={ICON} />}
        label="Price per Share"
        required
      >
        <div className="flex w-full items-start gap-2">
          <div className="w-[110px] shrink-0">
            <FormSelect<CurrencyIsoCode>
              value={
                values.pricePerShareCurrency
                  ? {
                      label: values.pricePerShareCurrency,
                      value: values.pricePerShareCurrency,
                    }
                  : undefined
              }
              setValue={(value) =>
                setFieldValue("pricePerShareCurrency", value?.value)
              }
              options={currencyOptions}
              isDisabled
            />
          </div>
          <TextInput
            className="grow"
            onFocus={() => setFieldTouched("pricePerShare")}
            value={
              values.pricePerShare
                ? formatNumber(values.pricePerShare, true)
                : ""
            }
            onChange={handlePriceChange}
            placeholder="Price per share"
            type="text"
            inputMode="decimal"
            pattern="[0-9\s.]*"
          />
        </div>
      </Field>
      <Field
        icon={<Package className={ICON} />}
        label="Number of Shares"
        required
      >
        <TextInput
          onFocus={() => setFieldTouched("numberOfShares")}
          value={
            values.numberOfShares
              ? formatNumber(values.numberOfShares, false)
              : ""
          }
          onChange={handleSharesChange}
          placeholder="Number of shares"
          type="text"
          inputMode="numeric"
          pattern="[0-9\s]*"
        />
      </Field>
      <ShareClass />
      <Valuation />
      <TotalRaised />
    </div>
  );
}

function ShareClass() {
  const { values, setFieldValue, setFieldTouched } =
    useFormikContext<FormValues>();
  return (
    <Field icon={<Tag className={ICON} />} label="Share Class">
      <TextInput
        onFocus={() => setFieldTouched("shareClass")}
        value={values.shareClass || ""}
        onChange={(e) => setFieldValue("shareClass", e.target.value)}
        placeholder="Share class"
      />
    </Field>
  );
}

function Valuation() {
  const { values, setFieldValue, setFieldTouched } =
    useFormikContext<FormValues>();

  const handleValuationChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const numericValue = e.target.value
      .replace(/[^\d.]/g, "")
      .replace(/(\..*)\./g, "$1");
    setFieldValue("valuationAmount", numericValue);
  };

  return (
    <Field icon={<BarChart3 className={ICON} />} label="Valuation">
      <div className="flex w-full items-start gap-2">
        <div className="w-[110px] shrink-0">
          <FormSelect<CurrencyIsoCode>
            value={
              values.valuationCurrency
                ? {
                    label: values.valuationCurrency,
                    value: values.valuationCurrency,
                  }
                : undefined
            }
            setValue={(value) =>
              setFieldValue("valuationCurrency", value?.value)
            }
            options={currencyOptions}
            isDisabled
          />
        </div>
        <TextInput
          className="grow"
          onFocus={() => setFieldTouched("valuationAmount")}
          value={
            values.valuationAmount
              ? formatNumber(values.valuationAmount, true)
              : ""
          }
          onChange={handleValuationChange}
          placeholder="Valuation amount"
          type="text"
          inputMode="decimal"
          pattern="[0-9\s.]*"
        />
        <div className="w-[150px] shrink-0">
          <FormSelect<ValuationType>
            value={
              values.valuationType
                ? {
                    label:
                      values.valuationType === "PRE_MONEY"
                        ? "Pre-Money"
                        : "Post-Money",
                    value: values.valuationType,
                  }
                : undefined
            }
            setValue={(value) => setFieldValue("valuationType", value?.value)}
            options={[
              { label: "Pre-Money", value: ValuationType.PRE_MONEY },
              { label: "Post-Money", value: ValuationType.POST_MONEY },
            ]}
          />
        </div>
      </div>
    </Field>
  );
}

function TotalRaised() {
  const { values, setFieldValue, setFieldTouched } =
    useFormikContext<FormValues>();

  const handleTotalRaisedChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const numericValue = e.target.value
      .replace(/[^\d.]/g, "")
      .replace(/(\..*)\./g, "$1");
    setFieldValue("totalRaisedAmount", numericValue);
  };

  return (
    <Field icon={<Landmark className={ICON} />} label="Total Raised">
      <div className="flex w-full items-start gap-2">
        <div className="w-[110px] shrink-0">
          <FormSelect<CurrencyIsoCode>
            value={
              values.totalRaisedCurrency
                ? {
                    label: values.totalRaisedCurrency,
                    value: values.totalRaisedCurrency,
                  }
                : undefined
            }
            setValue={(value) =>
              setFieldValue("totalRaisedCurrency", value?.value)
            }
            options={currencyOptions}
            isDisabled
          />
        </div>
        <TextInput
          className="grow"
          onFocus={() => setFieldTouched("totalRaisedAmount")}
          value={
            values.totalRaisedAmount
              ? formatNumber(values.totalRaisedAmount, true)
              : ""
          }
          onChange={handleTotalRaisedChange}
          placeholder="Total raised amount"
          type="text"
          inputMode="decimal"
          pattern="[0-9\s.]*"
        />
      </div>
    </Field>
  );
}
