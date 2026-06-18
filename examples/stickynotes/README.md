# stickynotes

The "real app" capstone: a sticky-notes board where tools mutate state, each note is a resource, the resource list changes on add/remove, and a destructive `remove_all` blocks on a form-mode elicitation. The client adds, lists, reads, removes, and proves `remove_all` only clears
the board on an explicit confirm.

**stdio-only** in the harness: the `remove_all` confirmation is a push server→client elicitation, which needs either a stdio connection or a sessionful HTTP transport (see `../legacy-routing/`).

```bash
pnpm tsx examples/stickynotes/client.ts
```
