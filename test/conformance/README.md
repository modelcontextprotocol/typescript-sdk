# Conformance Tests

This directory contains conformance test implementations for the TypeScript MCP SDK.

## Client Conformance Tests

Tests the SDK's client implementation against a conformance test server.

```bash
# Run all client tests
pnpm run test:conformance:client:all

# Run specific suite
pnpm run test:conformance:client -- --suite auth

# Run single scenario
pnpm run test:conformance:client -- --scenario auth/basic-cimd
```

## Server Conformance Tests

Tests the SDK's server implementation by running a conformance server.

```bash
# Run all active server tests
pnpm run test:conformance:server

# Run all server tests (including pending)
pnpm run test:conformance:server:all
```

## Local Development

### Running Tests Against Local Conformance Repo

Link the local conformance package:

```bash
cd ~/code/mcp/typescript-sdk
pnpm link ~/code/mcp/conformance
```

Then run tests as above.

### Debugging Server Tests

Start the server manually:

```bash
pnpm run test:conformance:server:run
```

In another terminal, run specific tests:

```bash
npx @modelcontextprotocol/conformance server \
  --url http://localhost:3000/mcp \
  --scenario server-initialize
```

## Files

- `everything-client.ts` - Client that handles all client conformance scenarios
- `everything-server.ts` - Server that implements all server conformance features
- `helpers/` - Shared utilities for conformance tests

Scripts are in `scripts/` at the repo root.
