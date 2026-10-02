# prompts

Register prompts with `McpServer.registerPrompt`; wrap argument schemas with `completable(...)` for autocompletion. The client lists prompts, completes the `language` argument, and renders one with `getPrompt()`.

```bash
pnpm tsx examples/prompts/client.ts
```
