# @modelcontextprotocol/sdk-shared

Canonical public home for the [Model Context Protocol](https://modelcontextprotocol.io) specification **Zod schemas**.

These are the exact schema constants the SDK validates protocol payloads against internally. The `@modelcontextprotocol/server` and `@modelcontextprotocol/client` packages keep a Zod-free public surface, so this package exists as the supported place to import the raw schemas when
you need to validate or parse MCP messages yourself.

## Install

```sh
npm install @modelcontextprotocol/sdk-shared
```

## Usage

```ts
import { CallToolResultSchema } from '@modelcontextprotocol/sdk-shared';

// Throws on invalid input; returns the typed result on success.
const result = CallToolResultSchema.parse(payload);

// Or non-throwing:
const parsed = CallToolResultSchema.safeParse(payload);
if (parsed.success) {
    // parsed.data is a fully typed CallToolResult
}
```

## Scope

This package exports **only** the spec Zod schemas (`*Schema`). The corresponding TypeScript types, error classes, enums, and type guards are part of the public API of [`@modelcontextprotocol/server`](https://www.npmjs.com/package/@modelcontextprotocol/server) and
[`@modelcontextprotocol/client`](https://www.npmjs.com/package/@modelcontextprotocol/client).

> **Migrating from v1?** In v1 these schemas were imported from `@modelcontextprotocol/sdk/types.js`. Point those `*Schema` imports at `@modelcontextprotocol/sdk-shared` and your existing `.parse()` / `.safeParse()` calls keep working unchanged.
