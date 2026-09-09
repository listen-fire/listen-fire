export type FixedExploreTagType = "geo" | "investor_type" | "stage" | "misc";
export type FixedExploreTagSubtype = "region" | "country";
type FixedExploreTag = {
  type: FixedExploreTagType;
  subtype?: FixedExploreTagSubtype;
  name: string;
};
const FIXED_EXPLORE_DESCRIPTORS: Array<FixedExploreTag> = [
  {
    name: "Europe",
    type: "geo",
    subtype: "region",
  },
  {
    name: "USA",
    type: "geo",
    subtype: "region",
  },
  {
    name: "Canada",
    type: "geo",
    subtype: "region",
  },
  {
    name: "Middle East",
    type: "geo",
    subtype: "region",
  },
  {
    name: "LATAM",
    type: "geo",
    subtype: "region",
  },
  {
    name: "Africa",
    type: "geo",
    subtype: "region",
  },
  {
    name: "Asia Pacific",
    type: "geo",
    subtype: "region",
  },
  {
    name: "Berlin",
    type: "geo",
    subtype: "country",
  },
  {
    name: "UK",
    type: "geo",
    subtype: "country",
  },
  {
    name: "Baltics",
    type: "geo",
    subtype: "region",
  },
  {
    name: "Estonia",
    type: "geo",
    subtype: "country",
  },
  {
    name: "Angel",
    type: "investor_type",
  },
  {
    name: "Emerging VC",
    type: "investor_type",
  },
  {
    name: "Established VC",
    type: "investor_type",
  },
  {
    name: "Micro VC",
    type: "investor_type",
  },
  {
    name: "Accelerator",
    type: "investor_type",
  },
  {
    name: "Corporate VC",
    type: "investor_type",
  },
  {
    name: "Family Office",
    type: "investor_type",
  },
  {
    name: "Early Stage",
    type: "stage",
  },
  {
    name: "Late Stage",
    type: "stage",
  },
  {
    name: "Growth",
    type: "stage",
  },
  {
    name: "Deep tech",
    type: "misc",
  },
  {
    name: "SaaS",
    type: "misc",
  },
  {
    name: "PLG",
    type: "misc",
  },
  {
    name: "AI",
    type: "misc",
  },
  {
    name: "FinTech",
    type: "misc",
  },
  {
    name: "Generalist",
    type: "misc",
  },
  {
    name: "Founder",
    type: "misc",
  },
  {
    name: "Operator",
    type: "misc",
  },
  {
    name: "Designer",
    type: "misc",
  },
  {
    name: "Exited Founder",
    type: "misc",
  },
  {
    name: "Product",
    type: "misc",
  },
  {
    name: "Lead",
    type: "misc",
  },
  {
    name: "Non-lead",
    type: "misc",
  },
];

export { FIXED_EXPLORE_DESCRIPTORS };
