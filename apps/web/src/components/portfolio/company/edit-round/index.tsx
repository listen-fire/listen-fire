"use client";

/**
 * Port of apps/app's Portfolio/Profile/EditRound/ — edits a funding round's
 * headline terms (name, date, instrument, amount, valuation, share price)
 * plus its co-investor list. The local Modal/Select/Field/Footer copies
 * collapse onto the shared portfolio form primitives; formik wiring, the
 * numeric-input sanitisation and the submit payload are unchanged.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Formik, Form as FormikForm, useFormikContext } from "formik";
import { format } from "date-fns";
import {
  Banknote,
  Calendar,
  Coins,
  Landmark,
  Layers,
  Plus,
  SignalHigh,
  Tags,
  User,
  X,
} from "lucide-react";

import { trpc, type RouterInputs } from "@/lib/trpc";
import {
  Field,
  FormFooter,
  FormModal,
  FormSelect,
  FutureDateWarning,
  TextInput,
  convertUnderscore,
  currencies,
  formatNumber,
  useToast,
} from "@/components/portfolio";
import type {
  Company,
  CompanyEvent,
} from "@/components/portfolio/company/types";
import { EquityRoundType } from "#trpc";

type FormValues = Partial<
  RouterInputs["views"]["portfolio"]["company"]["updateRoundInfo"]
>;

type Currency = NonNullable<FormValues["currency"]>;
type RoundName = NonNullable<FormValues["roundName"]>;
type InstrumentType = NonNullable<FormValues["investmentRoundType"]>;
type ValuationTypeValue = NonNullable<FormValues["valuationType"]>;

type Round = Pick<
  CompanyEvent,
  | "event_id"
  | "round_type"
  | "event_date"
  | "raised_amount"
  | "raised_currency"
  | "pricePerShare"
  | "valuation"
  | "valuation_type"
  | "investment_round_type"
  | "investors"
>;

const currencyOptions = currencies.map((currency) => ({
  label: currency,
  value: currency,
}));

const instrumentLabels: Record<InstrumentType, string> = {
  EQUITY: "Equity",
  CONVERTIBLE: "Convertible",
  OTHER: "Other",
};

const equityRoundTypes = [
  EquityRoundType.PRE_PRE_SEED,
  EquityRoundType.PRE_SEED,
  EquityRoundType.SEED,
  EquityRoundType.SEED_EXT,
  EquityRoundType.SERIES_A,
  EquityRoundType.SERIES_A_EXT,
  EquityRoundType.SERIES_A2,
  EquityRoundType.SERIES_B,
  EquityRoundType.SERIES_B_EXT,
  EquityRoundType.SERIES_C,
  EquityRoundType.SERIES_C_EXT,
  EquityRoundType.SERIES_D,
  EquityRoundType.SERIES_E,
  EquityRoundType.SERIES_F,
  EquityRoundType.SERIES_G,
  EquityRoundType.SERIES_H,
  EquityRoundType.SERIES_I,
  EquityRoundType.SERIES_J,
  EquityRoundType.UNKNOWN,
] as const;

type EnsureAllEquityRoundTypes<T extends readonly EquityRoundType[]> =
  Exclude<EquityRoundType, T[number]> extends never ? T : never;

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const checkedEquityRoundTypes: EnsureAllEquityRoundTypes<
  typeof equityRoundTypes
> = equityRoundTypes;

function EditRound({
  company,
  round,
  isOpen,
  onClose,
}: {
  company: Pick<Exclude<Company, null>, "id">;
  round: Round;
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  return (
    <EditRoundForm company={company} round={round} onClose={onClose}>
      <>
        <ResetFormOnClose isOpen={isOpen} />
        <FormikForm>
          <FormModal
            isOpen={isOpen}
            onClose={onClose}
            title="Edit Round"
            size="lg"
            footer={<Footer onCancel={onClose} />}
          >
            <Body />
          </FormModal>
        </FormikForm>
      </>
    </EditRoundForm>
  );
}

function EditRoundForm({
  company,
  round,
  children,
  onClose,
}: {
  company: Pick<Exclude<Company, null>, "id">;
  round: Round;
  children: React.ReactNode;
  onClose: () => void;
}) {
  const { mutateAsync: editRound } =
    trpc.views.portfolio.company.updateRoundInfo.useMutation();
  const utils = trpc.useUtils();
  const toast = useToast();

  return (
    <Formik<FormValues>
      enableReinitialize
      initialValues={{
        companyId: company?.id,
        eventId: round.event_id!,
        roundName: (round.round_type as RoundName) ?? undefined,
        date: round.event_date
          ? format(new Date(round.event_date), "yyyy-MM-dd")
          : undefined,
        currency: round.raised_currency ?? undefined,
        pricePerShare: round.pricePerShare?.price,
        pricePerShareCurrency: round.pricePerShare?.currency,
        amount: round.raised_amount ?? undefined,
        valuation: round.valuation ?? undefined,
        valuationType: round.valuation_type ?? undefined,
        investmentRoundType: round.investment_round_type ?? undefined,
        coInvestors:
          round.investors.flatMap((item) => {
            return {
              id: item.id,
              name: item.name,
              type: item.type === "FUND" ? ("FUND" as const) : ("NATURAL_PERSON" as const),
            };
          }) ?? [],
      }}
      validateOnChange={true}
      onSubmit={async (values) => {
        if (values.pricePerShare && !values.pricePerShareCurrency) {
          toast.error("Price per share currency is required");
          return;
        }
        await editRound({
          eventId: values["eventId"]!,
          companyId: values["companyId"]!,
          roundName: values["roundName"]!,
          date: values["date"]!,
          currency: values["currency"]!,
          pricePerShareCurrency: values["pricePerShareCurrency"],
          pricePerShare: values["pricePerShare"]
            ? parseFloat(values["pricePerShare"].toString().replace(/[^0-9.]/g, ""))
            : undefined,
          amount: values["amount"],
          valuation: values["valuation"],
          valuationType: values["valuationType"],
          coInvestors: values["coInvestors"],
          investmentRoundType: values["investmentRoundType"],
        });
        await utils.views.portfolio.company.invalidate();
        toast.success("Round updated");

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
  const { isSubmitting } = useFormikContext<FormValues>();

  return <FormFooter onCancel={onCancel} isSubmitting={isSubmitting} />;
}

function Body() {
  const { values, setFieldValue } = useFormikContext<FormValues>();
  const [tabIndex, setTabIndex] = useState(0);
  const options = useMemo(() => {
    return equityRoundTypes.map((roundType) => ({
      label: convertUnderscore(roundType),
      value: roundType,
    }));
  }, []);

  const handleChange = (
    field: string,
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const numericValue = e.target.value
      .replace(/[^\d.]/g, "")
      .replace(/(\..*)\./g, "$1");
    setFieldValue(field, Number(numericValue));
  };

  return (
    <div className="flex min-h-[360px] flex-col items-stretch gap-6">
      <div className="flex w-fit items-center gap-1 rounded bg-gray-100 p-1">
        {["Basic Info", "Co-Investors"].map((label, index) => (
          <button
            key={label}
            type="button"
            onClick={() => setTabIndex(index)}
            className={`rounded px-3 py-1.5 text-[13px] font-semibold ${
              tabIndex === index
                ? "bg-white text-gray-900 shadow-sm"
                : "text-gray-500"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tabIndex === 0 && (
        <div className="flex w-full flex-col gap-6">
          <div className="grid w-full grid-cols-1 gap-4 sm:grid-cols-2">
            <Field
              label="Round name"
              icon={<Layers className="h-4 w-4 text-gray-400" />}
              required
            >
              <FormSelect<RoundName>
                placeholder="e.g. Seed, Series A"
                value={
                  values["roundName"]
                    ? {
                        label: convertUnderscore(values["roundName"]),
                        value: values["roundName"],
                      }
                    : undefined
                }
                setValue={(value) => {
                  setFieldValue("roundName", value?.value);
                }}
                options={options}
              />
            </Field>
            <Field
              label="Date"
              icon={<Calendar className="h-4 w-4 text-gray-400" />}
              required
            >
              <TextInput
                type="date"
                value={values["date"] ? values["date"] : ""}
                onChange={(e) => setFieldValue("date", e.target.value)}
              />
              <FutureDateWarning value={values["date"] ?? ""} />
            </Field>

            <Field label="Instrument" icon={null}>
              <FormSelect<InstrumentType>
                value={
                  values.investmentRoundType
                    ? {
                        label: instrumentLabels[values.investmentRoundType],
                        value: values.investmentRoundType,
                      }
                    : undefined
                }
                setValue={(value) =>
                  setFieldValue("investmentRoundType", value?.value)
                }
                options={[
                  { label: "Equity", value: "EQUITY" as const },
                  { label: "Convertible", value: "CONVERTIBLE" as const },
                  { label: "Other", value: "OTHER" as const },
                ]}
              />
            </Field>

            <Field
              icon={<Coins className="h-4 w-4 text-gray-400" />}
              label="Currency"
            >
              <FormSelect<Currency>
                value={
                  values.currency
                    ? { label: values.currency, value: values.currency }
                    : undefined
                }
                setValue={(value) => setFieldValue("currency", value?.value)}
                options={currencyOptions}
              />
            </Field>
            <Field
              icon={<Landmark className="h-4 w-4 text-gray-400" />}
              label="Total raised"
            >
              <TextInput
                value={values.amount ? formatNumber(values.amount, true) : ""}
                placeholder="Total raised"
                onChange={(e) => handleChange("amount", e)}
              />
            </Field>

            <Field
              icon={<SignalHigh className="h-4 w-4 text-gray-400" />}
              label={
                values.investmentRoundType === "CONVERTIBLE"
                  ? "Valuation cap"
                  : "Valuation"
              }
            >
              <TextInput
                value={
                  values.valuation ? formatNumber(values.valuation, true) : ""
                }
                placeholder={"10 000 000"}
                onChange={(e) => handleChange("valuation", e)}
              />
            </Field>

            <Field label={"Valuation type"} icon={null}>
              <FormSelect<ValuationTypeValue>
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
                setValue={(value) =>
                  setFieldValue("valuationType", value?.value)
                }
                options={[
                  { label: "Pre-Money", value: "PRE_MONEY" as const },
                  { label: "Post-Money", value: "POST_MONEY" as const },
                ]}
              />
            </Field>
          </div>

          <div className="border-t border-gray-100" />

          <Field
            icon={<Banknote className="h-4 w-4 text-gray-400" />}
            label="Share price"
          >
            <div className="flex w-full items-center gap-2">
              <div className="w-32 shrink-0">
                <FormSelect<Currency>
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
                  placeholder="Currency"
                />
              </div>
              <TextInput
                value={
                  values.pricePerShare
                    ? formatNumber(values.pricePerShare, true)
                    : ""
                }
                onChange={(e) => {
                  const value = e.target.value;
                  const numericValue = value
                    .replace(/[^\d.]/g, "")
                    .replace(/(\..*)\./g, "$1");
                  setFieldValue("pricePerShare", numericValue);
                }}
                placeholder="e.g. 0.23"
                type="text"
                pattern="[0-9\s.]*"
              />
            </div>
          </Field>
        </div>
      )}

      {tabIndex === 1 && <CoInvestors />}
    </div>
  );
}

type CoInvestor = {
  id: string;
  name: string;
  type: "NATURAL_PERSON" | "FUND";
};

function CoInvestors() {
  const { values, setFieldValue } = useFormikContext<FormValues>();
  const [newCoInvestorId, setNewCoInvestorId] = useState<string | undefined>();
  const [newCoInvestorName, setNewCoInvestorName] = useState("");
  const [newCoInvestorType, setNewCoInvestorType] = useState<
    "NATURAL_PERSON" | "FUND"
  >("FUND");
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

  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const handleRemoveCoInvestor = (index: number) => {
    const updatedCoInvestors = [...(values.coInvestors || [])];
    updatedCoInvestors.splice(index, 1);
    setFieldValue("coInvestors", updatedCoInvestors);
  };

  useEffect(() => {
    if (scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop =
        scrollContainerRef.current.scrollHeight;
    }
  }, [values.coInvestors]);

  const selectedIds = useMemo(() => {
    return (
      values.coInvestors?.filter((x) => x.id !== "NEW").map((y) => y.id) || []
    );
  }, [values.coInvestors]);

  return (
    <div className="flex flex-col items-stretch gap-6">
      <div className="flex items-start gap-4 rounded-md border border-gray-100 bg-gray-50 p-3">
        <Field
          label="Name"
          icon={<User className="h-4 w-4 text-gray-400" />}
          className="grow"
          required
        >
          <FormSelect
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
              value?.value?.type && setNewCoInvestorType(value.value.type);
            }}
            load={async (inputValue) => {
              const investors = await getOtherInvestors({
                entityId: values.companyId,
                search: inputValue,
              });
              return investors
                .filter((i) => !selectedIds.includes(i.id))
                .map((investor) => ({
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
          label="Type"
          icon={<Tags className="h-4 w-4 text-gray-400" />}
          className="w-[130px] shrink-0"
          required
        >
          <FormSelect<"NATURAL_PERSON" | "FUND">
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
          className="ml-auto mt-7 inline-flex h-[37px] shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-primary px-3 text-[13px] font-medium text-primary transition-colors hover:bg-primary-50 disabled:cursor-default disabled:opacity-40"
        >
          <Plus className="h-3.5 w-3.5" />
          Add
        </button>
      </div>

      {values.coInvestors && values.coInvestors.length > 0 ? (
        <div
          ref={scrollContainerRef}
          className="flex max-h-[200px] w-full flex-col items-stretch overflow-y-auto"
        >
          {values.coInvestors.map((coInvestor, index) => (
            <div
              key={index}
              className="group flex items-center gap-4 rounded-md border-b border-gray-100 px-2 py-2 last:border-b-0 hover:bg-gray-50"
            >
              <span className="text-[13px] text-gray-900">
                {coInvestor.name}
              </span>

              <button
                type="button"
                aria-label="Remove co-investor"
                onClick={() => handleRemoveCoInvestor(index)}
                className="ml-auto flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-red-500 opacity-0 transition-opacity hover:bg-red-50 group-hover:opacity-100"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="mx-auto my-[50px] text-[13px] text-gray-500">
          Add investors
        </p>
      )}
    </div>
  );
}

export { EditRound };
