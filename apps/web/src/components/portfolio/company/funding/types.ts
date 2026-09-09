import type { RouterOutputs } from "@/lib/trpc";

type EventHistory =
  RouterOutputs["views"]["portfolio"]["company"]["getEventHistory"];

type Transaction = EventHistory["transactions"][number];
type Price = EventHistory["prices"][number];
type Investment = EventHistory["investments"][number];
type ConvertibleAssetDetails = EventHistory["convertibleAssets"][string];

export type { Transaction, Price, Investment, ConvertibleAssetDetails };
