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

- `src/everythingClient.ts` - Client that handles all client conformance scenarios
- `src/everythingServer.ts` - Server that implements all server conformance features
- `src/authTestServer.ts` - Server with OAuth authentication for auth conformance tests
- `src/helpers/` - Shared utilities for conformance tests
- `scripts/` - Conformance test runner scripts

## Auth Test Server

The `authTestServer.ts` is designed for testing server-side OAuth implementation. It requires an authorization server URL and validates tokens via introspection.

```bash
# Start with a fake auth server
MCP_CONFORMANCE_AUTH_SERVER_URL=http://localhost:3000 \
  npx tsx src/authTestServer.ts
```

The server:

- Requires Bearer token authentication on all MCP endpoints
- Validates tokens via the AS's introspection endpoint (RFC 7662)
- Serves Protected Resource Metadata at `/.well-known/oauth-protected-resource`
