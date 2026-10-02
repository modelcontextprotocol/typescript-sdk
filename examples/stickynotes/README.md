# stickynotes

The "real app" capstone: a sticky-notes board where tools mutate state, each note is a resource, the resource list changes on add/remove, and a destructive `remove_all` blocks on a form-mode elicitation. The client adds, lists, reads, removes, and proves `remove_all` only clears
the board on an explicit confirm.

Runs all four transport/era legs. The `remove_all` confirmation is a push server→client elicitation (2025-era only — there is no server→client request channel on 2026-07-28; the equivalent is multi-round-trip `inputRequired`, see `../elicitation/`). The cancel / unchecked /
confirm flow is exercised on **stdio/legacy only** — `server.ts` hosts HTTP via a plain stateless `createMcpHandler`, whose per-request legacy fallback has no return path for the client's elicitation response — so the modern and http legs exercise add / list / read / remove and
skip `remove_all`.
