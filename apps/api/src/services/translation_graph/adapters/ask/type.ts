// The ask adapter's stable identifier, in a leaf module so both `index.ts` and
// `await_store.ts` can import it without a cycle (the same idiom slack/types.ts
// follows). Matches `MutationContext.source.adapterType`.
export const ASK_ADAPTER_TYPE = 'ask';
