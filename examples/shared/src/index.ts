// Argv-parse + assert scaffold (NO SDK calls — those go inline in each story).
// This barrel is intentionally args-only so that the ~25 non-auth stories do
// not eagerly evaluate better-auth/express/cors/better-sqlite3 just by
// importing `parseExampleArgs`. The OAuth scaffolding lives at the `./auth`
// subpath — see `./indexAuth.ts`.
export type { ExampleArgs, ExampleEra, ExampleTransport } from './args.js';
export { check, parseExampleArgs, siblingPath } from './args.js';
