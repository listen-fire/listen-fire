import type { RouterOutputs } from "@/lib/trpc";

type Company = RouterOutputs["views"]["portfolio"]["company"]["getOverview"];
type CompanyEvent =
  RouterOutputs["views"]["portfolio"]["company"]["getInvestorsSummary"]["rounds"][number];

export type { Company, CompanyEvent };
