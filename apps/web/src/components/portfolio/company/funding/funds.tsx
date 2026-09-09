"use client";

/**
 * Port of apps/app's FundingSection/Funds.tsx (V-20). `formatNumber`, the
 * formik shape and the drawdown submit payload are byte-faithful — a
 * drawdown consumes a fund's outstanding commitment, and the currency is
 * deliberately read-only, pinned to the commitment's own currency.
 */

import { Formik } from "formik";
import { Calendar, DollarSign, Package } from "lucide-react";

import {
  Field,
  FormModal,
  FormSelect,
  FutureDateWarning,
  TextInput,
  formatNumber,
} from "@/components/portfolio";
import { buttonClass } from "@/components/ui";
import { trpc } from "@/lib/trpc";

import { ResetFormOnClose, currencyOptions } from "./common";

import { CurrencyIsoCode } from "#trpc";

type OutstandingCommitment = {
  assetId: string;
  assetName: string;
  investorId: string;
  investorName: string;
  price: number;
  currency: CurrencyIsoCode;
};

export function AddFundDrawdown({
  fundId,
  disclosure,
}: {
  fundId: string;
  disclosure: { isOpen: boolean; onClose: () => void };
}) {
  const { data: outstandingCommitments } =
    trpc.views.portfolio.company.getOutstandingCommitments.useQuery({
      companyId: fundId,
    });
  const { mutateAsync: addFundDrawdown, isLoading } =
    trpc.views.portfolio.company.addFundDrawdown.useMutation();
  const utils = trpc.useUtils();

  return (
    <Formik<{
      outstandingCommitment: OutstandingCommitment | null;
      drawdownAmount: string;
      date: string;
    }>
      enableReinitialize
      initialValues={{
        outstandingCommitment: null,
        drawdownAmount: "",
        date: "",
      }}
      onSubmit={async (values) => {
        await addFundDrawdown({
          fundId,
          drawdownAmount: Number(values.drawdownAmount),
          date: values.date,
          outstandingCommitment: values.outstandingCommitment!,
        });
        utils.views.portfolio.company.invalidate();
        disclosure.onClose();
      }}
    >
      {({ setFieldValue, setFieldTouched, values, handleSubmit, isSubmitting }) => (
        <FormModal
          isOpen={disclosure.isOpen}
          onClose={disclosure.onClose}
          title="Add Drawdown"
          footer={
            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={disclosure.onClose}
                disabled={isLoading || isSubmitting}
                className={buttonClass({ variant: "ghost" })}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => handleSubmit()}
                disabled={isLoading || isSubmitting}
                className={buttonClass({ variant: "primary" })}
              >
                {isLoading || isSubmitting ? "Saving…" : "Save"}
              </button>
            </div>
          }
        >
          <ResetFormOnClose isOpen={disclosure.isOpen} />
          <div className="flex flex-col items-stretch gap-5">
            <Field
              label="Date"
              icon={<Calendar className="h-4 w-4 text-gray-400" />}
              required
            >
              <TextInput
                value={values.date}
                onChange={(e) => {
                  setFieldValue("date", e.target.value);
                  setFieldTouched("date", true);
                }}
                type="date"
              />
              <FutureDateWarning value={values.date} />
            </Field>
            <Field
              label="Commitment"
              icon={<Package className="h-4 w-4 text-gray-400" />}
              required
            >
              <FormSelect<OutstandingCommitment | null>
                options={
                  outstandingCommitments?.map((commitment) => ({
                    label: `${commitment.assetName} (${commitment.investorName})`,
                    value: commitment,
                  })) ?? []
                }
                value={
                  values.outstandingCommitment
                    ? {
                        label: `${values.outstandingCommitment.assetName} (${values.outstandingCommitment.investorName})`,
                        value: values.outstandingCommitment,
                      }
                    : undefined
                }
                setValue={(value) =>
                  setFieldValue("outstandingCommitment", value?.value ?? null)
                }
              />
            </Field>
            <Field
              label="Drawdown Amount"
              icon={<DollarSign className="h-4 w-4 text-gray-400" />}
              required
            >
              <div className="flex items-start gap-2">
                <div className="w-[130px] shrink-0">
                  <FormSelect<CurrencyIsoCode>
                    value={
                      values.outstandingCommitment?.currency
                        ? {
                            label: values.outstandingCommitment.currency,
                            value: values.outstandingCommitment.currency,
                          }
                        : undefined
                    }
                    setValue={(value) => {
                      setFieldValue("outstandingCommitment", {
                        ...values.outstandingCommitment,
                        currency: value?.value,
                      });
                      setFieldTouched("outstandingCommitment", true);
                    }}
                    isDisabled
                    options={currencyOptions}
                    placeholder="Select..."
                  />
                </div>
                <TextInput
                  value={
                    values.drawdownAmount
                      ? formatNumber(values.drawdownAmount)
                      : ""
                  }
                  onChange={(e) => {
                    const value = e.target.value;
                    const numericValue = value
                      .replace(/[^\d.]/g, "")
                      .replace(/(\..*)\./g, "$1");
                    setFieldValue("drawdownAmount", numericValue);
                    setFieldTouched("drawdownAmount", true);
                  }}
                  placeholder={
                    values.outstandingCommitment
                      ? `${formatNumber(values.outstandingCommitment.price.toString())} outstanding`
                      : "-"
                  }
                  type="text"
                  pattern="[0-9\s.]*"
                />
              </div>
            </Field>
          </div>
        </FormModal>
      )}
    </Formik>
  );
}
