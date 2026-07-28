# guides

Per-page snippet companions for the `docs/` guide pages: each `<dir>/<page>.examples.ts` is the type-checked source for the code fences in `docs/<dir>/<page>.md`, synced via `pnpm sync:snippets`. Companions that quote output are also run as real programs by `pnpm docs:examples`; the rest opt out with a `// docs: typecheck-only` first line.
