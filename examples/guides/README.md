# guides

Per-page snippet companions for the `docs/` guide pages: each `<dir>/<page>.examples.ts` is the type-checked source for the code fences in `docs/<dir>/<page>.md` or, for a page assembled from an agent skill, in that skill's files under `skills/`, synced via `pnpm sync:snippets`. Companions that quote output are also run as real programs by `pnpm docs:examples`; the rest opt out with a `// docs: typecheck-only` first line.
