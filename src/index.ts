/**
 * Root entry point for `@modelcontextprotocol/sdk`.
 *
 * `package.json` maps the root `.` export to `dist/{esm,cjs}/index.{js,d.ts}`,
 * but there was no `src/index.ts`, so `tsc` never emitted those files and they
 * were absent from the published tarball. Importing the package root therefore
 * failed with `ERR_MODULE_NOT_FOUND` before any consumer code ran (#2273).
 *
 * Re-export the shared protocol surface (types, schemas, constants) and the
 * in-memory transport. `Client` and `Server` intentionally stay on their
 * `./client` / `./server` subpath exports to avoid TS2308 ambiguous re-export
 * collisions at the root.
 */

export * from './types.js';
export * from './inMemory.js';
