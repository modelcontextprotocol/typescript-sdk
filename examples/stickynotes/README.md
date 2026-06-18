# stickynotes

The "real app" capstone: a sticky-notes board where tools mutate state, each note is a resource, the resource list changes on add/remove, and a destructive `remove_all` blocks on a form-mode elicitation. The client adds, lists, reads, removes, and proves `remove_all` only clears
the board on an explicit confirm.

The harness runs both transports on the **legacy** era. The `remove_all` confirmation is a push server→client elicitation, which needs a long-lived bidirectional connection (stdio, or a sessionful HTTP transport — see `../legacy-routing/`); the http leg exercises the
add/list/read/remove path and skips the elicitation-confirmed clear.
