function requireEnv<T extends string[]>(...names: T) {
  for (const name of names) {
    if (process.env[name] === undefined) {
      throw new Error(`The ${name} environment variable is required`);
    }
  }
  return process.env as typeof process.env & { [K in T[number]]: string };
}

/**
 * `because` names what the var is FOR — it is appended to the error, so a
 * deployment that is missing one learns what breaks rather than just which
 * string to google. Worth writing for anything a self-hosted deployment has
 * to supply itself.
 */
function getEnvVar(
  name: string,
  { devDefault, because }: { devDefault?: string; because?: string } = {},
) {
  let item = process.env[name];

  if (item === undefined && process.env.NODE_ENV !== 'production' && devDefault !== undefined) {
    item = devDefault;
  }

  if (item === undefined) {
    throw new Error(
      `The ${name} environment variable is required${because ? ` — ${because}` : ''}`,
    );
  }

  return item;
}

export { requireEnv, getEnvVar };
