"use client";

/**
 * Port of apps/app's Portfolio/Profile/AddMarkdown/ — a write-down of the
 * company's latest reported asset price by a percentage. The local
 * Modal/Field/Footer/useResetFormOnClose copies collapse onto the shared
 * portfolio form primitives; the formik wiring and submit payload are
 * unchanged.
 */

import { useEffect, useState } from "react";
import { Formik, Form as FormikForm, useFormikContext } from "formik";
import { Calendar, MessageCircle, TrendingDown, TriangleAlert } from "lucide-react";

import { trpc, type RouterInputs } from "@/lib/trpc";
import {
  DateInput,
  Field,
  FormFooter,
  FormModal,
  FutureDateWarning,
  TextArea,
  useToast,
} from "@/components/portfolio";

type FormValues = Partial<
  RouterInputs["views"]["portfolio"]["company"]["addMarkdown"]
>;

function AddMarkdown({
  companyId,
  isOpen,
  onClose,
}: {
  companyId: string;
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  return (
    <AddMarkdownForm companyId={companyId} onClose={onClose}>
      <>
        <ResetFormOnClose isOpen={isOpen} />
        <FormikForm>
          <FormModal
            isOpen={isOpen}
            onClose={onClose}
            title="Add Markdown"
            size="md"
            footer={<Footer onCancel={onClose} />}
          >
            <Body />
          </FormModal>
        </FormikForm>
      </>
    </AddMarkdownForm>
  );
}

function AddMarkdownForm({
  companyId,
  children,
  onClose,
}: {
  companyId: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  const { mutateAsync: addMarkdown } =
    trpc.views.portfolio.company.addMarkdown.useMutation();
  const utils = trpc.useUtils();
  const toast = useToast();

  return (
    <Formik<FormValues>
      initialValues={{
        companyId: companyId,
      }}
      validateOnChange={true}
      onSubmit={async (values) => {
        await addMarkdown({
          date: values["date"]!,
          percentage: values["percentage"]!,
          companyId: values["companyId"]!,
        });
        await utils.views.portfolio.company.invalidate();
        toast.success("Markdown added");
        onClose();
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
  const { values, isSubmitting } = useFormikContext<FormValues>();

  return (
    <FormFooter
      onCancel={onCancel}
      isSubmitting={isSubmitting}
      isDisabled={
        values["date"] === undefined || values["percentage"] === undefined
      }
    />
  );
}

function Body() {
  return (
    <div className="flex w-full flex-col items-stretch gap-8">
      <EventDate />
      <PercentageSlider />
      <EventNotes />
      <p className="text-[12px] leading-5 text-gray-500">
        <TriangleAlert
          className="mr-1.5 -mb-0.5 inline h-3.5 w-3.5"
          color="#FFA500"
        />
        Markdowns create static prices based on the latest reported asset
        price. If you retrospectively report a price before this date you will
        need to update these manually.
      </p>
    </div>
  );
}

function PercentageSlider() {
  const { values, setFieldValue } = useFormikContext<FormValues>();
  const [showTooltip, setShowTooltip] = useState(false);
  const percentage = values["percentage"] ?? 0;

  return (
    <div className="flex w-full flex-col items-stretch gap-2 px-2.5">
      <Field
        label="Percentage"
        icon={<TrendingDown className="h-4 w-4 text-gray-400" />}
        required
      >
        <div
          className="relative pb-5"
          onMouseEnter={() => setShowTooltip(true)}
          onMouseLeave={() => setShowTooltip(false)}
        >
          {showTooltip && (
            <div
              className="pointer-events-none absolute -top-7 z-10 -translate-x-1/2 rounded bg-primary px-1.5 py-0.5 text-[11px] text-white"
              style={{ left: `${percentage}%` }}
            >
              {`${percentage}%`}
            </div>
          )}
          <input
            id="slider"
            type="range"
            min={0}
            max={100}
            value={percentage}
            onChange={(e) => setFieldValue("percentage", Number(e.target.value))}
            className="w-full accent-primary"
          />
          <div className="pointer-events-none absolute inset-x-0 bottom-0 text-[12px] text-gray-500">
            {[25, 50, 75].map((mark) => (
              <span
                key={mark}
                className="absolute -translate-x-1/2"
                style={{ left: `${mark}%` }}
              >
                {mark}%
              </span>
            ))}
          </div>
        </div>
      </Field>
      <div className="flex min-h-[80px] items-end justify-center">
        <span className="text-[40px] leading-none text-gray-900">{`${percentage}%`}</span>
      </div>
    </div>
  );
}

function EventDate() {
  const { values, setFieldValue } = useFormikContext<FormValues>();

  return (
    <Field
      label="Date"
      icon={<Calendar className="h-4 w-4 text-gray-400" />}
      required
      className="px-2.5"
    >
      <DateInput
        value={values["date"] ? values["date"] : undefined}
        onChange={(value) => setFieldValue("date", value)}
      />
      <FutureDateWarning value={values["date"] ?? ""} />
    </Field>
  );
}

function EventNotes() {
  const { values, setFieldValue } = useFormikContext<FormValues>();

  return (
    <Field
      label="Notes"
      icon={<MessageCircle className="h-4 w-4 text-gray-400" />}
      className="px-2.5"
    >
      <TextArea
        rows={3}
        placeholder="I marked this down because..."
        value={values["note"] ? values["note"] : ""}
        onChange={(e) => setFieldValue("note", e.target.value)}
      />
    </Field>
  );
}

export { AddMarkdown };
