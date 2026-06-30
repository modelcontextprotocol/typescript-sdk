/**
 * Companion example for `docs/advanced/wire-schemas.md`.
 *
 * Every `ts` fence on that page is synced from a `//#region` in this file
 * (`pnpm sync:snippets --check`). The file also runs: it is the gateway path
 * the page walks through — raw JSON in, validated with the schemas from
 * `@modelcontextprotocol/core`, no `Client` or `Server` anywhere — and it
 * prints the exact output the page quotes verbatim.
 *
 *     pnpm --filter @modelcontextprotocol/examples typecheck
 *     npx tsx guides/advanced/wire-schemas.examples.ts   # from examples/
 *
 * @module
 */
/* eslint-disable @typescript-eslint/no-unused-vars, no-console */

// "Validate a wire payload" — the happy path the page quotes.
//#region wireSchemas_validateResult
import { CallToolResultSchema } from '@modelcontextprotocol/core';

// The body an upstream server returned for a tools/call you forwarded.
const body: unknown = JSON.parse('{"content":[{"type":"text","text":"Travel mug"}]}');

const parsed = CallToolResultSchema.safeParse(body);
if (!parsed.success) {
    throw new Error(`upstream returned an invalid tools/call result: ${parsed.error.message}`);
}
console.log(parsed.data.content);
//#endregion wireSchemas_validateResult

// "Validate a wire payload" — the rejection the page quotes.
//#region wireSchemas_validateResult_invalid
const malformed = CallToolResultSchema.safeParse({ content: 'Travel mug' });
console.log(malformed.error?.issues);
//#endregion wireSchemas_validateResult_invalid

// "Pick the schema for the message you hold" — the undecoded envelope.
//#region wireSchemas_envelope
import { JSONRPCMessageSchema } from '@modelcontextprotocol/core';

const frame = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"search","arguments":{"query":"mug"}}}';
const message = JSONRPCMessageSchema.parse(JSON.parse(frame));
//#endregion wireSchemas_envelope

// "Route raw JSON-RPC in a proxy" — branch on method, then the per-method schema.
//#region wireSchemas_route
import { CallToolRequestSchema } from '@modelcontextprotocol/core';

if ('method' in message) {
    switch (message.method) {
        case 'tools/call': {
            const call = CallToolRequestSchema.parse(message);
            console.log(`forward tools/call for ${call.params.name} upstream`);
            break;
        }
        default:
            console.log(`forward ${message.method} unchanged`);
    }
}
//#endregion wireSchemas_route

// "Validate OAuth and discovery metadata" — the second export group.
//#region wireSchemas_oauthMetadata
import { OAuthMetadataSchema } from '@modelcontextprotocol/core';

// In production this body comes from GET <issuer>/.well-known/oauth-authorization-server.
const response = new Response(
    JSON.stringify({
        issuer: 'https://auth.example.com',
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
        response_types_supported: ['code']
    })
);

const metadata = OAuthMetadataSchema.parse(await response.json());
console.log(metadata.token_endpoint);
//#endregion wireSchemas_oauthMetadata

// "Get the TypeScript types, guards and errors from the SDK packages" — core is
// Zod values only; the names live in /client and /server.
//#region wireSchemas_types
import type { CallToolResult } from '@modelcontextprotocol/client';
import * as z from 'zod/v4';

// The SDK's spec type and the schema's own inferred output describe the same value.
const relayed: CallToolResult = parsed.data;
type CallToolResultFromCore = z.infer<typeof CallToolResultSchema>;
//#endregion wireSchemas_types

// ---------------------------------------------------------------------------
// Self-checks (not shown on the page). Throw — non-zero exit — if any claim
// the page makes stops being true.
// ---------------------------------------------------------------------------

if (malformed.success) {
    throw new Error('wire-schemas.md claim failed: a non-array `content` must not parse');
}
if (!('method' in message) || message.method !== 'tools/call') {
    throw new Error('wire-schemas.md claim failed: the envelope did not narrow to a tools/call request');
}
if (relayed.content[0]?.type !== 'text') {
    throw new Error('wire-schemas.md claim failed: parsed result is not assignable to CallToolResult');
}
