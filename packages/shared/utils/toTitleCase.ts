function toTitleCase(words: string): string {
  /* Transforms to Title Case
    For example:
      - snake_case -> Snake Case
      - WhatEVER word -> Whatever Word
    */
  return words.replaceAll("_", " ").replace(/\w\S*/g, (word) => {
    return word.charAt(0).toUpperCase() + word.substring(1).toLowerCase();
  });
}

function customJoin(
  a: string[],
  options: { sep?: string; finalSep?: string } = {
    sep: undefined,
    finalSep: undefined,
  },
) {
  const { sep, finalSep } = options;
  if (finalSep && a.length > 1) {
    return (
      a.slice(0, a.length - 2).join(sep) + finalSep + a.slice(a.length - 1)
    );
  }
  return a.join(sep);
}

export { toTitleCase, customJoin };
