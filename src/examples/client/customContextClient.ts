import { Client } from '../../client/index.js';
import { StreamableHTTPClientTransport } from '../../client/streamableHttp.js';
import { SSEClientTransport } from '../../client/sse.js';
import { createInterface } from 'node:readline';
import {
  CallToolResultSchema,
  ListToolsResultSchema,
  GetPromptResultSchema,
  ReadResourceResultSchema,
} from '../../types.js';

/**
 * Interactive client demonstrating custom context feature.
 * 
 * This client shows how API keys are used to authenticate and 
 * how the server uses the context to provide user-specific responses.
 */

// Create readline interface for user input
const readline = createInterface({
  input: process.stdin,
  output: process.stdout
});

// Global state
let client: Client | null = null;
let transport: StreamableHTTPClientTransport | SSEClientTransport | null = null;
const serverUrl = 'http://localhost:3000/mcp';
let currentUser: {
  name: string;
  organization: { name: string };
  role: string;
  permissions: string[];
} | null = null;

// Available API keys for testing
const API_KEYS: Record<string, string> = {
  'alice': 'sk-alice-admin-key',
  'bob': 'sk-bob-dev-key',
  'charlie': 'sk-charlie-user-key',
  'dana': 'sk-dana-admin-key',
};

async function main(): Promise<void> {
  console.log('==============================================');
  console.log('MCP Custom Context Demo Client');
  console.log('==============================================');
  console.log('\nThis client demonstrates how custom context works:');
  console.log('1. Authenticate with an API key');
  console.log('2. The server fetches user context from the API key');
  console.log('3. Tools receive the context and respond based on user permissions\n');

  printHelp();
  commandLoop();
}

function printHelp(): void {
  console.log('\n📋 Available commands:');
  console.log('  auth <user>          - Authenticate as user (alice/bob/charlie/dana)');
  console.log('  auth-key <key>       - Authenticate with custom API key');
  console.log('  whoami               - Get current user info from context');
  console.log('  dashboard [format]   - Get personalized dashboard (brief/detailed)');
  console.log('  profile              - Read user profile resource');
  console.log('  list-tools           - List available tools');
  console.log('  disconnect           - Disconnect from server');
  console.log('  help                 - Show this help');
  console.log('  quit                 - Exit the program');
  console.log('\n🔑 Quick start: Try "auth alice" then "whoami"');
  console.log('\n⚠️  Note: Only the get_user tool is available in this simplified demo.');
}

function commandLoop(): void {
  const prompt = currentUser ? `[${currentUser!.name}]> ` : '> ';
  
  readline.question(prompt, async (input) => {
    const args = input.trim().split(/\s+/);
    const command = args[0]?.toLowerCase();

    try {
      switch (command) {
        case 'auth': {
          const userName = args[1] as keyof typeof API_KEYS;
          if (args.length < 2 || !API_KEYS[userName]) {
            console.log('❌ Usage: auth <alice|bob|charlie|dana>');
            console.log('   Available users:');
            console.log('   - alice: TechCorp Admin (all permissions)');
            console.log('   - bob: TechCorp Developer (code/docs permissions)');
            console.log('   - charlie: StartupIO User (limited permissions)');
            console.log('   - dana: StartupIO Admin (org admin)');
          } else {
            await authenticateAs(userName);
          }
          break;
        }

        case 'auth-key':
          if (args.length < 2) {
            console.log('❌ Usage: auth-key <api-key>');
          } else {
            await authenticateWithKey(args[1]);
          }
          break;

        case 'whoami':
          await getCurrentUser();
          break;


        case 'dashboard':
          await getDashboard(args[1] || 'brief');
          break;

        case 'profile':
          await readProfile();
          break;

        case 'list-tools':
          await listTools();
          break;

        case 'disconnect':
          await disconnect();
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
            console.log(`❓ Unknown command: ${command}`);
          }
          break;
      }
    } catch (error) {
      console.error(`❌ Error: ${error}`);
    }

    // Continue the command loop
    commandLoop();
  });
}

async function authenticateAs(userName: string): Promise<void> {
  const apiKey = API_KEYS[userName as keyof typeof API_KEYS];
  await authenticateWithKey(apiKey);
}

async function authenticateWithKey(apiKey: string): Promise<void> {
  // Disconnect existing connection
  if (client) {
    await disconnect();
  }

  // Store the API key for this session (used in fetch)
  console.log(`\n🔐 Authenticating with API key: ${apiKey.substring(0, 15)}...`);

  // Create transport with API key in headers
  transport = new StreamableHTTPClientTransport(
    new URL(serverUrl),
    {
      fetch: async (url: string | URL, options?: RequestInit) => {
        // Add API key to all requests
        // Handle Headers object or plain object
        let headers: HeadersInit;
        if (options?.headers instanceof Headers) {
          headers = new Headers(options.headers);
          (headers as Headers).set('X-API-Key', apiKey);
        } else {
          headers = {
            ...(options?.headers || {}),
            'X-API-Key': apiKey,
          };
        }
        return fetch(url, { ...options, headers });
      }
    }
  );

  // Create and connect client
  client = new Client({
    name: 'custom-context-demo-client',
    version: '1.0.0'
  });

  try {
    await client.connect(transport);
    console.log('✅ Connected to server');
    
    // Get user info immediately after connecting
    const result = await client.request({
      method: 'tools/call',
      params: {
        name: 'get_user',
        arguments: {}
      }
    }, CallToolResultSchema);

    if (result.content && result.content[0]?.type === 'text') {
      const text = result.content[0].text;
      try {
        // Parse user info from response
        const userMatch = text.match(/User Profile:\n([\s\S]*)/);
        if (userMatch) {
          currentUser = JSON.parse(userMatch[1]);
          console.log(`\n👤 Authenticated as: ${currentUser!.name}`);
          console.log(`   Organization: ${currentUser!.organization.name}`);
          console.log(`   Role: ${currentUser!.role}`);
          console.log(`   Permissions: ${currentUser!.permissions.length} permission(s)`);
        }
      } catch {
        console.log('✅ Authenticated (could not parse user details)');
      }
    }
  } catch (error) {
    console.error(`❌ Failed to connect: ${error}`);
    client = null;
    transport = null;
  }
}

async function getCurrentUser(): Promise<void> {
  if (!client) {
    console.log('❌ Not connected. Use "auth <user>" first.');
    return;
  }

  console.log('\n🔍 Fetching user information from context...');
  
  const result = await client.request({
    method: 'tools/call',
    params: {
      name: 'get_user',
      arguments: {}
    }
  }, CallToolResultSchema);

  if (result.content && result.content[0]?.type === 'text') {
    console.log('\n' + result.content[0].text);
  }
}


async function getDashboard(format: string): Promise<void> {
  if (!client) {
    console.log('❌ Not connected. Use "auth <user>" first.');
    return;
  }

  console.log(`\n📊 Getting ${format} dashboard...`);
  
  const result = await client.request({
    method: 'prompts/get',
    params: {
      name: 'user-dashboard',
      arguments: { format }
    }
  }, GetPromptResultSchema);

  if (result.messages && result.messages[0]?.content?.type === 'text') {
    console.log('\n' + result.messages[0].content.text);
  }
}

async function readProfile(): Promise<void> {
  if (!client) {
    console.log('❌ Not connected. Use "auth <user>" first.');
    return;
  }

  console.log('\n📄 Reading user profile resource...');
  
  try {
    // Read the resource directly using the known URI
    const result = await client.request({
      method: 'resources/read',
      params: { uri: 'user://profile' }
    }, ReadResourceResultSchema);

    if (result.contents && result.contents[0]) {
      const content = result.contents[0];
      console.log(`\n📄 Resource: ${content.uri}`);
      if (content.mimeType) {
        console.log(`Type: ${content.mimeType}`);
      }
      console.log('Content:');
      console.log(content.text || content.blob);
    }
  } catch (error) {
    console.log(`❌ Error reading profile: ${error}`);
  }
}

async function listTools(): Promise<void> {
  if (!client) {
    console.log('❌ Not connected. Use "auth <user>" first.');
    return;
  }

  const result = await client.request({
    method: 'tools/list',
    params: {}
  }, ListToolsResultSchema);

  console.log('\n🔧 Available tools:');
  for (const tool of result.tools) {
    console.log(`  - ${tool.name}: ${tool.description}`);
  }
}

async function disconnect(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    transport = null;
    currentUser = null;
    console.log('✅ Disconnected from server');
  } else {
    console.log('❌ Not connected');
  }
}

async function cleanup(): Promise<void> {
  await disconnect();
  console.log('\n👋 Goodbye!');
  readline.close();
  process.exit(0);
}

// Handle ctrl+c
process.on('SIGINT', async () => {
  await cleanup();
});

// Start the client
main().catch(console.error);