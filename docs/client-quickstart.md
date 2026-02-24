---
title: Client Quickstart
---

# Quickstart: Build an LLM-powered chatbot

In this tutorial, we'll build an LLM-powered chatbot that connects to an MCP server, discovers its tools, and uses Claude to call them.

Before you begin, it helps to have gone through the [server quickstart](./server-quickstart.md) so you understand how clients and servers communicate.

[You can find the complete code for this tutorial here.](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/examples/client-quickstart)

## Prerequisites

This quickstart assumes you have familiarity with:

- TypeScript
- LLMs like Claude

Before starting, ensure your system meets these requirements:

- Node.js 20 or higher installed
- Latest version of `npm` installed
- An Anthropic API key from the [Anthropic Console](https://console.anthropic.com/settings/keys)

## Set up your environment

First, let's create and set up our project:

**macOS/Linux:**

```bash
# Create project directory
mkdir mcp-client
cd mcp-client

# Initialize npm project
npm init -y

# Install dependencies
npm install @anthropic-ai/sdk @modelcontextprotocol/client

# Install dev dependencies
npm install -D @types/node typescript

# Create source file
mkdir src
touch src/index.ts
```

**Windows:**

```powershell
# Create project directory
md mcp-client
cd mcp-client

# Initialize npm project
npm init -y

# Install dependencies
npm install @anthropic-ai/sdk @modelcontextprotocol/client

# Install dev dependencies
npm install -D @types/node typescript

# Create source file
md src
new-item src\index.ts
```

Update your `package.json` to set `type: "module"` and a build script:

```json
{
  "type": "module",
  "scripts": {
    "build": "tsc"
  }
}
```

Create a `tsconfig.json` in the root of your project:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "./build",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules"]
}
```

## Creating the client

### Basic client structure

First, let's set up our imports and create the basic client class in `src/index.ts`:

```ts source="../examples/client-quickstart/src/index.ts#prelude"
import Anthropic from '@anthropic-ai/sdk';
import { Client, StdioClientTransport, type CallToolResult } from '@modelcontextprotocol/client';
import readline from 'readline/promises';

const ANTHROPIC_MODEL = 'claude-sonnet-4-5';

class MCPClient {
  private mcp: Client;
  private _anthropic: Anthropic | null = null;
  private transport: StdioClientTransport | null = null;
  private tools: Anthropic.Tool[] = [];

  constructor() {
    // Initialize MCP client
    this.mcp = new Client({ name: 'mcp-client-cli', version: '1.0.0' });
  }

  private get anthropic(): Anthropic {
    // Lazy-initialize Anthropic client when needed
    return this._anthropic ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
```

### Server connection management

Next, we'll implement the method to connect to an MCP server:

```ts source="../examples/client-quickstart/src/index.ts#connectToServer"
  async connectToServer(serverScriptPath: string) {
    try {
      // Determine script type and appropriate command
      const isJs = serverScriptPath.endsWith('.js');
      const isPy = serverScriptPath.endsWith('.py');
      if (!isJs && !isPy) {
        throw new Error('Server script must be a .js or .py file');
      }
      const command = isPy
        ? (process.platform === 'win32' ? 'python' : 'python3')
        : process.execPath;

      // Initialize transport and connect to server
      this.transport = new StdioClientTransport({ command, args: [serverScriptPath] });
      await this.mcp.connect(this.transport);

      // List available tools
      const toolsResult = await this.mcp.listTools();
      this.tools = toolsResult.tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
      }));
      console.log('Connected to server with tools:', this.tools.map(({ name }) => name));
    } catch (e) {
      console.log('Failed to connect to MCP server: ', e);
      throw e;
    }
  }
```

### Query processing logic

Now let's add the core functionality for processing queries and handling tool calls:

```ts source="../examples/client-quickstart/src/index.ts#processQuery"
  async processQuery(query: string) {
    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content: query,
      },
    ];

    // Initial Claude API call
    const response = await this.anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 1000,
      messages,
      tools: this.tools,
    });

    // Process response and handle tool calls
    const finalText = [];

    for (const content of response.content) {
      if (content.type === 'text') {
        finalText.push(content.text);
      } else if (content.type === 'tool_use') {
        // Execute tool call
        const toolName = content.name;
        const toolArgs = content.input as Record<string, unknown> | undefined;
        const result = await this.mcp.callTool({
          name: toolName,
          arguments: toolArgs,
        }) as CallToolResult;

        finalText.push(`[Calling tool ${toolName} with args ${JSON.stringify(toolArgs)}]`);

        // Extract text from tool result content blocks
        const toolResultText = result.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n');

        // Continue conversation with tool results
        messages.push({
          role: 'assistant',
          content: response.content,
        });
        messages.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: content.id,
            content: toolResultText,
          }],
        });

        // Get next response from Claude
        const followUp = await this.anthropic.messages.create({
          model: ANTHROPIC_MODEL,
          max_tokens: 1000,
          messages,
        });

        finalText.push(followUp.content[0].type === 'text' ? followUp.content[0].text : '');
      }
    }

    return finalText.join('\n');
  }
```

### Interactive chat interface

Now we'll add the chat loop and cleanup functionality:

```ts source="../examples/client-quickstart/src/index.ts#chatLoop"
  async chatLoop() {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      console.log('\nMCP Client Started!');
      console.log('Type your queries or "quit" to exit.');

      while (true) {
        const message = await rl.question('\nQuery: ');
        if (message.toLowerCase() === 'quit') {
          break;
        }
        const response = await this.processQuery(message);
        console.log('\n' + response);
      }
    } finally {
      rl.close();
    }
  }

  async cleanup() {
    await this.mcp.close();
  }
}
```

### Main entry point

Finally, we'll add the main execution logic:

```ts source="../examples/client-quickstart/src/index.ts#main"
async function main() {
  if (process.argv.length < 3) {
    console.log('Usage: node build/index.js <path_to_server_script>');
    return;
  }
  const mcpClient = new MCPClient();
  try {
    await mcpClient.connectToServer(process.argv[2]);

    // Check if we have a valid API key to continue
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.log(
        '\nNo ANTHROPIC_API_KEY found. To query these tools with Claude, set your API key:'
        + '\n  export ANTHROPIC_API_KEY=your-api-key-here'
      );
      return;
    }

    await mcpClient.chatLoop();
  } catch (e) {
    console.error('Error:', e);
    process.exit(1);
  } finally {
    await mcpClient.cleanup();
    process.exit(0);
  }
}

main();
```

## Running the client

To run your client with any MCP server:

**macOS/Linux:**

```bash
# Build TypeScript
npm run build

# Run the client with a Node.js MCP server
ANTHROPIC_API_KEY=your-key-here node build/index.js path/to/server/build/index.js

# Example: connect to the weather server from the server quickstart
ANTHROPIC_API_KEY=your-key-here node build/index.js /absolute/path/to/weather/build/index.js
```

**Windows:**

```powershell
# Build TypeScript
npm run build

# Run the client with a Node.js MCP server
$env:ANTHROPIC_API_KEY="your-key-here"; node build/index.js path\to\server\build\index.js
```

**The client will:**

1. Connect to the specified server
2. List available tools
3. Start an interactive chat session where you can:
   - Enter queries
   - See tool executions
   - Get responses from Claude

## What's happening under the hood

When you submit a query:

1. Your query is sent to Claude along with the tool descriptions discovered during connection
2. Claude decides which tools (if any) to use
3. The client executes any requested tool calls through the server
4. Results are sent back to Claude
5. Claude provides a natural language response
6. The response is displayed to you

## Troubleshooting

### Server Path Issues

- Double-check the path to your server script is correct
- Use the absolute path if the relative path isn't working
- For Windows users, make sure to use forward slashes (`/`) or escaped backslashes (`\\`) in the path
- Verify the server file has the correct extension (`.js` for Node.js or `.py` for Python)

Example of correct path usage:

**macOS/Linux:**

```bash
# Relative path
node build/index.js ./server/build/index.js

# Absolute path
node build/index.js /Users/username/projects/mcp-server/build/index.js
```

**Windows:**

```powershell
# Relative path
node build/index.js .\server\build\index.js

# Absolute path (either format works)
node build/index.js C:\projects\mcp-server\build\index.js
node build/index.js C:/projects/mcp-server/build/index.js
```

### Response Timing

- The first response might take up to 30 seconds to return
- This is normal and happens while:
  - The server initializes
  - Claude processes the query
  - Tools are being executed
- Subsequent responses are typically faster
- Don't interrupt the process during this initial waiting period

### Common Error Messages

If you see:

- `Error: Cannot find module`: Check your build folder and ensure TypeScript compilation succeeded
- `Connection refused`: Ensure the server is running and the path is correct
- `Tool execution failed`: Verify the tool's required environment variables are set
- `ANTHROPIC_API_KEY is not set`: Check your environment variables (e.g., `export ANTHROPIC_API_KEY=...`)
- `TypeError`: Ensure you're using the correct types for tool arguments
- `BadRequestError`: Ensure you have enough credits to access the Anthropic API

## Next steps

Now that you have a working client, here are some ways to go further:

- [**Client guide**](./client.md) — Add OAuth, middleware, sampling, and more to your client.
- [**Example clients**](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/examples/client) — Browse runnable client examples.
- [**FAQ**](./faq.md) — Troubleshoot common errors.
