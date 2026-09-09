export const connectionsFilterTypes = [
  "SHARING_WITH_ME",
  "SHARING_WITH_THEM",
  "MUTUAL",
] as const;

export type ConnectionsFilterType = (typeof connectionsFilterTypes)[number];
