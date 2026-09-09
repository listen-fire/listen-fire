"use client";

/**
 * Port of apps/app's FundingSection/PriceItem.tsx (V-20). The formik
 * initialValues, the numeric-input sanitising and the submit payloads are
 * byte-faithful to the original — a price edit moves a company's whole
 * valuation, so the shaping of `price`/`currency`/`date` is left alone.
 */

import { useMemo } from "react";
import { Formik } from "formik";
import { Calendar, DollarSign, MessageCircle, Package, Pencil, Tag as TagIcon, Trash2, TriangleAlert } from "lucide-react";

import {
  Field,
  FormModal,
  FormSelect,
  FutureDateWarning,
  TextArea,
  TextInput,
  formatDate,
  formatMoney,
  useDisclosure,
} from "@/components/portfolio";
import { buttonClass } from "@/components/ui";
import { trpc } from "@/lib/trpc";

import {
  AssetTypeMap,
  CurrencySelect,
  HistoryItemBox,
  HistoryMoreButton,
  NotesSection,
  ResetFormOnClose,
  priceLineKey,
} from "./common";
import type { Price } from "./types";

import { CurrencyIsoCode, PriceType } from "#trpc";

const priceTitleByType: Record<PriceType, string> = {
  FROM_PRICED_ROUND: "Price",
  CONVERSION: "Conversion Price",
  FROM_ASSET_HOLDER: "Adjusted Price",
};

function PriceItem({
  price,
}: {
  price: Pick<
    Price,
    | "id"
    | "date"
    | "price"
    | "currency"
    | "notes"
    | "asset_id"
    | "type"
    | "name"
    | "priceType"
  >;
}) {
  const removeDisclosure = useDisclosure();
  const updateDisclosure = useDisclosure();

  const utils = trpc.useUtils();
  const { mutateAsync: addNote } =
    trpc.views.portfolio.company.addPriceNote.useMutation();

  return (
    <>
      <RemovePrice priceId={price.id} disclosure={removeDisclosure} />
      <UpdatePrice price={price} disclosure={updateDisclosure} />
      <HistoryItemBox
        key={price.id}
        size="sm"
        title={{
          icon: <TagIcon />,
          title: priceTitleByType[price.priceType] ?? "Price",
        }}
        infoLine={
          <div className="flex overflow-hidden text-[13px]">
            <span className="shrink truncate leading-[18px] text-gray-400">
              {priceLineKey(price)}
            </span>
            <span className="shrink-0 leading-[18px] text-gray-400">
              : {formatMoney(price.price, { currency: price.currency })}
            </span>
          </div>
        }
        actions={
          <HistoryMoreButton
            menuItems={[
              {
                label: "Edit",
                icon: <Pencil />,
                onClick: () => updateDisclosure.onOpen(),
              },
              {
                label: "Delete",
                icon: <Trash2 />,
                onClick: () => removeDisclosure.onOpen(),
              },
            ]}
          />
        }
        relatedNumbers={{
          attachments: null,
          notes: price.notes?.length ?? 0,
          coinvestors: null,
        }}
        expandedContent={
          <NotesSection
            notes={price.notes}
            onAdd={async (text) => {
              await addNote({ priceId: price.id, note: text });
              utils.views.portfolio.company.invalidate();
            }}
          />
        }
      />
    </>
  );
}

function RemovePrice({
  priceId,
  disclosure,
}: {
  priceId: string;
  disclosure: { isOpen: boolean; onClose: () => void };
}) {
  const { mutateAsync: removePrice, isLoading } =
    trpc.views.portfolio.company.removePrice.useMutation();
  const utils = trpc.useUtils();

  return (
    <FormModal
      isOpen={disclosure.isOpen}
      onClose={disclosure.onClose}
      title="Are you sure?"
      footer={
        <div className="flex items-center justify-end gap-3">
          <button
            type="button"
            disabled={isLoading}
            onClick={disclosure.onClose}
            className={buttonClass({ variant: "ghost" })}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={isLoading}
            className={buttonClass({ variant: "danger" })}
            onClick={async () => {
              await removePrice({ id: priceId });
              utils.views.portfolio.company.invalidate();
              disclosure.onClose();
            }}
          >
            Delete
          </button>
        </div>
      }
    >
      <p className="text-[13px] text-gray-600">
        This action cannot be undone. This will permanently delete the price.
      </p>
    </FormModal>
  );
}

function UpdatePrice({
  price,
  disclosure,
}: {
  price: Pick<Price, "id" | "date" | "price" | "currency" | "asset_id" | "type" | "name">;
  disclosure: { isOpen: boolean; onClose: () => void };
}) {
  const { mutateAsync: updatePrice, isLoading } =
    trpc.views.portfolio.company.updatePrice.useMutation();
  const utils = trpc.useUtils();

  return (
    <Formik<{
      price: string;
      currency: CurrencyIsoCode;
      date: string;
    }>
      enableReinitialize
      initialValues={{
        price: price.price.toString(),
        currency: price.currency,
        date: formatDate(new Date(price.date), "yyyy-MM-dd"),
      }}
      onSubmit={async (values) => {
        await updatePrice({
          id: price.id,
          price: parseFloat(values.price.replace(/[^0-9.]/g, "")),
          currency: values.currency,
          date: new Date(values.date).toISOString(),
        });
        utils.views.portfolio.company.invalidate();
        disclosure.onClose();
      }}
    >
      {({ setFieldValue, setFieldTouched, values, handleSubmit, isSubmitting }) => (
        <FormModal
          isOpen={disclosure.isOpen}
          onClose={disclosure.onClose}
          title={`Update ${
            price.asset_id
              ? `Price for ${price.name} (${AssetTypeMap[price.type ?? "UNKNOWN"]})`
              : "Price Per Share"
          }`}
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
              label="Price"
              icon={<DollarSign className="h-4 w-4 text-gray-400" />}
              required
              className="grow"
            >
              <div className="flex items-start gap-2">
                <div className="w-[130px] shrink-0">
                  <CurrencySelect
                    value={values.currency}
                    onChange={(value) => {
                      setFieldValue("currency", value);
                      setFieldTouched("currency", true);
                    }}
                  />
                </div>
                <TextInput
                  value={values.price?.toString() || ""}
                  onChange={(e) => {
                    const value = e.target.value;
                    const numericValue = value
                      .replace(/[^\d.]/g, "")
                      .replace(/(\..*)\./g, "$1");
                    setFieldValue("price", numericValue);
                    setFieldTouched("price", true);
                  }}
                  placeholder="Value"
                  type="text"
                  pattern="[0-9\s.]*"
                />
              </div>
            </Field>
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
          </div>
        </FormModal>
      )}
    </Formik>
  );
}

function AddPrice({
  companyId,
  disclosure,
}: {
  companyId: string;
  disclosure: { isOpen: boolean; onClose: () => void };
}) {
  const { mutateAsync: addPrice, isLoading } =
    trpc.views.portfolio.company.addPrice.useMutation();
  const utils = trpc.useUtils();

  return (
    <Formik<{
      price: string;
      currency: CurrencyIsoCode;
      date?: string;
      assetId: string | null;
      note?: string;
    }>
      enableReinitialize
      initialValues={{
        price: "",
        currency: CurrencyIsoCode.USD,
        date: "",
        assetId: null,
        note: "",
      }}
      onSubmit={async (values) => {
        await addPrice({
          companyId,
          assetId: values.assetId ?? undefined,
          price: Number(values.price),
          currency: values.currency,
          date: values.date || undefined,
          note: values.note || undefined,
        });
        utils.views.portfolio.company.invalidate();
        disclosure.onClose();
      }}
    >
      {({ setFieldValue, setFieldTouched, values, handleSubmit, isSubmitting }) => (
        <FormModal
          isOpen={disclosure.isOpen}
          onClose={disclosure.onClose}
          title="Add Price"
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
              label="Asset"
              icon={<Package className="h-4 w-4 text-gray-400" />}
              required
            >
              <AssetSelect
                companyId={companyId}
                value={values.assetId}
                setValue={(value) => setFieldValue("assetId", value)}
              />
            </Field>
            <Field
              label="Price"
              icon={<DollarSign className="h-4 w-4 text-gray-400" />}
              required
            >
              <div className="flex items-start gap-2">
                <div className="w-[130px] shrink-0">
                  <CurrencySelect
                    value={values.currency}
                    onChange={(value) => {
                      setFieldValue("currency", value);
                      setFieldTouched("currency", true);
                    }}
                  />
                </div>
                <TextInput
                  value={values.price}
                  onChange={(e) => {
                    const value = e.target.value;
                    const numericValue = value
                      .replace(/[^\d.]/g, "")
                      .replace(/(\..*)\./g, "$1");
                    setFieldValue("price", numericValue);
                    setFieldTouched("price", true);
                  }}
                  placeholder="Value"
                  type="text"
                  pattern="[0-9\s.]*"
                />
              </div>
            </Field>
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
            </Field>
            <Field
              label="Note"
              icon={<MessageCircle className="h-4 w-4 text-gray-400" />}
            >
              <TextArea
                rows={3}
                value={values.note}
                onChange={(e) => {
                  setFieldValue("note", e.target.value);
                  setFieldTouched("note", true);
                }}
                placeholder="Write a note..."
              />
            </Field>
            <p className="text-[12px] leading-5 text-gray-400">
              <TriangleAlert
                className="mb-[-1px] mr-1.5 inline h-3.5 w-3.5"
                color="#FFA500"
              />
              Adding prices will affect valuation.
              <br />
              If a future price marked down by a % already exists for this asset
              you will need to update these manually.
            </p>
          </div>
        </FormModal>
      )}
    </Formik>
  );
}

function AssetSelect({
  companyId,
  value,
  setValue,
}: {
  companyId: string;
  value: string | null;
  setValue: (value: string | null) => void;
}) {
  const { data: baseOptions } =
    trpc.views.portfolio.company.getPriceAssetOptions.useQuery({
      companyId,
    });

  const options = useMemo(() => {
    return [
      { value: null, label: "Price per share (all equity assets)" },
      ...(baseOptions ?? []),
    ];
  }, [baseOptions]);

  return (
    <FormSelect<string | null>
      placeholder="Asset"
      options={options}
      value={options.find((option) => option.value === value)}
      setValue={(option) => {
        setValue(option?.value ?? null);
      }}
    />
  );
}

export { PriceItem, AddPrice };
