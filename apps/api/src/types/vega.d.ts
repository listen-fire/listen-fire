declare module 'vega' {
  export function parse(spec: unknown): unknown;
  export class View {
    constructor(runtime: unknown, options?: { renderer?: string });
    toCanvas(): Promise<unknown>;
    finalize(): void;
  }
}

declare module 'vega-lite' {
  export function compile(spec: unknown): { spec: unknown };
}
