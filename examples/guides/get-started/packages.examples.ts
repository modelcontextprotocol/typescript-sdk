// docs: typecheck-only
/**
 * Type-checked companion for `docs-v2/get-started/packages.md`.
 *
 * Each `//#region` block is synced byte-for-byte into that page's `ts` fences by
 * `pnpm sync:snippets` (`pnpm sync:snippets --check` reports drift). The page is
 * an explanation of the published packages and their subpath exports, so the
 * regions are import shapes — nothing meaningful to run.
 *
 *     pnpm --filter @modelcontextprotocol/examples typecheck
 *
 * @module
 */
/* eslint-disable @typescript-eslint/no-unused-vars */

// "Start from one package" — the two import paths the first-server tutorial used.
//#region packages_serverEntryPoints
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
//#endregion packages_serverEntryPoints

// "Keep Node-only code behind the ./stdio subpath" — the client-side pair.
//#region packages_clientStdioSubpath
// Runs anywhere: browsers, Workers, Node.
import { Client } from '@modelcontextprotocol/client';
// Spawns a child process — Node-only, so it lives behind the subpath.
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
//#endregion packages_clientStdioSubpath
