"use client";

import { useEffect, useMemo, useState } from "react";
import { useFormikContext } from "formik";
import { format } from "date-fns";
import { Building, Building2, Clock, Globe, Layers } from "lucide-react";

import { trpc } from "@/lib/trpc";
import {
  Field,
  FormSelect,
  FutureDateWarning,
  TextInput,
  startCase,
} from "@/components/portfolio";

import type { FormValues } from "../types";
import { useStepper } from "../stepper";
import { useFormMetadata } from "../form";

import { LegalEntityType } from "#trpc";

const ICON = "h-4 w-4 text-gray-400";

const legalEntityTypeMap = {
  COMPANY: "Company",
  ESOP: "Employee Stock Ownership Plan",
  FUND: "Fund",
  NATURAL_PERSON: "Person",
  PORTFOLIO_COMPANY: "Company",
  SPV: "SPV",
} as const satisfies Record<LegalEntityType, string>;

function useInitialInvestingEntities() {
  const { setFieldValue } = useFormikContext<FormValues>();
  const [hasInitialized, setHasInitialized] = useState(false);
  const [investingEntityCount, setInvestingEntityCount] = useState<number>(0);
  const { mutateAsync: findInvestingEntitiesByName, isLoading } =
    trpc.views.portfolio.company.findInvestingEntitiesByName.useMutation();

  useEffect(() => {
    if (!hasInitialized) {
      findInvestingEntitiesByName({ name: "" })
        .then((results) => {
          setInvestingEntityCount(results.length);
          if (results.length > 0) {
            setFieldValue("investingEntity", results[0].id);
            setFieldValue("investingEntityName", results[0].name);
          }
        })
        .finally(() => {
          setHasInitialized(true);
        });
    }
  }, [findInvestingEntitiesByName, setFieldValue, hasInitialized]);

  return { isLoading, hasInitialized, investingEntityCount };
}

export function BasicInfo() {
  const { values } = useFormikContext<FormValues>();
  const { setStepValidity } = useStepper();
  const investmentIsNew = values["entity"] === "NEW";
  const { isLoading, hasInitialized, investingEntityCount } =
    useInitialInvestingEntities();

  useEffect(() => {
    if (values["entity"] && values["investmentDate"]) {
      setStepValidity("BASIC_INFO", true);
    } else {
      setStepValidity("BASIC_INFO", false);
    }
  }, [values, setStepValidity]);

  if (isLoading || !hasInitialized) {
    return (
      <div className="flex items-center justify-center py-10 text-[13px] text-gray-400">
        Loading…
      </div>
    );
  }

  return (
    <div className="flex w-full flex-col items-stretch gap-8 overflow-x-hidden">
      <EntitySelect />
      {investmentIsNew ? (
        <div className="flex w-full items-start gap-3">
          <Website />
          <EntityTypeToggle />
        </div>
      ) : null}
      <InvestingEntitySelect investingEntityCount={investingEntityCount} />
      {values["entityType"] === "COMPANY" ||
      values["entityType"] === "PORTFOLIO_COMPANY" ? (
        <div className="grid w-full grid-cols-2 gap-2">
          <RoundName />
          <InvestmentDate />
        </div>
      ) : values["entityType"] === "FUND" ? (
        <InvestmentDate />
      ) : null}
    </div>
  );
}

type EntityOptionValue = { id: string; type: LegalEntityType | undefined };

function EntitySelect() {
  const { values, setFieldValue } = useFormikContext<FormValues>();
  const { isEntityNameReadOnly } = useFormMetadata();
  const { mutateAsync: findInvestableEntitiesByName } =
    trpc.views.portfolio.company.findInvestableEntitiesByName.useMutation();

  const value = useMemo(
    () =>
      values["entity"] && values["entityName"]
        ? {
            label: values["entityName"],
            value: { id: values["entity"], type: values["entityType"] },
          }
        : undefined,
    [values],
  );

  return (
    <Field
      label="What did you invest in?"
      icon={<Building2 className={ICON} />}
      required
    >
      <FormSelect<EntityOptionValue>
        autoFocus
        isDisabled={isEntityNameReadOnly}
        placeholder="Startup or Fund..."
        loading={false}
        value={value}
        setValue={(value) => {
          if (!value?.value) return;

          setFieldValue("entity", value.value.id);
          setFieldValue("entityName", value.label);
          setFieldValue("entityType", value.value.type);
        }}
        load={async (inputValue: string) => {
          const entities = await findInvestableEntitiesByName({
            name: inputValue,
          });
          return entities.map((entity) => ({
            label: entity.name,
            value: { id: entity.id, type: entity.type ?? undefined },
          }));
        }}
        onCreateOption={(name: string) => {
          setFieldValue("entity", "NEW");
          setFieldValue("entityName", name);
          setFieldValue("entityType", "COMPANY");
          return { id: "NEW", type: LegalEntityType.COMPANY };
        }}
      />
    </Field>
  );
}

function InvestingEntitySelect({
  investingEntityCount,
}: {
  investingEntityCount: number;
}) {
  const { values, setFieldValue } = useFormikContext<FormValues>();
  const { mutateAsync: findInvestingEntitiesByName, isLoading } =
    trpc.views.portfolio.company.findInvestingEntitiesByName.useMutation();

  const value = useMemo(
    () =>
      values["investingEntity"] && values["investingEntityName"]
        ? {
            label: values["investingEntityName"],
            value: values["investingEntity"],
          }
        : undefined,
    [values],
  );

  if (!value || investingEntityCount <= 1) {
    return null;
  }

  return (
    <Field
      label="Which fund did you invest through?"
      icon={<Building2 className={ICON} />}
      required
    >
      <FormSelect<string>
        placeholder="Fund..."
        loading={isLoading}
        value={value}
        setValue={(value) => {
          if (!value) return;
          setFieldValue("investingEntity", value.value);
          setFieldValue("investingEntityName", value.label);
        }}
        load={async (inputValue: string) => {
          const entities = await findInvestingEntitiesByName({
            name: inputValue,
          });
          return entities.map((entity) => ({
            label: entity.name,
            value: entity.id,
          }));
        }}
      />
    </Field>
  );
}

function Website() {
  const { values, setFieldValue } = useFormikContext<FormValues>();

  return (
    <Field
      className="grow"
      label="Website"
      icon={<Globe className={ICON} />}
    >
      <TextInput
        placeholder="example.com"
        value={values["entityWebsite"] ?? ""}
        onChange={(e) => setFieldValue("entityWebsite", e.target.value)}
      />
    </Field>
  );
}

function EntityTypeToggle() {
  const { values, setFieldValue } = useFormikContext<FormValues>();
  const value = useMemo(
    () =>
      values["entityType"]
        ? {
            label: legalEntityTypeMap[values["entityType"]],
            value: values["entityType"],
          }
        : undefined,
    [values],
  );

  return (
    <Field
      className="w-[160px] shrink-0"
      label="Type"
      icon={<Building className={ICON} />}
      required
    >
      <FormSelect<LegalEntityType>
        placeholder="Company / Fund"
        loading={false}
        value={value}
        setValue={(value) => setFieldValue("entityType", value?.value)}
        options={[
          { label: "Company", value: LegalEntityType.COMPANY },
          { label: "Fund", value: LegalEntityType.FUND },
        ]}
      />
    </Field>
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
    <Field label="Round" icon={<Layers className={ICON} />}>
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
            "investmentDate",
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

function InvestmentDate() {
  const { values, setFieldValue } = useFormikContext<FormValues>();

  return (
    <Field label="Investment Date" icon={<Clock className={ICON} />} required>
      <TextInput
        type="date"
        value={values["investmentDate"] ?? ""}
        onChange={(e) => setFieldValue("investmentDate", e.target.value)}
      />
      <FutureDateWarning value={values["investmentDate"] ?? ""} />
    </Field>
  );
}
