# Middleware packages

The packages in `packages/middleware/*` are **thin integration layers** that help you expose an MCP server in a specific runtime, platform, or web framework.

They intentionally **do not** add new MCP features or “business logic”. MCP functionality (tools, resources, prompts, transports, auth primitives, etc.) lives in `@modelcontextprotocol/server` (and other core packages). Middleware packages should primarily:

- adapt request/response types to the SDK (e.g. Node.js `IncomingMessage`/`ServerResponse`)
- provide small framework helpers (e.g. wiring, body parsing hooks)
- supply safe defaults for common deployment pitfalls (e.g. localhost DNS rebinding protection)

## Packages

- `@modelcontextprotocol/express` — Express helpers (app defaults + Host header validation for DNS rebinding protection).
- `@modelcontextprotocol/hono` — Hono helpers (app defaults + JSON body parsing hook + Host header validation).
- `@modelcontextprotocol/node` — Node.js Streamable HTTP transport wrapper for `IncomingMessage`/`ServerResponse`.

## Typical usage

Most servers use:

- `@modelcontextprotocol/server` for the MCP server implementation
- one middleware package for framework/runtime integration (this folder)
- (optionally) additional platform/framework dependencies (Express, Hono, etc.)

