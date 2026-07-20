// Root entry for `@modelcontextprotocol/sdk`.
//
// package.json exposes this file via the `.` export. Without a source file
// here, tsc emits nothing for the advertised dist/{esm,cjs}/index.{js,d.ts}
// paths and the root import of the published package fails to resolve
// (issue #2273).
//
// Re-export the shared protocol schemas/types and the in-memory transport.
// `Client` and `Server` intentionally stay on their `./client` and `./server`
// subpath exports: re-exporting both here would collide on identically named
// symbols (TS2308).
export * from './types.js';
export * from './inMemory.js';
