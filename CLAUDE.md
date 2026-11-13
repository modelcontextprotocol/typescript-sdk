# CLAUDE.md

The principles this SDK is built and reviewed by. They are not a checklist: apply them with judgement.

1. **Minimalism** — The SDK should do less, not more: prefer changes that add no API or option unless justified.
2. **Spec is the anchor** — The spec decides; where it leaves a choice open, check what the other official SDKs do before making your own choice.
3. **Strict by default** — Accept what the spec allows, and add no leniency for peers that break it.
4. **Backwards compatible** — New features and changes arrive in backwards compatible ways; when a bug, a spec violation or an unsafe default forces a break, the changeset says what breaks.
5. **Small changes** — Guard scope hard: a smaller change that lands beats a bigger one that doesn't, and small, independent pull requests can land in any order.
6. **The words are true** — Changesets, docs and comments say what the code does.
7. **Test what users see** — Prefer tests that cover the end-to-end usage a user would actually see, where sensible; `test/e2e/requirements.ts` lists those behaviours.
8. **Brief comments** — Keep inline comments to one line and JSDoc to the public API; the reasoning goes in the commit message or PR description.

Style belongs to Prettier, ESLint and the compiler.
