"use client";

/**
 * Port of apps/app's FundingSection/EventItem.tsx (V-20). Every string that
 * describes money — the "Raised X at Y (Post-money)" headline, the acquisition
 * / fund-distribution / wind-down inflow lines, the secondary-sale
 * "N shares for $M" line — is copied verbatim, including which currency and
 * fraction-digit options each one passes to formatMoney.
 *
 * Dropped: attachments (getEventHistory no longer returns resources) and the
 * dev-mode model-id popover.
 */

import { useState } from "react";
import Link from "next/link";
import { Formik } from "formik";
import {
  ArrowDown,
  ArrowRightLeft,
  Building2,
  Calendar,
  DollarSign,
  HelpCircle,
  Landmark,
  Pencil,
  Plus,
  Shapes,
  Skull,
  Split,
  Trash2,
  TrendingDown,
  User,
  X,
} from "lucide-react";

import {
  Field,
  FormModal,
  FormSelect,
  FutureDateWarning,
  TextInput,
  formatDate,
  formatMoney,
  useDisclosure,
} from "@/components/portfolio";
import { buttonClass } from "@/components/ui";
import { RouterOutputs, trpc } from "@/lib/trpc";

import { EditRound } from "@/components/portfolio/company/edit-round";

import {
  AssetTypeColorMap,
  AssetTypeMap,
  HistoryItemBox,
  HistoryMoreButton,
  NotesSection,
  ResetFormOnClose,
  Tag,
} from "./common";

import {
  AssetType,
  CurrencyIsoCode,
  EquityRoundType,
  LegalEntityId,
} from "#trpc";

type Event =
  RouterOutputs["views"]["portfolio"]["company"]["getEventHistory"]["events"][number];

function EventItem({ event, companyId }: { event: Event; companyId: string }) {
  const data = event.data as
    | { percentage?: number; multiple?: number }
    | null
    | undefined;
  const raised = event.raised_amount
    ? `Raised ${formatMoney(event.raised_amount, { currency: event.raised_currency, isAbbrFormat: true })}`
    : "";
  const valuation = event.valuation
    ? `${formatMoney(event.valuation, { currency: event.valuation_currency, isAbbrFormat: true })}${event.valuation_type === "POST_MONEY" ? " (Post-money)" : event.valuation_type === "PRE_MONEY" ? " (Pre-money)" : ""}`
    : "";
  const eventLine = raised
    ? [raised, valuation].filter(Boolean).join(" at ")
    : valuation
      ? `Valuation: ${valuation}`
      : "";

  const [addingInvestors, setAddingInvestors] = useState(false);
  const [newCoInvestorId, setNewCoInvestorId] = useState<string | null>();
  const [newCoInvestorName, setNewCoInvestorName] = useState("");
  const [newCoInvestorType, setNewCoInvestorType] = useState<
    "NATURAL_PERSON" | "FUND"
  >("FUND");

  const editDisclosure = useDisclosure();
  const utils = trpc.useUtils();
  const { mutateAsync: addNote } =
    trpc.views.portfolio.company.addEventNote.useMutation();
  const { mutateAsync: getOtherInvestors } =
    trpc.views.portfolio.company.getOtherInvestors.useMutation();
  const { mutateAsync: addInvestor } =
    trpc.views.portfolio.company.addInvestorToEvent.useMutation();
  const { mutateAsync: removeMarkdown } =
    trpc.views.portfolio.company.removeMarkdown.useMutation();
  const { mutateAsync: removeEvent } =
    trpc.views.portfolio.company.removeEvent.useMutation();
  const removeEventDisclosure = useDisclosure();
  const deleteDisclosure = useDisclosure();
  const addProceedsDisclosure = useDisclosure();

  const notesSection = (
    <NotesSection
      notes={event.notes}
      onAdd={async (text) => {
        await addNote({ eventId: event.id, note: text });
        utils.views.portfolio.company.invalidate();
      }}
    />
  );

  return event.type === "INVESTMENT_ROUND" ? (
    <>
      <EditRound
        company={{ id: companyId as LegalEntityId }}
        round={{
          event_id: event.id,
          round_type: EquityRoundType.UNKNOWN, // TODO: fix
          event_date: event.date,
          raised_amount: event.raised_amount,
          raised_currency: event.raised_currency,
          pricePerShare: null,
          valuation: event.valuation,
          valuation_type: event.valuation_type,
          investment_round_type: event.investment_round_type ?? null,
          investors:
            event.investors?.map((i) => ({
              id: i.id,
              type: null,
              name: i.name,
            })) ?? [],
        }}
        {...editDisclosure}
        onClose={() => {
          utils.views.portfolio.company.invalidate();
          editDisclosure.onClose();
        }}
      />
      <ConfirmDelete
        disclosure={removeEventDisclosure}
        message="This action cannot be undone. This will permanently delete this round."
        onConfirm={async () => {
          await removeEvent({ eventId: event.id });
          utils.views.portfolio.company.invalidate();
          removeEventDisclosure.onClose();
        }}
      />
      <HistoryItemBox
        key={event.id}
        colourHue={280}
        title={{
          icon: <DollarSign />,
          title:
            (event.name && event.name !== "Unknown" ? event.name : "Funding") +
            " Round",
          tags: event.investment_round_type
            ? (() => {
                const assetKey =
                  event.investment_round_type === "CONVERTIBLE"
                    ? "CONVERTIBLE"
                    : event.investment_round_type === "OTHER"
                      ? "UNKNOWN"
                      : "EQUITY";
                return [
                  <Tag key="instrument" colour={AssetTypeColorMap[assetKey]}>
                    {event.investment_round_type === "CONVERTIBLE"
                      ? "Convertible"
                      : event.investment_round_type === "OTHER"
                        ? "Other"
                        : "Equity"}
                  </Tag>,
                ];
              })()
            : undefined,
        }}
        infoLine={
          eventLine ? (
            <span className="text-[13px] text-gray-400">{eventLine}</span>
          ) : null
        }
        actions={
          <HistoryMoreButton
            menuItems={[
              {
                label: "Edit",
                icon: <Pencil />,
                onClick: () => {
                  editDisclosure.onOpen();
                },
              },
              {
                label: "Delete",
                icon: <Trash2 />,
                onClick: () => {
                  removeEventDisclosure.onOpen();
                },
              },
            ]}
          />
        }
        relatedNumbers={{
          attachments: null,
          notes: event.notes?.length ?? 0,
          coinvestors: event.investors?.length ?? 0,
        }}
        expandedContent={
          <div className="flex flex-col items-stretch gap-5">
            <div className="flex flex-col items-stretch gap-2">
              <div className="flex items-center gap-3">
                <span className="text-[16px] font-semibold">Investors</span>
                <button
                  type="button"
                  onClick={() => setAddingInvestors(!addingInvestors)}
                  className={buttonClass({
                    variant: addingInvestors ? "danger" : "secondary",
                    size: "sm",
                  })}
                >
                  {addingInvestors ? (
                    <X className="h-3 w-3" />
                  ) : (
                    <Plus className="h-3 w-3" />
                  )}
                  {addingInvestors ? "Cancel" : "Add investor"}
                </button>
              </div>
              {!event.investors?.length && !addingInvestors ? (
                <span className="text-[13px] text-gray-400">No investors</span>
              ) : (
                <>
                  {addingInvestors ? (
                    <div className="flex flex-wrap items-start gap-4">
                      <Field
                        label="Name"
                        icon={<User className="h-4 w-4 text-gray-400" />}
                        required
                        className="min-w-[240px] grow"
                      >
                        <FormSelect<{
                          id: string | null;
                          type: "NATURAL_PERSON" | "FUND";
                        }>
                          autoFocus
                          placeholder="Select a co-investor"
                          value={
                            newCoInvestorName
                              ? {
                                  label: newCoInvestorName,
                                  value: {
                                    id: newCoInvestorId || null,
                                    type: newCoInvestorType,
                                  },
                                }
                              : undefined
                          }
                          setValue={(value) => {
                            setNewCoInvestorId(value?.value?.id || null);
                            setNewCoInvestorName(value?.label || "");
                            if (value?.value?.type)
                              setNewCoInvestorType(value.value.type);
                          }}
                          load={async (inputValue) => {
                            const investors = await getOtherInvestors({
                              entityId: companyId,
                              search: inputValue,
                            });
                            return investors.map((investor) => ({
                              label: investor.name,
                              value: {
                                id: investor.id as string | null,
                                type:
                                  investor.type === "FUND"
                                    ? ("FUND" as const)
                                    : ("NATURAL_PERSON" as const),
                              },
                            }));
                          }}
                          onCreateOption={(name: string) => {
                            setNewCoInvestorName(name);
                            setNewCoInvestorId(null);
                            return { id: null, type: newCoInvestorType };
                          }}
                        />
                      </Field>

                      <Field
                        label="Type"
                        icon={<Shapes className="h-4 w-4 text-gray-400" />}
                        required
                        className="w-[280px]"
                      >
                        <div className="flex w-full items-start gap-2">
                          <div className="grow">
                            <FormSelect<"NATURAL_PERSON" | "FUND">
                              isDisabled={!!newCoInvestorId}
                              value={{
                                label:
                                  newCoInvestorType === "FUND"
                                    ? "Fund"
                                    : "Person",
                                value: newCoInvestorType,
                              }}
                              setValue={(value) =>
                                value?.value
                                  ? setNewCoInvestorType(value.value)
                                  : null
                              }
                              options={[
                                { label: "Fund", value: "FUND" },
                                { label: "Person", value: "NATURAL_PERSON" },
                              ]}
                            />
                          </div>
                          <button
                            type="button"
                            disabled={!newCoInvestorName || !newCoInvestorType}
                            className={buttonClass({ variant: "primary" })}
                            onClick={async () => {
                              if (!newCoInvestorName || !newCoInvestorType)
                                return;
                              await addInvestor({
                                eventId: event.id,
                                id: newCoInvestorId,
                                type: newCoInvestorType,
                                name: newCoInvestorName,
                                companyId,
                              });
                              setNewCoInvestorName("");
                              setNewCoInvestorId(undefined);
                              utils.views.portfolio.company.invalidate();
                            }}
                          >
                            Add
                          </button>
                        </div>
                      </Field>
                    </div>
                  ) : null}
                  {event.investors?.length ? (
                    <div className="-mx-3 mt-2 grid w-[calc(100%+24px)] grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
                      {event.investors
                        .slice()
                        .sort((a, b) => a.name.localeCompare(b.name))
                        .map((investor) => (
                          <InvestorDisplay
                            key={investor.id}
                            eventId={event.id}
                            investor={investor}
                          />
                        ))}
                    </div>
                  ) : null}
                </>
              )}
            </div>
            {notesSection}
          </div>
        }
      />
    </>
  ) : event.type === "DISTRIBUTION" && event.acquirer ? (
    <>
      <AddAcquisitionProceeds
        companyId={companyId}
        eventId={event.id}
        disclosure={addProceedsDisclosure}
      />
      <HistoryItemBox
        key={event.id}
        colourHue={100}
        title={{
          icon: <Building2 />,
          title: "Acquisition",
        }}
        infoLine={
          <div className="flex flex-col items-stretch gap-1 text-[13px] text-gray-400">
            <span>
              Acquired by:{" "}
              <Link
                href={`/portfolio/c/${event.acquirer.slug}`}
                className="text-primary hover:underline"
              >
                {event.acquirer.name}
              </Link>
            </span>
            {event.transactions.flatMap((transaction) => (
              <span key={transaction.transactionId}>
                Received:{" "}
                {transaction.inflows
                  .map((inflow) =>
                    inflow.assetType === "CURRENCY"
                      ? `${formatMoney(inflow.numAssets, { isAbbrFormat: true, currency: inflow.assetName as CurrencyIsoCode })} cash`
                      : `${formatMoney(inflow.numAssets, { isAbbrFormat: true, maximumFractionDigits: 0 })} ${inflow.assetName} (${AssetTypeMap[inflow.assetType as AssetType]})`,
                  )
                  .join(", ")}{" "}
                → {transaction.investingEntityKey.split(":")[1]}
              </span>
            ))}
          </div>
        }
        relatedNumbers={{
          attachments: null,
          notes: event.notes?.length ?? 0,
          coinvestors: null,
        }}
        expandedContent={
          <div className="flex flex-col items-stretch gap-2">{notesSection}</div>
        }
        actions={
          null /*<HStack>
            <HistoryMoreButton
              menuItems={[
                {
                  label: 'Add Proceeds',
                  icon: <Plus />,
                  onClick: () => {
                    addProceedsDisclosure.onOpen();
                  },
                },
              ]}
            />
          </HStack>*/
        }
      />
    </>
  ) : event.type === "FUND_DISTRIBUTION" ? (
    <HistoryItemBox
      key={event.id}
      colourHue={100}
      title={{
        icon: <Landmark />,
        title: "Fund Distribution",
      }}
      infoLine={
        <div className="flex flex-col items-stretch gap-1 text-[13px] text-gray-400">
          {event.transactions.flatMap((transaction) => (
            <span key={transaction.transactionId}>
              Distributed:{" "}
              {transaction.inflows
                .map((inflow) =>
                  inflow.assetType === "CURRENCY"
                    ? `${formatMoney(inflow.numAssets, { isAbbrFormat: true, currency: inflow.assetName as CurrencyIsoCode })} cash`
                    : `${formatMoney(inflow.numAssets, { isAbbrFormat: true, maximumFractionDigits: 0 })} ${inflow.assetName} (${AssetTypeMap[inflow.assetType as AssetType]})`,
                )
                .join(", ")}{" "}
              to {transaction.investingEntityKey.split(":")[1]}
            </span>
          ))}
        </div>
      }
      actions={null}
      relatedNumbers={{
        attachments: null,
        notes: event.notes?.length ?? 0,
        coinvestors: null,
      }}
      expandedContent={
        <div className="flex flex-col items-stretch gap-2">{notesSection}</div>
      }
    />
  ) : event.type === "MARKDOWN" ? (
    <>
      <ConfirmDelete
        disclosure={deleteDisclosure}
        message="This action cannot be undone. This will permanently delete this markdown."
        onConfirm={async () => {
          await removeMarkdown({ id: event.id });
          utils.views.portfolio.company.invalidate();
          deleteDisclosure.onClose();
        }}
      />
      <HistoryItemBox
        key={event.id}
        colourHue={10}
        title={{
          icon: <TrendingDown />,
          title: `Markdown${data?.percentage ? ` - ${data.percentage.toFixed(2)}%` : ""}`,
        }}
        actions={
          <HistoryMoreButton
            menuItems={[
              {
                label: "Delete",
                icon: <Trash2 />,
                onClick: () => {
                  deleteDisclosure.onOpen();
                },
              },
            ]}
          />
        }
        relatedNumbers={{
          attachments: null,
          notes: event.notes?.length ?? 0,
          coinvestors: null,
        }}
        expandedContent={
          <div className="flex flex-col items-stretch gap-2">{notesSection}</div>
        }
      />
    </>
  ) : event.type === "SECONDARY_SALE" ? (
    <HistoryItemBox
      key={event.id}
      title={{
        icon: <ArrowRightLeft />,
        title: "Secondary Sale",
      }}
      colourHue={100}
      infoLine={
        <span className="text-[13px] text-gray-400">
          {event.transactions
            .map((t) =>
              t.outflows
                .map(
                  (i) =>
                    `${formatMoney(i.numAssets, { isAbbrFormat: true, maximumFractionDigits: 0 /* we're expecting this to be integer equity */ })} ${i.assetName}`,
                )
                .join(", "),
            )
            .join(", ")}{" "}
          for{" "}
          {event.transactions
            .map((t) =>
              t.inflows
                .map(
                  (i) =>
                    `${formatMoney(i.numAssets, { isAbbrFormat: true, currency: i.assetName as CurrencyIsoCode })}`,
                )
                .join(", "),
            )
            .join(", ")}
        </span>
      }
      actions={null}
      relatedNumbers={{
        attachments: null,
        notes: event.notes?.length ?? 0,
        coinvestors: null,
      }}
      expandedContent={
        <div className="flex flex-col items-stretch gap-2">{notesSection}</div>
      }
    />
  ) : event.type === "SHARE_SPLIT" ? (
    <HistoryItemBox
      key={event.id}
      title={{
        icon: <Split />,
        title: "Share Split",
      }}
      infoLine={
        <span className="text-[13px] text-gray-400">
          {data?.multiple ?? "-"}x
        </span>
      }
      actions={null}
      relatedNumbers={{
        attachments: null,
        notes: event.notes?.length ?? 0,
        coinvestors: null,
      }}
      expandedContent={
        <div className="flex flex-col items-stretch gap-2">{notesSection}</div>
      }
    />
  ) : event.type === "LIQUIDATION" ? (
    <HistoryItemBox
      key={event.id}
      title={{
        icon: <Skull />,
        title: "Wind Down",
      }}
      infoLine={
        event.transactions.length > 0 ? (
          <div className="flex flex-col items-stretch gap-1 text-[13px] text-gray-400">
            {event.transactions.flatMap((transaction) => (
              <span key={transaction.transactionId}>
                Received:{" "}
                {transaction.inflows
                  .map((inflow) =>
                    inflow.assetType === "CURRENCY"
                      ? `${formatMoney(inflow.numAssets, { isAbbrFormat: true, currency: inflow.assetName as CurrencyIsoCode })} cash`
                      : `${formatMoney(inflow.numAssets, { isAbbrFormat: true, maximumFractionDigits: 0 })} ${inflow.assetName} (${AssetTypeMap[inflow.assetType as AssetType]})`,
                  )
                  .join(", ")}{" "}
                → {transaction.investingEntityKey.split(":")[1]}
              </span>
            ))}
          </div>
        ) : undefined
      }
      actions={null}
      relatedNumbers={{
        attachments: null,
        notes: event.notes?.length ?? 0,
        coinvestors: null,
      }}
      expandedContent={
        <div className="flex flex-col items-stretch gap-2">{notesSection}</div>
      }
    />
  ) : (
    <HistoryItemBox
      key={event.id}
      title={{
        icon: <HelpCircle />,
        title: event.type,
      }}
      actions={null}
      relatedNumbers={{
        attachments: null,
        notes: event.notes?.length ?? 0,
        coinvestors: null,
      }}
      expandedContent={
        <div className="flex flex-col items-stretch gap-2">{notesSection}</div>
      }
    />
  );
}

function ConfirmDelete({
  disclosure,
  message,
  onConfirm,
}: {
  disclosure: { isOpen: boolean; onClose: () => void };
  message: string;
  onConfirm: () => Promise<void>;
}) {
  return (
    <FormModal
      isOpen={disclosure.isOpen}
      onClose={disclosure.onClose}
      title="Are you sure?"
      footer={
        <div className="flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={disclosure.onClose}
            className={buttonClass({ variant: "ghost" })}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void onConfirm()}
            className={buttonClass({ variant: "danger" })}
          >
            Delete
          </button>
        </div>
      }
    >
      <p className="text-[13px] text-gray-600">{message}</p>
    </FormModal>
  );
}

function InvestorDisplay({
  eventId,
  investor,
}: {
  eventId: string;
  investor: Exclude<Event["investors"], null>[number];
}) {
  const disclosure = useDisclosure();
  const { mutateAsync: removeInvestor } =
    trpc.views.portfolio.company.removeInvestorFromEvent.useMutation();
  const utils = trpc.useUtils();

  return (
    <div
      key={investor.id}
      className="group/investor flex h-9 items-center overflow-hidden px-3 hover:bg-gray-50"
    >
      <ConfirmDelete
        disclosure={disclosure}
        message={`This action cannot be undone. This will remove ${investor.name} from this round.`}
        onConfirm={async () => {
          await removeInvestor({ eventId, investorId: investor.id });
          utils.views.portfolio.company.invalidate();
          disclosure.onClose();
        }}
      />
      <Link
        href={`/portfolio/c/${investor.slug}`}
        className="inline-block w-full truncate text-[13px] font-medium leading-9 text-gray-600"
      >
        {investor.name}
      </Link>
      <button
        type="button"
        aria-label={`Remove ${investor.name}`}
        onClick={() => {
          disclosure.onOpen();
        }}
        className="hidden h-6 shrink-0 items-center rounded-md bg-white px-2 text-red-500 group-hover/investor:inline-flex"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
}

function AddShareSplit({
  companyId,
  disclosure,
}: {
  companyId: string;
  disclosure: { isOpen: boolean; onClose: () => void };
}) {
  const { mutateAsync: addShareSplit, isLoading } =
    trpc.views.portfolio.company.addShareSplit.useMutation();
  const utils = trpc.useUtils();

  return (
    <Formik<{ multiple: string; date: string }>
      enableReinitialize
      initialValues={{
        multiple: "",
        date: "",
      }}
      onSubmit={async (values) => {
        await addShareSplit({
          companyId,
          multiple: Number(values.multiple),
          date: values.date,
        });
        utils.views.portfolio.company.invalidate();
        disclosure.onClose();
      }}
    >
      {({ setFieldValue, setFieldTouched, values, handleSubmit, isSubmitting }) => (
        <FormModal
          isOpen={disclosure.isOpen}
          onClose={disclosure.onClose}
          title="Add Share Split"
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
              label="Multiple"
              icon={<X className="h-4 w-4 text-gray-400" />}
            >
              <div className="flex items-stretch">
                <span className="flex shrink-0 items-center rounded-l-md border border-r-0 border-gray-200 bg-gray-50 px-3 text-[13px] text-gray-500">
                  1 to
                </span>
                <TextInput
                  className="rounded-l-none"
                  value={values.multiple}
                  onChange={(e) => {
                    const value = e.target.value;
                    const numericValue = value
                      .replace(/[^\d.]/g, "")
                      .replace(/(\..*)\./g, "$1");
                    setFieldValue("multiple", numericValue);
                    setFieldTouched("multiple", true);
                  }}
                  placeholder="e.g. 1000"
                  type="text"
                  pattern="[0-9\s.]*"
                />
              </div>
            </Field>
            <Field
              label="Date"
              icon={<Calendar className="h-4 w-4 text-gray-400" />}
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

// TODO: finish this. Determined to be too much complexity / value to work on now.
function AddAcquisitionProceeds({
  companyId,
  eventId,
  disclosure,
}: {
  companyId: string;
  eventId: string;
  disclosure: { isOpen: boolean; onClose: () => void };
}) {
  const utils = trpc.useUtils();
  const { mutateAsync: addCashflowsToTransaction, isLoading } =
    trpc.views.portfolio.company.addCashflowsToTransaction.useMutation();
  const { data: transactions, isLoading: isLoadingTransactions } =
    trpc.views.portfolio.company.getAcquisitionTransactions.useQuery({
      id: eventId,
    });

  return (
    <Formik<{
      newTransfers: {
        transactionId: string;
        amount: number;
        currency: CurrencyIsoCode;
        date: string;
      }[];
    }>
      enableReinitialize
      initialValues={{
        newTransfers: [],
      }}
      onSubmit={async (values) => {
        for (const transfer of values.newTransfers) {
          await addCashflowsToTransaction({
            id: eventId,
            recipientId: companyId,
            sourceId: companyId,
            cashflow: {
              date: transfer.date,
              currency: transfer.currency,
              amount: Number(transfer.amount),
            },
          });
        }
        utils.views.portfolio.company.invalidate();
        disclosure.onClose();
      }}
    >
      {({ setFieldValue, values, handleSubmit, isSubmitting }) => (
        <FormModal
          isOpen={disclosure.isOpen}
          onClose={disclosure.onClose}
          title="Add Proceeds"
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
          {isLoadingTransactions ? (
            <div className="flex justify-center py-8 text-[13px] text-gray-400">
              Loading…
            </div>
          ) : (
            <div className="flex flex-col items-stretch gap-5">
              {transactions?.map((transaction) => (
                <div
                  key={transaction.id}
                  className="relative flex w-full items-center justify-between gap-4 overflow-hidden rounded-md bg-gray-50 p-4"
                >
                  <div className="flex max-w-full grow flex-col items-stretch gap-5">
                    <span className="font-medium text-black">
                      {transaction.investorName}
                    </span>
                    <div className="flex flex-col items-stretch gap-3">
                      <div className="flex items-center justify-between">
                        <span className="inline-flex items-center gap-2 font-medium text-black">
                          <ArrowDown className="h-4 w-4 rotate-90" />
                          Received
                        </span>
                        <button
                          type="button"
                          aria-label="Add received asset"
                          className={buttonClass({
                            variant: "secondary",
                            size: "sm",
                          })}
                          onClick={() => {
                            const items = [...(values.newTransfers || [])];
                            items.push({
                              transactionId: transaction.id,
                              amount: undefined as unknown as number,
                              currency: "USD" as CurrencyIsoCode,
                              date: new Date().toISOString().split("T")[0],
                            });
                            setFieldValue("newTransfers", items);
                          }}
                        >
                          <Plus className="h-3 w-3" />
                          Cash
                        </button>
                      </div>
                      {transaction.transfers_in?.map((asset, assetIdx) => (
                        <AssetLine key={assetIdx} asset={asset} />
                      )) ?? null}
                    </div>
                    <div className="flex flex-col items-stretch gap-3">
                      <div className="flex items-center justify-between">
                        <span className="inline-flex items-center gap-2 font-medium text-black">
                          <ArrowDown className="h-4 w-4 -rotate-90" />
                          In exchange for
                        </span>
                      </div>
                      {transaction.transfers_out?.map((asset, assetIdx) => (
                        <AssetLine key={assetIdx} asset={asset} />
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </FormModal>
      )}
    </Formik>
  );
}

type AcquisitionTransfer = NonNullable<
  RouterOutputs["views"]["portfolio"]["company"]["getAcquisitionTransactions"][number]["transfers_in"]
>[number];

function AssetLine({ asset }: { asset: AcquisitionTransfer }) {
  return (
    <div className="flex flex-col items-stretch gap-1 text-[13px]">
      <span>{asset.currency ? "Cash" : "Equity"}</span>
      <div className="flex w-full flex-wrap items-center gap-2">
        {asset.currency ? (
          <div className="flex items-center gap-2">
            <span>{asset.currency}</span>
            <span>{asset.numAssets}</span>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span>{asset.numAssets}</span>
            <span>{asset.assetName}</span>
          </div>
        )}
        <span>on</span>
        <span>{formatDate(new Date(asset.date), "yyyy-MM-dd")}</span>
      </div>
    </div>
  );
}

export { EventItem, AddShareSplit };
