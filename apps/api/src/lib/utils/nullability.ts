function notNull<TValue>(value: TValue | null): value is TValue {
  return value !== null;
}

function notUndefined<TValue>(value: TValue | undefined): value is TValue {
  return value !== undefined;
}

export { notNull, notUndefined };
