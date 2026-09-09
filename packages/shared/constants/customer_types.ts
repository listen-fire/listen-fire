const CUSTOMER_TYPES = [
  "B2B",
  "Enterprise",
  "B2B2C",
  "SMB",
  "B2C",
  "Government",
  "Charity",
  "Non-profit",
  "Other",
  "Unknown",
] as const;

export type CustomerType = (typeof CUSTOMER_TYPES)[number];

export { CUSTOMER_TYPES };
