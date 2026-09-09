// The payload shapes the deal / investor-update email formatters build.
// What consumed them (the outbound messager + plugin interfaces) died with the
// dealflow pipeline; the shapes outlive it because the portfolio surface still
// renders these summaries.

type OutboundDeal = {
  amount: string | null;
  round_name: string | null;
  lead_by: string | null;
  deal_url: string | null;
  description: string | null;
  founders: {
    fullname: string;
    role: string | null;
    linkedin: string | null;
  }[];
  company: {
    name: string;
    website: string | null;
    location: string | null;
  };
};

type OutboundInvestorUpdate = {
  appUrl?: string | null;
  companyName: string;
  teaserSummary: string | null;
  summary: string;
  date: string;
  companyUrl?: string | null;
  country: string | null;
  firstInvestedAt: string | null;
  investedAmount: number | null;
  retainedValue: number | null;
  currency: string;
  metrics: {
    annualisedRevenue: {
      currency: string;
      value: number;
      type: 'Reported Gross' | 'Reported Net' | 'Estimated Gross' | 'Estimated Net' | null;
    } | null;
    monthlyCashBurn: {
      currency: string;
      value: number;
      type: 'Assumed Gross' | 'Reported Gross' | 'Assumed Net' | 'Reported Net' | null;
    } | null;
    cashInBank: {
      currency: string;
      value: number;
    } | null;
    runway: {
      value: number;
      unit: 'Month' | 'Year';
      type: 'Reported' | 'Estimated' | null;
    } | null;
    teamSize: number;
    fundraisingStatus: 'Actively Fundraising' | 'Not Fundraising' | 'Fundraising Soon' | null;
  } | null;
  highlights: string[];
  asks: string[];
};

export { OutboundDeal, OutboundInvestorUpdate };
