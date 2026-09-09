"use client";

/**
 * Port of apps/app's Portfolio/Profile/ConvertConvertible/ — converts a
 * convertible instrument into shares. The price-per-share derivation and
 * the submit payload are carried over unchanged: price per share is
 * (original amount + interest) / number of shares, all three parsed off
 * digit-and-dot-stripped strings, and the mutation is only fired when every
 * required value is present.
 */

import { useEffect } from "react";
import { Formik, Form as FormikForm, useFormikContext } from "formik";

import { trpc } from "@/lib/trpc";
import {
  DateInput,
  Field,
  FormFooter,
  FormModal,
  FutureDateWarning,
  TextInput,
  useToast,
} from "@/components/portfolio";

type ConversionDetails = {
  transactionId: string;
  assetId: string;
  originalAmount: string;
  conversionDate?: string;
  conversionPrice?: string;
  interest?: string;
  numShares?: string;
  shareClass?: string;
  currency?: string;
};

type FormValues = ConversionDetails;

function ConvertTransaction({
  transactionId,
  assetId,
  originalAmount,
  currency,
  isOpen,
  onClose,
}: {
  transactionId: string;
  assetId: string;
  originalAmount: string;
  currency: string;
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  return (
    <ConvertConvertibleForm
      transactionId={transactionId}
      assetId={assetId}
      originalAmount={originalAmount}
      currency={currency}
      onClose={onClose}
    >
      <>
        <ResetFormOnClose isOpen={isOpen} />
        <FormikForm>
          <FormModal
            isOpen={isOpen}
            onClose={onClose}
            title="Converting to shares"
            size="md"
            footer={<Footer onCancel={onClose} />}
          >
            <Body />
          </FormModal>
        </FormikForm>
      </>
    </ConvertConvertibleForm>
  );
}

function ConvertConvertibleForm({
  transactionId,
  assetId,
  originalAmount,
  currency,
  children,
  onClose,
}: {
  transactionId: string;
  assetId: string;
  originalAmount: string;
  currency: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  const { mutateAsync: convertTransaction } =
    trpc.views.portfolio.company.convertTransaction.useMutation();
  const utils = trpc.useUtils();
  const toast = useToast();

  return (
    <Formik<FormValues>
      initialValues={{
        transactionId: transactionId,
        assetId: assetId,
        originalAmount: originalAmount,
        currency: currency,
      }}
      enableReinitialize
      validateOnChange={true}
      onSubmit={async (values, { setSubmitting, setStatus }) => {
        try {
          const strippedOriginalAmount = values.originalAmount.replace(
            /[^0-9.]/g,
            "",
          );
          const strippedInterest = values.interest?.replace(/[^0-9.]/g, "");
          const strippedNumShares = values.numShares?.replace(/[^0-9.]/g, "");
          const pricePerShare = strippedNumShares
            ? (parseFloat(strippedOriginalAmount) +
                parseFloat(strippedInterest ?? "0")) /
              parseFloat(strippedNumShares)
            : undefined;
          if (
            values.conversionDate &&
            pricePerShare &&
            values.numShares &&
            values.shareClass &&
            values.currency
          ) {
            await convertTransaction({
              currency: values.currency,
              transactionId: values.transactionId,
              assetId: values.assetId,
              conversionDate: values.conversionDate,
              conversionPrice: pricePerShare.toString(),
              numShares: values.numShares,
              shareClass: values.shareClass,
              interest: values.interest,
            });
            await utils.views.portfolio.company.invalidate();
            toast.success("Converted to shares");
          }
          onClose();
        } catch (_error) {
          setStatus({ error: "An unexpected error occurred, try again later." });
        } finally {
          setSubmitting(false);
        }
      }}
    >
      {children}
    </Formik>
  );
}

function ResetFormOnClose({ isOpen }: { isOpen: boolean }) {
  const { resetForm } = useFormikContext();

  useEffect(() => {
    if (!isOpen) {
      resetForm();
    }
  }, [isOpen, resetForm]);

  return null;
}

function Footer({ onCancel }: { onCancel: () => void }) {
  const { values, status, isSubmitting } = useFormikContext<FormValues>();

  return (
    <FormFooter
      onCancel={onCancel}
      isSubmitting={isSubmitting}
      error={status?.error}
      isDisabled={
        !values.conversionDate ||
        !values.shareClass ||
        !values.numShares ||
        status?.error ||
        isSubmitting
      }
    />
  );
}

function Body() {
  const { values, setFieldValue } = useFormikContext<FormValues>();
  const handleChange = (
    field: string,
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const numericValue = e.target.value
      .replace(/[^\d.]/g, "")
      .replace(/(\..*)\./g, "$1");
    setFieldValue(field, numericValue);
  };

  const strippedOriginalAmount = values.originalAmount.replace(/[^0-9.]/g, "");
  const strippedInterest = values.interest?.replace(/[^0-9.]/g, "");
  const strippedNumShares = values.numShares?.replace(/[^0-9.]/g, "");

  return (
    <div className="flex w-full flex-col items-stretch gap-6">
      <div className="grid w-full grid-cols-1 gap-4 md:grid-cols-2">
        <Field label="Date" icon={null} required>
          <DateInput
            value={values.conversionDate}
            onChange={(value) => setFieldValue("conversionDate", value)}
          />
          <FutureDateWarning value={values.conversionDate ?? ""} />
        </Field>
        <Field label="Number of shares" icon={null} required>
          <TextInput
            placeholder={"1000"}
            value={values.numShares ?? ""}
            onChange={(e) => handleChange("numShares", e)}
          />
        </Field>
        <Field label="Share Class" icon={null} required>
          <TextInput
            placeholder="Series A"
            value={values.shareClass ?? ""}
            onChange={(e) => setFieldValue("shareClass", e.target.value)}
          />
        </Field>
      </div>
      <div className="grid w-full grid-cols-1 items-end gap-4 md:grid-cols-2">
        <Field label="Interest" icon={null} className="md:col-span-2">
          <div className="flex items-center gap-2">
            <TextInput disabled value={values.currency ?? ""} className="w-20" />
            <TextInput
              placeholder={"e.g. 500"}
              value={values.interest ?? ""}
              onChange={(e) => handleChange("interest", e)}
              type="number"
            />
          </div>
        </Field>
      </div>
      <p className="text-[12px] text-gray-500">
        Original Amount: {values.currency} {values.originalAmount}, Total:{" "}
        {values.currency}{" "}
        {parseFloat(strippedOriginalAmount) +
          (strippedInterest ? parseFloat(strippedInterest) : 0)}
        , Price per share: {values.currency}{" "}
        {strippedNumShares
          ? (parseFloat(strippedOriginalAmount) +
              parseFloat(strippedInterest ?? "0")) /
            parseFloat(strippedNumShares)
          : "-"}
      </p>
    </div>
  );
}

export { ConvertTransaction };
