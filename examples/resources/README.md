# resources

Direct resources (a fixed URI string) and templated resources (`ResourceTemplate('greeting://{name}')`). The client lists both, reads the direct config, and reads a templated greeting.

```bash
pnpm tsx examples/resources/client.ts
```
