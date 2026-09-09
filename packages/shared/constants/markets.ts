const MARKETS = [
  "Travel & Hospitality",
  "Food & Beverages",
  "Consumer Goods",
  "Crypto / Web3",
  "Future of Work",
  "Advertising & Marketing",
  "Media & Entertainment",
  "Gaming",
  "Space",
  "Deeptech",
  "Hardware & Robotics",
  "Infrastructure Software",
  "Healthcare",
  "Biotech",
  "Education",
  "Legal",
  "Finance & Insurance",
  "E-commerce & Retail",
  "Climate & Sustainability",
  "Energy",
  "Real Estate",
  "Security & Defence",
  "Agriculture",
  "Construction & Industrial",
  "Manufacturing",
  "Transportation & Logistics",
  "Unknown",
] as const;

export type Market = (typeof MARKETS)[number];

// TODO value satisfies type IconName from app/src/utils/icons
type MarketIcon = {
  [key in Market]: string;
};
const MARKET_ICONS: { [key: string]: string } = {
  "E-commerce & Retail": "shoppingCart",
  "Infrastructure Software": "sdk",
  Healthcare: "healthMetrics",
  Deeptech: "neurology",
  "Finance & Insurance": "payments",
  "Media & Entertainment": "liveTv",
  "Advertising & Marketing": "sell",
  "Climate & Sustainability": "eco",
  Biotech: "biotech",
  "Hardware & Robotics": "precisionManufacturing",
  "Crypto / Web3": "currencyBitcoin",
  "Consumer Goods": "package2",
  "Future of Work": "fastForward",
  "Transportation & Logistics": "localShipping",
  Education: "school",
  Gaming: "sportsEsports",
  Manufacturing: "factory",
  "Food & Beverages": "restaurant",
  Energy: "electricBolt",
  "Security & Defence": "lock",
  "Real Estate": "realEstateAgent",
  "Travel & Hospitality": "beachAccess",
  Space: "rocketLaunch",
  Legal: "gavel",
  Agriculture: "agriculture",
  "Construction & Industrial": "engineering",
  Unknown: "help",
} satisfies MarketIcon;

const PRIMARY_SECTORS = [
  { title: "🤖 AI / Data & ML", id: "AI / Data & ML" },
  { title: "🌍 Climate & Energy", id: "Climate & Energy" },
  { title: "💳 FinTech & Crypto", id: "FinTech & Crypto" },
  { title: "🧬 Healthcare & Bio", id: "Healthcare & Bio" },
  { title: "🛍️ Consumer & E-com", id: "Consumer & E-com" },
  { title: "🛠️ Future-of-Work / HR", id: "Future-of-Work / HR" },
  { title: "🎮 Media, Gaming & AdTech", id: "Media, Gaming & AdTech" },
  { title: "🏭 Industrial & Mfg", id: "Industrial & Mfg" },
  { title: "🛡️ Security & Infra", id: "Security & Infra" },
  { title: "🚀 Space & Deeptech", id: "Space & Deeptech" },
] as const;

const SUBCATEGORIES = {
  "AI / Data & ML": [],
  "Climate & Energy": [
    { title: "💨 Carbon", id: "Carbon" },
    { title: "🔋 Storage", id: "Storage" },
    { title: "☀️ Renewables", id: "Renewables" },
  ],
  "FinTech & Crypto": [
    { title: "🏦 FinTech", id: "FinTech" },
    { title: "🪙 Crypto", id: "Crypto" },
    { title: "📑 InsurTech", id: "InsurTech" },
  ],
  "Healthcare & Bio": [
    { title: "🏥 HealthTech", id: "HealthTech" },
    { title: "🧫 BioTech", id: "BioTech" },
    { title: "🩺 Digital Health", id: "Digital Health" },
  ],
  "Consumer & E-com": [
    { title: "✈️ Travel", id: "Travel" },
    { title: "🍔 Food", id: "Food" },
    { title: "🛒 Retail", id: "Retail" },
  ],
  "Future-of-Work / HR": [
    { title: "🧑‍💼 HRTech", id: "HRTech" },
    { title: "🎓 EdTech", id: "EdTech" },
    { title: "⚖️ LegalTech", id: "LegalTech" },
  ],
  "Media, Gaming & AdTech": [
    { title: "📺 Media", id: "Media" },
    { title: "🎮 Gaming", id: "Gaming" },
    { title: "📊 AdTech", id: "AdTech" },
  ],
  "Industrial & Mfg": [
    { title: "🤖 Robotics", id: "Robotics" },
    { title: "🏗️ Construction", id: "Construction" },
    { title: "⚙️ Manufacturing", id: "Manufacturing" },
  ],
  "Security & Infra": [
    { title: "🔐 CyberSec", id: "CyberSec" },
    { title: "🖥️ Dev & Infra", id: "Dev & Infra" },
    { title: "🛡️ Defence", id: "Defence" },
  ],
  "Space & Deeptech": [],
} as const;

export { MARKETS, MARKET_ICONS, PRIMARY_SECTORS, SUBCATEGORIES };
