# Simple Task Interactive Example

This example demonstrates the MCP Tasks message queue pattern with interactive server-to-client requests (elicitation and sampling).

## Overview

The example consists of two components:

1. **Server** (`simpleTaskInteractive.ts`) - Exposes two task-based tools that require client interaction:
    - `confirm_delete` - Uses elicitation to ask the user for confirmation before "deleting" a file
    - `write_haiku` - Uses sampling to request an LLM to generate a haiku on a topic

2. **Client** (`simpleTaskInteractiveClient.ts`) - Connects to the server and handles:
    - Elicitation requests with simple y/n terminal prompts
    - Sampling requests with a mock haiku generator

## Key Concepts

### Task-Based Execution

Both tools use `execution.taskSupport: 'required'`, meaning they follow the "call-now, fetch-later" pattern:

1. Client calls tool with `task: { ttl: 60000 }` parameter
2. Server creates a task and returns `CreateTaskResult` immediately
3. Client polls via `tasks/result` to get the final result
4. Server sends elicitation/sampling requests through the task message queue
5. Client handles requests and returns responses
6. Server completes the task with the final result

### Message Queue Pattern

When a tool needs to interact with the client (elicitation or sampling), it:

1. Updates task status to `input_required`
2. Enqueues the request in the task message queue
3. Waits for the response via a Resolver
4. Updates task status back to `working`
5. Continues processing

The `TaskResultHandler` dequeues messages when the client calls `tasks/result` and routes responses back to waiting Resolvers.

## Running the Example

### Start the Server

```bash
# From anywhere in the SDK
pnpm --filter @modelcontextprotocol/examples-server exec tsx src/simpleTaskInteractive.ts

# Or with a custom port
PORT=9000 pnpm --filter @modelcontextprotocol/examples-server exec tsx src/simpleTaskInteractive.ts
```

Or, from within the `examples/server` package:

```bash
cd examples/server
pnpm tsx src/simpleTaskInteractive.ts

# Or with a custom port
PORT=9000 pnpm tsx src/simpleTaskInteractive.ts
```

The server will start on http://localhost:8000/mcp (or your custom port).

### Run the Client

```bash
# From anywhere in the SDK
pnpm --filter @modelcontextprotocol/examples-client exec tsx src/simpleTaskInteractiveClient.ts

# Or connect to a different server
pnpm --filter @modelcontextprotocol/examples-client exec tsx src/simpleTaskInteractiveClient.ts --url http://localhost:9000/mcp
```

Or, from within the `examples/client` package:

```bash
cd examples/client
pnpm tsx src/simpleTaskInteractiveClient.ts

# Or connect to a different server
pnpm tsx src/simpleTaskInteractiveClient.ts --url http://localhost:9000/mcp
```

## Expected Output

### Server Output

```
Starting server on http://localhost:8000/mcp

Available tools:
  - confirm_delete: Demonstrates elicitation (asks user y/n)
  - write_haiku: Demonstrates sampling (requests LLM completion)

[Server] confirm_delete called, task created: task-abc123
[Server] confirm_delete: asking about 'important.txt'
[Server] Sending elicitation request to client...
[Server] tasks/result called for task task-abc123
[Server] Delivering queued request message for task task-abc123
[Server] Received elicitation response: action=accept, content={"confirm":true}
[Server] Completing task with result: Deleted 'important.txt'

[Server] write_haiku called, task created: task-def456
[Server] write_haiku: topic 'autumn leaves'
[Server] Sending sampling request to client...
[Server] tasks/result called for task task-def456
[Server] Delivering queued request message for task task-def456
[Server] Received sampling response: Cherry blossoms fall...
[Server] Completing task with haiku
```

### Client Output

```
Simple Task Interactive Client
==============================
Connecting to http://localhost:8000/mcp...
Connected!

Available tools: confirm_delete, write_haiku

--- Demo 1: Elicitation ---
Calling confirm_delete tool...
Task created: task-abc123
Task status: working

[Elicitation] Server asks: Are you sure you want to delete 'important.txt'?
Your response (y/n): y
[Elicitation] Responding with: confirm=true
Task status: input_required
Task status: completed
Result: Deleted 'important.txt'

--- Demo 2: Sampling ---
Calling write_haiku tool...
Task created: task-def456
Task status: working

[Sampling] Server requests LLM completion for: Write a haiku about autumn leaves
[Sampling] Responding with haiku
Task status: input_required
Task status: completed
Result:
Haiku:
Cherry blossoms fall
Softly on the quiet pond
Spring whispers goodbye

Demo complete. Closing connection...
```

## Implementation Details

### Server Components

- **Resolver**: Promise-like class for passing results between async operations
- **TaskMessageQueueWithResolvers**: Extended message queue that tracks pending requests with their Resolvers
- **TaskStoreWithNotifications**: Extended task store with notification support for status changes
- **TaskResultHandler**: Handles `tasks/result` requests by dequeuing messages and routing responses
- **TaskSession**: Wraps the server to enqueue requests during task execution

### Client Capabilities

The client declares these capabilities during initialization:

```typescript
capabilities: {
    elicitation: { form: {} },
    sampling: {}
}
```

This tells the server that the client can handle both form-based elicitation and sampling requests.

## Related Files

- `packages/core/src/experimental/tasks/interfaces.ts` - Core task interfaces (TaskStore, TaskMessageQueue)
- `packages/core/src/experimental/tasks/stores/in-memory.ts` - In-memory task store implementation
- `packages/core/src/types/types.ts` - Task-related types (Task, CreateTaskResult, GetTaskRequestSchema, etc.)
