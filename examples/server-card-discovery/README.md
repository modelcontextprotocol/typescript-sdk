# server-card-discovery

Experimental Server Card extension (SEP-2127) end to end. The server exposes an
MCP endpoint plus its Server Card at `/mcp/server-card` and an AI Catalog at
`/.well-known/ai-catalog.json`. The client is told only the domain: it probes
the well-known catalog with `discoverServerCards`, validates the card, resolves
the remote with `resolveRemote`, connects, calls a tool, and reconciles the
card's claims against the live `serverInfo` with `reconcileServerCard`.

HTTP only — cards describe remote servers.

```bash
pnpm --filter @mcp-examples/server-card-discovery server -- --http --port 3000
pnpm --filter @mcp-examples/server-card-discovery client -- --http http://127.0.0.1:3000/mcp
```

See `docs/advanced/server-cards.md` for the guide.
