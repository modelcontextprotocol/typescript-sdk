// docs: typecheck-only
/**
 * Companion example for the stdio entry on `docs/troubleshooting.md`.
 *
 * This file is separate from `troubleshooting.examples.ts` because
 * `serveStdio` binds stdin: importing it into the runnable companion would
 * keep that program from terminating. Verified by
 * `pnpm --filter @modelcontextprotocol/examples typecheck` and
 * `pnpm sync:snippets --check`; never executed.
 *
 * @module
 */
/* eslint-disable no-console */
//#region serveStdio_stderr
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

serveStdio(() => {
    const server = new McpServer({ name: 'app', version: '1.0.0' });
    console.error('app server running on stdio'); // stderr — never console.log
    return server;
});
//#endregion serveStdio_stderr
