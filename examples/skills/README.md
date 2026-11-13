# skills

The server serves the `skills/` folder as MCP skills (SEP-2640) with one
`loadSkills` call, under the `examples` prefix. The client lists the catalog,
loads `git-workflow` (its `SKILL.md`, verified for size, digest and
frontmatter), follows the reference to `references/REVIEW.md`, browses the
`refunds` folder, and catches a verification failure.

```bash
pnpm --filter @mcp-examples/skills client            # modern leg over stdio
pnpm --filter @mcp-examples/skills client -- --legacy
pnpm --filter @mcp-examples/skills run server -- --http --port 3000
pnpm --filter @mcp-examples/skills client -- --http http://127.0.0.1:3000/mcp
```

See [Serving skills](../../docs/servers/skills.md) and [Reading skills](../../docs/clients/skills.md).
