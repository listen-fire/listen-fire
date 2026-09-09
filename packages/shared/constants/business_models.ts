const BUSINESS_MODELS = [
  "Pre-revenue",
  "SaaS",
  "PaaS",
  "IaaS",
  "Marketplace",
  "Transactional",
  "Subscription",
  "Freemium",
  "Advertising",
  "D2C",
  "Lead gen / Affiliate Marketing",
  "Donations",
  "Licensing",
  "Crowdsourcing",
  "Franchise",
  "Wholesale",
  "White Label",
  "Capital Expenditure",
  "Unknown",
] as const;

export type BusinessModel = (typeof BUSINESS_MODELS)[number];

export { BUSINESS_MODELS };
