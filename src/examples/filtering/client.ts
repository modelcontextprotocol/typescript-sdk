import { Client } from '../../client/index.js';
import { StreamableHTTPClientTransport } from '../../client/streamableHttp.js';
import { createInterface } from 'node:readline';
import {
  ListToolsResultSchema,
  CallToolResultSchema,
  ToolsFilter
} from '../../types.js';

// Create readline interface for user input
const readline = createInterface({
  input: process.stdin,
  output: process.stdout
});

// Global client and transport
let client: Client | null = null;
let transport: StreamableHTTPClientTransport | null = null;
let serverUrl = 'http://localhost:3000/mcp';

async function main(): Promise<void> {
  console.log('MCP Filtering Client Example');
  console.log('===========================');

  // Connect to server immediately with default settings
  await connect();

  // Print help and start the command loop
  printHelp();
  commandLoop();
}

function printHelp(): void {
  console.log('\nAvailable commands:');
  console.log('  connect [url]              - Connect to MCP server (default: http://localhost:3000/mcp)');
  console.log('  disconnect                 - Disconnect from server');
  console.log('  list-groups                - List all available groups');
  console.log('  list-tags                  - List all available tags');
  console.log('  list-tools                 - List all available tools');
  console.log('  filter-by-group <group>    - Filter tools by a specific group');
  console.log('  filter-by-tag <tag>        - Filter tools by a specific tag');
  console.log('  filter-combined <group> <tag> - Filter tools by both group and tag');
  console.log('  filter-multi-group <group1> <group2> - Filter tools by multiple groups');
  console.log('  filter-multi-tag <tag1> <tag2> - Filter tools by multiple tags');
  console.log('  call-tool <name> [args]    - Call a tool with optional JSON arguments');
  console.log('  help                       - Show this help');
  console.log('  quit                       - Exit the program');
}

function commandLoop(): void {
  readline.question('\n> ', async (input) => {
    const args = input.trim().split(/\s+/);
    const command = args[0]?.toLowerCase();

    try {
      switch (command) {
        case 'connect':
          await connect(args[1]);
          break;

        case 'disconnect':
          await disconnect();
          break;

        case 'list-groups':
          await listGroups();
          break;

        case 'list-tags':
          await listTags();
          break;

        case 'list-tools':
          await listTools();
          break;

        case 'filter-by-group':
          if (args.length < 2) {
            console.log('Usage: filter-by-group <group>');
          } else {
            await filterToolsByGroup(args[1]);
          }
          break;

        case 'filter-by-tag':
          if (args.length < 2) {
            console.log('Usage: filter-by-tag <tag>');
          } else {
            await filterToolsByTag(args[1]);
          }
          break;

        case 'filter-combined':
          if (args.length < 3) {
            console.log('Usage: filter-combined <group> <tag>');
          } else {
            await filterToolsByCombined(args[1], args[2]);
          }
          break;

        case 'filter-multi-group':
          if (args.length < 3) {
            console.log('Usage: filter-multi-group <group1> <group2>');
          } else {
            await filterToolsByMultipleGroups([args[1], args[2]]);
          }
          break;

        case 'filter-multi-tag':
          if (args.length < 3) {
            console.log('Usage: filter-multi-tag <tag1> <tag2>');
          } else {
            await filterToolsByMultipleTags([args[1], args[2]]);
          }
          break;

        case 'call-tool':
          if (args.length < 2) {
            console.log('Usage: call-tool <name> [args]');
          } else {
            const toolName = args[1];
            let toolArgs = {};
            if (args.length > 2) {
              try {
                toolArgs = JSON.parse(args.slice(2).join(' '));
              } catch {
                console.log('Invalid JSON arguments. Using empty args.');
              }
            }
            await callTool(toolName, toolArgs);
          }
          break;

        case 'help':
          printHelp();
          break;

        case 'quit':
        case 'exit':
          await cleanup();
          return;

        default:
          if (command) {
            console.log(`Unknown command: ${command}`);
          }
          break;
      }
    } catch (error) {
      console.error(`Error executing command: ${error}`);
    }

    // Continue the command loop
    commandLoop();
  });
}

async function connect(url?: string): Promise<void> {
  if (client) {
    console.log('Already connected. Disconnect first.');
    return;
  }

  if (url) {
    serverUrl = url;
  }

  console.log(`Connecting to ${serverUrl}...`);

  try {
    // Create a new client
    client = new Client({
      name: 'filtering-example-client',
      version: '1.0.0'
    });

    // Set up error handler
    client.onerror = (error) => {
      console.error('\x1b[31mClient error:', error, '\x1b[0m');
    };

    // Create client transport
    transport = new StreamableHTTPClientTransport(new URL(serverUrl));

    // Connect the client
    await client.connect(transport);
    console.log('Connected to MCP server');

    // Check if filtering capability is available
    const capabilities = client.getServerCapabilities();
    if (capabilities && capabilities.filtering) {
      console.log('Server supports filtering capability!');

      if (capabilities.filtering.groups?.listChanged) {
        console.log('Server supports group list change notifications');
      }

      if (capabilities.filtering.tags?.listChanged) {
        console.log('Server supports tag list change notifications');
      }
    } else {
      console.warn('Warning: Server does not support filtering capability');
    }
  } catch (error) {
    console.error('Failed to connect:', error);
    client = null;
    transport = null;
  }
}

async function disconnect(): Promise<void> {
  if (!client || !transport) {
    console.log('Not connected.');
    return;
  }

  try {
    await transport.close();
    console.log('Disconnected from MCP server');
    client = null;
    transport = null;
  } catch (error) {
    console.error('Error disconnecting:', error);
  }
}

async function listGroups(): Promise<void> {
  if (!client) {
    console.log('Not connected to server.');
    return;
  }

  try {
    console.log('Fetching groups...');
    const result = await client.listGroups();

    console.log('\nAvailable Groups:');
    if (result.groups.length === 0) {
      console.log('  No groups available');
    } else {
      for (const group of result.groups) {
        console.log(`  - ${group.name}: ${group.title}`);
        console.log(`    ${group.description}`);
      }
    }
  } catch (error) {
    console.error('Error listing groups:', error);
  }
}

async function listTags(): Promise<void> {
  if (!client) {
    console.log('Not connected to server.');
    return;
  }

  try {
    console.log('Fetching tags...');
    const result = await client.listTags();

    console.log('\nAvailable Tags:');
    if (result.tags.length === 0) {
      console.log('  No tags available');
    } else {
      for (const tag of result.tags) {
        console.log(`  - ${tag.name}: ${tag.description}`);
      }
    }
  } catch (error) {
    console.error('Error listing tags:', error);
  }
}

async function listTools(): Promise<void> {
  if (!client) {
    console.log('Not connected to server.');
    return;
  }

  try {
    console.log('Fetching all tools...');
    const result = await client.request(
      { method: 'tools/list', params: {} },
      ListToolsResultSchema
    );

    console.log('\nAvailable Tools:');
    if (result.tools.length === 0) {
      console.log('  No tools available');
    } else {
      for (const tool of result.tools) {
        console.log(`  - ${tool.name}: ${tool.title}`);
        console.log(`    ${tool.description}`);

        if (tool.groups && tool.groups.length > 0) {
          console.log(`    Groups: ${tool.groups.join(', ')}`);
        }

        if (tool.tags && tool.tags.length > 0) {
          console.log(`    Tags: ${tool.tags.join(', ')}`);
        }

        console.log('');
      }
    }
  } catch (error) {
    console.error('Error listing tools:', error);
  }
}

async function filterToolsByGroup(group: string): Promise<void> {
  if (!client) {
    console.log('Not connected to server.');
    return;
  }

  try {
    console.log(`Filtering tools by group: ${group}`);

    const filter: ToolsFilter = {
      groups: [group]
    };

    const result = await client.listTools({ filter });

    console.log(`\nTools in group '${group}':`);
    if (result.tools.length === 0) {
      console.log(`  No tools found in group '${group}'`);
    } else {
      for (const tool of result.tools) {
        console.log(`  - ${tool.name}: ${tool.title}`);
        console.log(`    ${tool.description}`);

        if (tool.tags && tool.tags.length > 0) {
          console.log(`    Tags: ${tool.tags.join(', ')}`);
        }

        console.log('');
      }
    }
  } catch (error) {
    console.error('Error filtering tools by group:', error);
  }
}

async function filterToolsByTag(tag: string): Promise<void> {
  if (!client) {
    console.log('Not connected to server.');
    return;
  }

  try {
    console.log(`Filtering tools by tag: ${tag}`);

    const filter: ToolsFilter = {
      tags: [tag]
    };

    const result = await client.listTools({ filter });

    console.log(`\nTools with tag '${tag}':`);
    if (result.tools.length === 0) {
      console.log(`  No tools found with tag '${tag}'`);
    } else {
      for (const tool of result.tools) {
        console.log(`  - ${tool.name}: ${tool.title}`);
        console.log(`    ${tool.description}`);

        if (tool.groups && tool.groups.length > 0) {
          console.log(`    Groups: ${tool.groups.join(', ')}`);
        }

        console.log('');
      }
    }
  } catch (error) {
    console.error('Error filtering tools by tag:', error);
  }
}

async function filterToolsByCombined(group: string, tag: string): Promise<void> {
  if (!client) {
    console.log('Not connected to server.');
    return;
  }

  try {
    console.log(`Filtering tools by group '${group}' AND tag '${tag}'`);

    const filter: ToolsFilter = {
      groups: [group],
      tags: [tag]
    };

    const result = await client.listTools({ filter });

    console.log(`\nTools in group '${group}' with tag '${tag}':`);
    if (result.tools.length === 0) {
      console.log(`  No tools found in group '${group}' with tag '${tag}'`);
    } else {
      for (const tool of result.tools) {
        console.log(`  - ${tool.name}: ${tool.title}`);
        console.log(`    ${tool.description}`);
        console.log('');
      }
    }
  } catch (error) {
    console.error('Error filtering tools by combined criteria:', error);
  }
}

async function filterToolsByMultipleGroups(groups: string[]): Promise<void> {
  if (!client) {
    console.log('Not connected to server.');
    return;
  }

  try {
    console.log(`Filtering tools by groups: ${groups.join(', ')}`);

    const filter: ToolsFilter = {
      groups: groups
    };

    const result = await client.listTools({ filter });

    console.log(`\nTools in ANY of these groups: ${groups.join(', ')}`);
    if (result.tools.length === 0) {
      console.log(`  No tools found in any of these groups`);
    } else {
      for (const tool of result.tools) {
        console.log(`  - ${tool.name}: ${tool.title}`);
        console.log(`    ${tool.description}`);
        console.log(`    Groups: ${tool.groups?.join(', ')}`);

        if (tool.tags && tool.tags.length > 0) {
          console.log(`    Tags: ${tool.tags.join(', ')}`);
        }

        console.log('');
      }
    }
  } catch (error) {
    console.error('Error filtering tools by multiple groups:', error);
  }
}

async function filterToolsByMultipleTags(tags: string[]): Promise<void> {
  if (!client) {
    console.log('Not connected to server.');
    return;
  }

  try {
    console.log(`Filtering tools by tags: ${tags.join(', ')}`);

    const filter: ToolsFilter = {
      tags: tags
    };

    const result = await client.listTools({ filter });

    console.log(`\nTools with ALL of these tags: ${tags.join(', ')}`);
    if (result.tools.length === 0) {
      console.log(`  No tools found with all of these tags`);
    } else {
      for (const tool of result.tools) {
        console.log(`  - ${tool.name}: ${tool.title}`);
        console.log(`    ${tool.description}`);

        if (tool.groups && tool.groups.length > 0) {
          console.log(`    Groups: ${tool.groups.join(', ')}`);
        }

        console.log(`    Tags: ${tool.tags?.join(', ')}`);
        console.log('');
      }
    }
  } catch (error) {
    console.error('Error filtering tools by multiple tags:', error);
  }
}

async function callTool(name: string, args: Record<string, unknown>): Promise<void> {
  if (!client) {
    console.log('Not connected to server.');
    return;
  }

  try {
    console.log(`Calling tool '${name}' with args:`, args);

    const result = await client.request(
      {
        method: 'tools/call',
        params: {
          name,
          arguments: args
        }
      },
      CallToolResultSchema
    );

    console.log('\nTool result:');
    result.content.forEach(item => {
      if (item.type === 'text') {
        console.log(`  ${item.text}`);
      } else {
        console.log(`  [${item.type} content]`);
      }
    });

    if (result.isError) {
      console.log('\nTool reported an error.');
    }
  } catch (error) {
    console.error(`Error calling tool ${name}:`, error);
  }
}

async function cleanup(): Promise<void> {
  if (client && transport) {
    try {
      await transport.close();
    } catch (error) {
      console.error('Error closing transport:', error);
    }
  }

  readline.close();
  console.log('\nGoodbye!');
  process.exit(0);
}

// Handle Ctrl+C
process.on('SIGINT', async () => {
  console.log('\nReceived SIGINT. Cleaning up...');
  await cleanup();
});

// Start the interactive client
main().catch((error: unknown) => {
  console.error('Error running MCP client:', error);
  process.exit(1);
});
