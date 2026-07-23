//#region prelude
import Anthropic from '@anthropic-ai/sdk';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import readline from 'readline/promises';

const ANTHROPIC_MODEL = 'claude-sonnet-4-6';

class MCPClient {
  private mcp: Client;
  private _anthropic: Anthropic | null = null;
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
      const transport = new StdioClientTransport({ command, args: [serverScriptPath] });
      await this.mcp.connect(transport);

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
    let response = await this.anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 1000,
      messages,
      tools: this.tools,
    });

    // Process responses, executing tool calls until Claude stops requesting them
    const finalText = [];

    while (true) {
      const toolUses: Anthropic.ToolUseBlock[] = [];
      for (const content of response.content) {
        if (content.type === 'text') {
          finalText.push(content.text);
        } else if (content.type === 'tool_use') {
          toolUses.push(content);
        }
      }

      if (toolUses.length === 0) {
        break;
      }

      // Execute every requested tool call and collect the results
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const toolUse of toolUses) {
        const toolArgs = toolUse.input as Record<string, unknown>;
        const result = await this.mcp.callTool({
          name: toolUse.name,
          arguments: toolArgs,
        });

        finalText.push(`[Calling tool ${toolUse.name} with args ${JSON.stringify(toolArgs)}]`);

        // Extract text from tool result content blocks
        const toolResultText = result.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n');

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: toolResultText,
          // Tell Claude when the tool call failed
          ...(result.isError ? { is_error: true } : {}),
        });
      }

      // Continue the conversation: the assistant turn, then ALL tool
      // results together in a single user turn
      messages.push({
        role: 'assistant',
        content: response.content,
      });
      messages.push({
        role: 'user',
        content: toolResults,
      });

      // Get next response from Claude
      response = await this.anthropic.messages.create({
        model: ANTHROPIC_MODEL,
        max_tokens: 1000,
        messages,
        tools: this.tools,
      });
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
  const serverScriptPath = process.argv[2];
  if (!serverScriptPath) {
    console.log('Usage: node build/index.js <path_to_server_script>');
    return;
  }
  const mcpClient = new MCPClient();
  try {
    await mcpClient.connectToServer(serverScriptPath);

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
