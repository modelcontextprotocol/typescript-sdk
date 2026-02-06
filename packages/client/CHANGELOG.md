# @modelcontextprotocol/client

## 2.0.0

### Patch Changes

- [#1343](https://github.com/modelcontextprotocol/typescript-sdk/pull/1343) [`4b5fdcb`](https://github.com/modelcontextprotocol/typescript-sdk/commit/4b5fdcba02c20f26d8b0f07acc87248288522842) Thanks [@christso](https://github.com/christso)! - Fix OAuth error handling for servers
  returning errors with HTTP 200 status

    Some OAuth servers (e.g., GitHub) return error responses with HTTP 200 status instead of 4xx. The SDK now checks for an `error` field in the JSON response before attempting to parse it as tokens, providing users with meaningful error messages.

- [#1386](https://github.com/modelcontextprotocol/typescript-sdk/pull/1386) [`00249ce`](https://github.com/modelcontextprotocol/typescript-sdk/commit/00249ce86dac558fb1089aea46d4d6d14e9a56c6) Thanks [@PederHP](https://github.com/PederHP)! - Respect capability negotiation in list
  methods by returning empty lists when server lacks capability

    The Client now returns empty lists instead of sending requests to servers that don't advertise the corresponding capability:
    - `listPrompts()` returns `{ prompts: [] }` if server lacks prompts capability
    - `listResources()` returns `{ resources: [] }` if server lacks resources capability
    - `listResourceTemplates()` returns `{ resourceTemplates: [] }` if server lacks resources capability
    - `listTools()` returns `{ tools: [] }` if server lacks tools capability

    This respects the MCP spec requirement that "Both parties SHOULD respect capability negotiation" and avoids unnecessary server warnings and traffic. The existing `enforceStrictCapabilities` option continues to throw errors when set to `true`.

- [#1279](https://github.com/modelcontextprotocol/typescript-sdk/pull/1279) [`71ae3ac`](https://github.com/modelcontextprotocol/typescript-sdk/commit/71ae3acee0203a1023817e3bffcd172d0966d2ac) Thanks [@KKonstantinov](https://github.com/KKonstantinov)! - Initial 2.0.0-alpha.0
  client and server package
