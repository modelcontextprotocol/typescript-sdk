# repl (excluded)

The interactive playground. A fully-featured HTTP server (tools with input/output schemas + annotations, prompts with completion, direct + templated resources, `notifications/message` logging, `resources/list_changed` published via `handler.notify`) paired with a readline REPL
client that can drive every primitive by hand — `list-tools`, `call-tool`, `list-prompts`, `get-prompt`, `list-resources`, `read-resource`, form elicitation, resumable notification streams.

Excluded from the harness (`package.json#example.excluded`); run manually:

```sh
pnpm run server          # terminal 1 — listens on http://localhost:3000/mcp
pnpm run client          # terminal 2 — readline REPL
```

Try `multi-greet Ada`, `collect-info contact`, `call-tool add-resource {"name":"n1","text":"hello"}` then `list-resources`, or `start-notifications 500 5`.
