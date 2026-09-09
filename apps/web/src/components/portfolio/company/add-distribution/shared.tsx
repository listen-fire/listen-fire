"use client";

/**
 * The pieces every exit form shares: the fund / legal-entity / asset
 * selects, and the close-resets-the-form hook. Ported from apps/app's
 * AddDistribution/index.tsx (selects) and its useResetFormOnClose.tsx.
 */

import { useEffect, useMemo, useState } from "react";
import { useFormikContext } from "formik";
import { Building2, X } from "lucide-react";

import { Field, FormSelect, TextInput, useToast } from "@/components/portfolio";
import { buttonClass } from "@/components/ui";
import { trpc } from "@/lib/trpc";

import type {
  AcquisitionFormValues,
  Holdings,
  LegalEntity,
  SecondarySaleFormValues,
} from "./types";

/**
 * Rendered inside a <Formik> so it can reach the form context. Our
 * FormModal unmounts its children when closed, so this is belt-and-braces
 * — it matches what the sibling ported forms do.
 */
export function ResetFormOnClose({ isOpen }: { isOpen: boolean }) {
  const { resetForm } = useFormikContext();

  useEffect(() => {
    if (!isOpen) {
      resetForm();
    }
  }, [isOpen, resetForm]);

  return null;
}

/**
 * The Cancel/Save row each body renders at the end of its own scroll area
 * (apps/app put these inside the modal body, not a modal footer, so the
 * long acquisition form scrolls them with the content). Not FormFooter:
 * that one submits a surrounding <form>, and these forms submit through
 * formik's submitForm on click, with no <form> element in play.
 */
export function FormActions({
  onCancel,
  onSave,
  saveLabel,
}: {
  onCancel?: () => void;
  onSave: () => void;
  saveLabel: string;
}) {
  return (
    <div className="flex w-full items-center justify-end gap-3 py-4">
      {onCancel && (
        <button
          type="button"
          onClick={onCancel}
          className={buttonClass({ variant: "ghost" })}
        >
          Cancel
        </button>
      )}
      <button
        type="button"
        onClick={onSave}
        className={`${buttonClass({ variant: "primary" })} px-5`}
      >
        {saveLabel}
      </button>
    </div>
  );
}

function uniqByValue<T extends { value: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (seen.has(item.value)) return false;
    seen.add(item.value);
    return true;
  });
}

export function FundSelect({
  selected,
  onSelect,
  holdings,
  label = "Fund",
  isRequired = false,
  fieldPrefix,
}: {
  selected: string | undefined;
  onSelect: (fundId: string) => void;
  holdings: Holdings | undefined;
  label?: string;
  isRequired?: boolean;
  fieldPrefix?: string;
  isInvalid?: boolean;
}) {
  const { setFieldTouched } = useFormikContext();
  const [funds, setFunds] = useState<{ label: string; value: string }[]>([]);

  useEffect(() => {
    const options =
      holdings?.map((entity) => ({
        label: entity.fundName,
        value: entity.fundId,
      })) ?? [];

    setFunds(uniqByValue(options));
  }, [holdings, selected, onSelect, fieldPrefix, setFieldTouched]);

  const selectedFund = useMemo(() => {
    return funds.find((fund) => fund.value === selected);
  }, [selected, funds]);

  return (
    <Field
      label={label}
      icon={<Building2 className="h-3.5 w-3.5 text-gray-400" />}
      required={isRequired}
    >
      <FormSelect
        placeholder="Select fund..."
        value={selectedFund}
        options={funds}
        setValue={(value) => {
          if (value?.value) {
            onSelect(value?.value);
            setFieldTouched(
              fieldPrefix ? `${fieldPrefix}.fundId` : "fundId",
              true,
            );
          }
        }}
      />
    </Field>
  );
}

export function LegalEntitySelect({
  onSelect,
  selectedEntity,
  label = "Investor",
  isRequired = false,
  isDisabled = false,
}: {
  onSelect: (entity: LegalEntity) => void;
  selectedEntity?: LegalEntity;
  label?: string;
  isRequired?: boolean;
  isInvalid?: boolean;
  isDisabled?: boolean;
}) {
  const toast = useToast();
  const { setFieldTouched } = useFormikContext();
  const [selectValue, setSelectValue] = useState<{
    label: string;
    value: LegalEntity;
  } | null>(null);

  useEffect(() => {
    if (selectedEntity) {
      setSelectValue({ label: selectedEntity.name, value: selectedEntity });
    } else {
      setSelectValue(null);
    }
  }, [selectedEntity]);

  const { mutateAsync: getLegalEntities } =
    trpc.views.portfolio.company.getLegalEntities.useMutation();

  const loadOptions = async (
    inputValue: string,
  ): Promise<{ label: string; value: LegalEntity }[]> => {
    try {
      const investors = await getLegalEntities({
        entityId: undefined,
        search: inputValue,
      });
      return investors.map((investor) => ({
        label: investor.name,
        value: {
          id: investor.id,
          name: investor.name,
          type: investor.type === "FUND" ? "FUND" : "NATURAL_PERSON",
        },
      }));
    } catch (error) {
      console.error("Failed to load investors:", error);
      toast.error("Could not load buyer options.");
      return [];
    }
  };

  const handleCreateOption = (inputValue: string): LegalEntity => {
    const newEntity: LegalEntity = {
      id: "NEW",
      name: inputValue,
      type: "NATURAL_PERSON",
    };

    setSelectValue({ label: newEntity.name, value: newEntity });
    onSelect(newEntity);
    setFieldTouched("buyer", true);
    return newEntity;
  };

  return (
    <Field
      label={label}
      icon={<Building2 className="h-3.5 w-3.5 text-gray-400" />}
      required={isRequired}
    >
      <FormSelect<LegalEntity>
        placeholder="Select or create..."
        value={selectValue ?? undefined}
        isDisabled={isDisabled}
        setValue={(selectedOption) => {
          setSelectValue(selectedOption);
          if (selectedOption) {
            onSelect(selectedOption.value);
          }
          setFieldTouched("buyer", true);
        }}
        load={loadOptions}
        onCreateOption={handleCreateOption}
      />
    </Field>
  );
}

export function AcquisitionsAssetSelect({
  index,
  assetIndex,
  holdings,
  isDisabled = false,
}: {
  index: number;
  assetIndex: number;
  holdings: Holdings | undefined;
  isDisabled?: boolean;
}) {
  const { values, setFieldValue, setFieldTouched } =
    useFormikContext<AcquisitionFormValues>();
  const sellerId = values.transactions[index]?.fundId;
  const assetId = values.transactions[index]?.assetsSold?.[assetIndex]?.id;

  const options = useMemo(() => {
    if (!sellerId) return [];
    return (
      holdings
        ?.filter((h) => h.fundId === sellerId && h.numAssets > 0)
        .map((h) => ({ label: h.assetName, value: h.assetId })) ?? []
    );
  }, [sellerId, holdings]);

  const value = useMemo(() => {
    if (!assetId || !options) return undefined;
    return options.find((opt) => opt.value === assetId);
  }, [assetId, options]);

  const fundHoldings = holdings?.filter(
    (h) => h.assetId === assetId && h.fundId === sellerId,
  );
  const remainingShares = fundHoldings
    ?.map((h) => h.numAssets)
    .reduce((accumulator, currentValue) => {
      return accumulator + currentValue;
    }, 0);

  return (
    <div className="flex items-center gap-2">
      <div className="w-[150px] shrink-0 grow">
        <TextInput
          type="number"
          value={values.transactions[index]?.assetsSold?.[assetIndex]?.amount}
          onChange={(e) => {
            const stripped = e.target.value.replace(/[^0-9.]/g, "");
            const val = stripped === "" ? undefined : parseFloat(stripped);
            setFieldValue(
              `transactions[${index}].assetsSold[${assetIndex}].amount`,
              val,
            );
            setFieldTouched(
              `transactions[${index}].assetsSold[${assetIndex}].amount`,
              true,
            );
          }}
          placeholder={value ? `(${remainingShares} held)` : ""}
        />
      </div>
      <div className="w-[150px] shrink-0 grow">
        <FormSelect<string>
          isDisabled={isDisabled || !sellerId}
          value={value}
          options={options}
          setValue={(selected) => {
            setFieldValue(
              `transactions[${index}].assetsSold[${assetIndex}].id`,
              selected?.value ?? undefined,
            );

            if (selected?.value !== assetId) {
              setFieldValue(
                `transactions[${index}].assetsSold[${assetIndex}].numAssets`,
                undefined,
              );
            }
            setFieldTouched(
              `transactions[${index}].assetsSold[${assetIndex}].id`,
              true,
            );
          }}
          placeholder="Select asset..."
        />
      </div>
      <button
        type="button"
        aria-label="Remove transaction"
        className={`${buttonClass({ variant: "ghost", size: "sm" })} ml-auto h-7 w-7 justify-center rounded-full p-0`}
        onClick={() => {
          const items = [...(values.transactions || [])];
          items[index].assetsSold.splice(assetIndex, 1);
          setFieldValue("transactions", items);
        }}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function AssetSelect({
  index,
  holdings,
  fieldPrefix,
  isRequired = false,
  isDisabled = false,
}: {
  index: number;
  holdings: Holdings | undefined;
  fieldPrefix: string;
  isRequired?: boolean;
  isDisabled?: boolean;
  isInvalid?: boolean;
}) {
  const { values, setFieldValue, setFieldTouched } =
    useFormikContext<SecondarySaleFormValues>();
  const sellerId = values.transactions[index]?.sellerId;
  const assetId = values.transactions[index]?.assetId;

  const options = useMemo(() => {
    if (!sellerId) return [];
    return (
      holdings
        ?.filter((h) => h.fundId === sellerId && h.numAssets > 0)
        .map((h) => ({ label: h.assetName, value: h.assetId })) ?? []
    );
  }, [sellerId, holdings]);

  const value = useMemo(() => {
    if (!assetId || !options) return undefined;
    return options.find((opt) => opt.value === assetId);
  }, [assetId, options]);

  const fundHoldings = holdings?.filter(
    (h) => h.assetId === assetId && h.fundId === sellerId,
  );
  const remainingShares = fundHoldings
    ?.map((h) => h.numAssets)
    .reduce((accumulator, currentValue) => {
      return accumulator + currentValue;
    }, 0);

  const labelText = `Asset ${value ? `(${remainingShares} held)` : ""}`;

  return (
    <Field label={labelText} icon={null} required={isRequired}>
      <FormSelect<string>
        isDisabled={isDisabled || !sellerId}
        value={value}
        options={options}
        setValue={(selected) => {
          setFieldValue(`${fieldPrefix}.assetId`, selected?.value ?? undefined);

          if (selected?.value !== assetId) {
            setFieldValue(`${fieldPrefix}.numAssets`, undefined);
          }
          setFieldTouched(`${fieldPrefix}.assetId`, true);
        }}
        placeholder="Select asset..."
      />
    </Field>
  );
}
