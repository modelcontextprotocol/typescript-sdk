import { Client } from '../../client/index.js';
import { StreamableHTTPClientTransport } from '../../client/streamableHttp.js';
import { createInterface } from 'node:readline';
import {
  ListToolsRequest,
  ListToolsResultSchema,
  CallToolRequest,
  CallToolResultSchema,
  ListPromptsRequest,
  ListPromptsResultSchema,
  GetPromptRequest,
  GetPromptResultSchema,
  ListResourcesRequest,
  ListResourcesResultSchema,
  LoggingMessageNotificationSchema,
  ResourceListChangedNotificationSchema,
} from '../../types.js';

// Create readline interface for user input
const readline = createInterface({
  input: process.stdin,
  output: process.stdout
});

// Track received notifications for debugging resumability
let notificationCount = 0;

// Global client and transport for interactive commands
let client: Client | null = null;
let transport: StreamableHTTPClientTransport | null = null;
let serverUrl = 'http://localhost:3000/mcp';
let notificationsToolLastEventId: string | undefined = undefined;
let sessionId: string | undefined = undefined;

async function main(): Promise<void> {
  console.log('MCP Interactive Client');
  console.log('=====================');

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
  console.log('  terminate-session          - Terminate the current session');
  console.log('  reconnect                  - Reconnect to the server');
  console.log('  list-tools                 - List available tools');
  console.log('  call-tool <name> [args]    - Call a tool with optional JSON arguments');
  console.log('  greet [name]               - Call the greet tool');
  console.log('  multi-greet [name]         - Call the multi-greet tool with notifications');
  console.log('  start-notifications [interval] [count] - Start periodic notifications');
  console.log('  list-prompts               - List available prompts');
  console.log('  get-prompt [name] [args]   - Get a prompt with optional JSON arguments');
  console.log('  list-resources             - List available resources');
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

        case 'terminate-session':
          await terminateSession();
          break;

        case 'reconnect':
          await reconnect();
          break;

        case 'list-tools':
          await listTools();
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

        case 'greet':
          await callGreetTool(args[1] || 'MCP User');
          break;

        case 'multi-greet':
          await callMultiGreetTool(args[1] || 'MCP User');
          break;

        case 'start-notifications': {
          const interval = args[1] ? parseInt(args[1], 10) : 2000;
          const count = args[2] ? parseInt(args[2], 10) : 10;
          await startNotifications(interval, count);
          break;
        }

        case 'list-prompts':
          await listPrompts();
          break;

        case 'get-prompt':
          if (args.length < 2) {
            console.log('Usage: get-prompt <name> [args]');
          } else {
            const promptName = args[1];
            let promptArgs = {};
            if (args.length > 2) {
              try {
                promptArgs = JSON.parse(args.slice(2).join(' '));
              } catch {
                console.log('Invalid JSON arguments. Using empty args.');
              }
            }
            await getPrompt(promptName, promptArgs);
          }
          break;

        case 'list-resources':
          await listResources();
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
      name: 'example-client',
      version: '1.0.0'
    });
    client.onerror = (error) => {
      console.error('\x1b[31mClient error:', error, '\x1b[0m');
    }

    transport = new StreamableHTTPClientTransport(
      new URL(serverUrl),
      {
        sessionId: sessionId
      }
    );

    // Set up notification handlers
    client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
      notificationCount++;
      console.log(`\nNotification #${notificationCount}: ${notification.params.level} - ${notification.params.data}`);
      // Re-display the prompt
      process.stdout.write('> ');
    });

    client.setNotificationHandler(ResourceListChangedNotificationSchema, async (_) => {
      console.log(`\nResource list changed notification received!`);
      try {
        if (!client) {
          console.log('Client disconnected, cannot fetch resources');
          return;
        }
        const resourcesResult = await client.request({
          method: 'resources/list',
          params: {}
        }, ListResourcesResultSchema);
        console.log('Available resources count:', resourcesResult.resources.length);
      } catch {
        console.log('Failed to list resources after change notification');
      }
      // Re-display the prompt
      process.stdout.write('> ');
    });

    // Connect the client
    await client.connect(transport);
    sessionId = transport.sessionId
    console.log('Transport created with session ID:', sessionId);
    console.log('Connected to MCP server');
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

async function terminateSession(): Promise<void> {
  if (!client || !transport) {
    console.log('Not connected.');
    return;
  }

  try {
    console.log('Terminating session with ID:', transport.sessionId);
    await transport.terminateSession();
    console.log('Session terminated successfully');
    
    // Check if sessionId was cleared after termination
    if (!transport.sessionId) {
      console.log('Session ID has been cleared');
      sessionId = undefined;
      
      // Also close the transport and clear client objects
      await transport.close();
      console.log('Transport closed after session termination');
      client = null;
      transport = null;
    } else {
      console.log('Server responded with 405 Method Not Allowed (session termination not supported)');
      console.log('Session ID is still active:', transport.sessionId);
    }
  } catch (error) {
    console.error('Error terminating session:', error);
  }
}

async function reconnect(): Promise<void> {
  if (client) {
    await disconnect();
  }
  await connect();
}

async function listTools(): Promise<void> {
  if (!client) {
    console.log('Not connected to server.');
    return;
  }

  try {
    const toolsRequest: ListToolsRequest = {
      method: 'tools/list',
      params: {}
    };
    const toolsResult = await client.request(toolsRequest, ListToolsResultSchema);

    console.log('Available tools:');
    if (toolsResult.tools.length === 0) {
      console.log('  No tools available');
    } else {
      for (const tool of toolsResult.tools) {
        console.log(`  - ${tool.name}: ${tool.description}`);
      }
    }
  } catch (error) {
    console.log(`Tools not supported by this server (${error})`);
  }
}

async function callTool(name: string, args: Record<string, unknown>): Promise<void> {
  if (!client) {
    console.log('Not connected to server.');
    return;
  }

  try {
    const request: CallToolRequest = {
      method: 'tools/call',
      params: {
        name,
        arguments: args
      }
    };

    console.log(`Calling tool '${name}' with args:`, args);
    const onLastEventIdUpdate = (event: string) => {
      notificationsToolLastEventId = event;
    };
    const result = await client.request(request, CallToolResultSchema, {
      resumptionToken: notificationsToolLastEventId, onresumptiontoken: onLastEventIdUpdate
    });

    console.log('Tool result:');
    if (result.content) {
      result.content.forEach(item => {
        if (item.type === 'text') {
          console.log(`  ${item.text}`);
        } else {
          console.log(`  ${item.type} content:`, item);
        }
      });
    } else if (result.structuredContent) {
      console.log(`  Structured content: ${result.structuredContent}`);
    } else {
      console.log('  No content returned');
    }
  } catch (error) {
    console.log(`Error calling tool ${name}: ${error}`);
  }
}

async function callGreetTool(name: string): Promise<void> {
  await callTool('greet', { name });
}

async function callMultiGreetTool(name: string): Promise<void> {
  console.log('Calling multi-greet tool with notifications...');
  await callTool('multi-greet', { name });
}

async function startNotifications(interval: number, count: number): Promise<void> {
  console.log(`Starting notification stream: interval=${interval}ms, count=${count || 'unlimited'}`);
  await callTool('start-notification-stream', { interval, count });
}

async function listPrompts(): Promise<void> {
  if (!client) {
    console.log('Not connected to server.');
    return;
  }

  try {
    const promptsRequest: ListPromptsRequest = {
      method: 'prompts/list',
      params: {}
    };
    const promptsResult = await client.request(promptsRequest, ListPromptsResultSchema);
    console.log('Available prompts:');
    if (promptsResult.prompts.length === 0) {
      console.log('  No prompts available');
    } else {
      for (const prompt of promptsResult.prompts) {
        console.log(`  - ${prompt.name}: ${prompt.description}`);
      }
    }
  } catch (error) {
    console.log(`Prompts not supported by this server (${error})`);
  }
}

async function getPrompt(name: string, args: Record<string, unknown>): Promise<void> {
  if (!client) {
    console.log('Not connected to server.');
    return;
  }

  try {
    const promptRequest: GetPromptRequest = {
      method: 'prompts/get',
      params: {
        name,
        arguments: args as Record<string, string>
      }
    };

    const promptResult = await client.request(promptRequest, GetPromptResultSchema);
    console.log('Prompt template:');
    promptResult.messages.forEach((msg, index) => {
      console.log(`  [${index + 1}] ${msg.role}: ${msg.content.text}`);
    });
  } catch (error) {
    console.log(`Error getting prompt ${name}: ${error}`);
  }
}

async function listResources(): Promise<void> {
  if (!client) {
    console.log('Not connected to server.');
    return;
  }

  try {
    const resourcesRequest: ListResourcesRequest = {
      method: 'resources/list',
      params: {}
    };
    const resourcesResult = await client.request(resourcesRequest, ListResourcesResultSchema);

    console.log('Available resources:');
    if (resourcesResult.resources.length === 0) {
      console.log('  No resources available');
    } else {
      for (const resource of resourcesResult.resources) {
        console.log(`  - ${resource.name}: ${resource.uri}`);
      }
    }
  } catch (error) {
    console.log(`Resources not supported by this server (${error})`);
  }
}

async function cleanup(): Promise<void> {
  if (client && transport) {
    try {
      // First try to terminate the session gracefully
      if (transport.sessionId) {
        try {
          console.log('Terminating session before exit...');
          await transport.terminateSession();
          console.log('Session terminated successfully');
        } catch (error) {
          console.error('Error terminating session:', error);
        }
      }
      
      // Then close the transport
      await transport.close();
    } catch (error) {
      console.error('Error closing transport:', error);
    }
  }

  process.stdin.setRawMode(false);
  readline.close();
  console.log('\nGoodbye!');
  process.exit(0);
}

// Set up raw mode for keyboard input to capture Escape key
process.stdin.setRawMode(true);
process.stdin.on('data', async (data) => {
  // Check for Escape key (27)
  if (data.length === 1 && data[0] === 27) {
    console.log('\nESC key pressed. Disconnecting from server...');

    // Abort current operation and disconnect from server
    if (client && transport) {
      await disconnect();
      console.log('Disconnected. Press Enter to continue.');
    } else {
      console.log('Not connected to server.');
    }

    // Re-display the prompt
    process.stdout.write('> ');
  }
});

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