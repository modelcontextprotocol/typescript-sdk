import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import readline from 'readline/promises';

import Anthropic from '@anthropic-ai/sdk';
import { Client, StdioClientTransport } from '@modelcontextprotocol/client';

const ANTHROPIC_MODEL = 'claude-sonnet-4-5';

interface ServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface ServersConfig {
  mcpServers: Record<string, ServerConfig>;
}

class MultiServerClient {
  private servers: Map<string, Client> = new Map();
  private toolToServer: Map<string, { serverName: string; originalName: string }> = new Map();
  private _anthropic: Anthropic | null = null;
  private tools: Anthropic.Tool[] = [];

  private get anthropic(): Anthropic {
    return this._anthropic ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  async connectToServers(configPath: string) {
    const raw = readFileSync(resolve(configPath), 'utf-8');
    const config: ServersConfig = JSON.parse(raw);

    for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
      console.log(`Connecting to server: ${name}...`);
      try {
        const transport = new StdioClientTransport({
          command: serverConfig.command,
          args: serverConfig.args,
          env: serverConfig.env
            ? { ...process.env as Record<string, string>, ...serverConfig.env }
            : undefined,
        });
        const client = new Client({ name: `multi-server-client-${name}`, version: '1.0.0' });
        await client.connect(transport);
        this.servers.set(name, client);

        // Discover tools from this server
        const toolsResult = await client.listTools();
        for (const tool of toolsResult.tools) {
          const prefixedName = `${name}__${tool.name}`;
          if (this.toolToServer.has(prefixedName)) {
            console.warn(
              `  Warning: tool "${tool.name}" from server "${name}" collides with an existing tool.`
            );
          }
          this.toolToServer.set(prefixedName, { serverName: name, originalName: tool.name });
          this.tools.push({
            name: prefixedName,
            description: `[${name}] ${tool.description ?? ''}`,
            input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
          });
        }
        console.log(
          `  Connected to ${name} with tools: ${toolsResult.tools.map((t) => t.name).join(', ')}`
        );
      } catch (e) {
        console.error(`  Failed to connect to ${name}:`, e);
        throw e;
      }
    }

    console.log(`\nTotal tools available: ${this.tools.length}`);
  }

  async processQuery(query: string) {
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: query }];

    // Agentic loop: keep processing until the model stops issuing tool calls
    let response = await this.anthropic.messages.create({
      model: ANTHROPIC_MODEL,
      max_tokens: 1000,
      messages,
      tools: this.tools,
    });

    const finalText: string[] = [];

    while (response.stop_reason === 'tool_use') {
      const assistantContent = response.content;
      messages.push({ role: 'assistant', content: assistantContent });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of assistantContent) {
        if (block.type === 'text') {
          finalText.push(block.text);
        } else if (block.type === 'tool_use') {
          const mapping = this.toolToServer.get(block.name);
          if (!mapping) {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: `Error: unknown tool "${block.name}"`,
              is_error: true,
            });
            continue;
          }

          const { serverName, originalName } = mapping;
          const client = this.servers.get(serverName)!;
          console.log(`  [Calling ${originalName} on server "${serverName}"]`);

          try {
            const result = await client.callTool({
              name: originalName,
              arguments: block.input as Record<string, unknown> | undefined,
            });

            const resultText = result.content
              .filter((c) => c.type === 'text')
              .map((c) => c.text)
              .join('\n');

            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: resultText,
            });
          } catch (e) {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: `Error executing tool: ${e}`,
              is_error: true,
            });
          }
        }
      }

      messages.push({ role: 'user', content: toolResults });

      response = await this.anthropic.messages.create({
        model: ANTHROPIC_MODEL,
        max_tokens: 1000,
        messages,
        tools: this.tools,
      });
    }

    // Collect any remaining text from the final response
    for (const block of response.content) {
      if (block.type === 'text') {
        finalText.push(block.text);
      }
    }

    return finalText.join('\n');
  }

  async chatLoop() {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      console.log('\nMulti-Server MCP Client Started!');
      console.log('Type your queries or "quit" to exit.\n');

      while (true) {
        const message = await rl.question('Query: ');
        if (message.toLowerCase() === 'quit') {
          break;
        }
        const response = await this.processQuery(message);
        console.log('\n' + response + '\n');
      }
    } finally {
      rl.close();
    }
  }

  async cleanup() {
    for (const [name, client] of this.servers) {
      console.log(`Disconnecting from ${name}...`);
      await client.close();
    }
  }
}

async function main() {
  const configPath = process.argv[2] ?? 'servers.json';

  const mcpClient = new MultiServerClient();
  try {
    await mcpClient.connectToServers(configPath);

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      console.log(
        '\nNo ANTHROPIC_API_KEY found. To chat with these tools via Claude, set your API key:'
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
