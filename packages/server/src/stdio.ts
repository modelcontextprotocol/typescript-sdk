/**
 * Node.js Stdio Server Transport
 *
 * This entry point is separated from the main package to avoid pulling in
 * Node.js-specific APIs (process.stdin, process.stdout) for non-Node.js runtimes.
 *
 * Usage:
 *   import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
 */
export * from './server/stdio.js';
