require("dotenv").config({ path: require("path").resolve(__dirname, ".env") });

module.exports = {
  connection: {
    connectionString: process.env.DATABASE_URL,
  },
  outputPath: "./src/generated/kysely",
  preDeleteOutputFolder: true,
  preRenderHooks: [require("kanel-kysely").makeKyselyHook()],
  customTypeMap: {
    'pg_catalog.bytea': 'Buffer',
    'public.citext': 'string',
  },
};