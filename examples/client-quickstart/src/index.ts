//#region prelude
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
//#endregion prelude

//#region connectToServer
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
//#endregion connectToServer

//#region processQuery
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
//#endregion processQuery

//#region chatLoop
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
//#endregion chatLoop

//#region main
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
//#endregion main
