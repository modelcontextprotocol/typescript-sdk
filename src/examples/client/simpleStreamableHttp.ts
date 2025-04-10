import { Client } from '../../client/index.js';
import { StreamableHTTPClientTransport } from '../../client/streamableHttp.js';
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
  LoggingMessageNotificationSchema
} from '../../types.js';

async function main(): Promise<void> {
  // Create a new client with streamable HTTP transport
  const client = new Client({
    name: 'example-client',
    version: '1.0.0'
  });

  const transport = new StreamableHTTPClientTransport(
    new URL('http://localhost:3000/mcp')
  );

  // Connect the client using the transport and initialize the server
  await client.connect(transport);
  client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
    console.log(`Notification received: ${notification.params.level} - ${notification.params.data}`);
  });


  console.log('Connected to MCP server');
  // List available tools
  const toolsRequest: ListToolsRequest = {
    method: 'tools/list',
    params: {}
  };
  const toolsResult = await client.request(toolsRequest, ListToolsResultSchema);
  console.log('Available tools:', toolsResult.tools);

  // Call the 'greet' tool
  const greetRequest: CallToolRequest = {
    method: 'tools/call',
    params: {
      name: 'greet',
      arguments: { name: 'MCP User' }
    }
  };
  const greetResult = await client.request(greetRequest, CallToolResultSchema);
  console.log('Greeting result:', greetResult.content[0].text);

  // Call the new 'multi-greet' tool
  console.log('\nCalling multi-greet tool (with notifications)...');
  const multiGreetRequest: CallToolRequest = {
    method: 'tools/call',
    params: {
      name: 'multi-greet',
      arguments: { name: 'MCP User' }
    }
  };
  const multiGreetResult = await client.request(multiGreetRequest, CallToolResultSchema);
  console.log('Multi-greet results:');
  multiGreetResult.content.forEach(item => {
    if (item.type === 'text') {
      console.log(`- ${item.text}`);
    }
  });

  // List available prompts
  try {
    const promptsRequest: ListPromptsRequest = {
      method: 'prompts/list',
      params: {}
    };
    const promptsResult = await client.request(promptsRequest, ListPromptsResultSchema);
    console.log('Available prompts:', promptsResult.prompts);
  } catch (error) {
    console.log(`Prompts not supported by this server (${error})`);
  }

  // Get a prompt
  try {
    const promptRequest: GetPromptRequest = {
      method: 'prompts/get',
      params: {
        name: 'greeting-template',
        arguments: { name: 'MCP User' }
      }
    };
    const promptResult = await client.request(promptRequest, GetPromptResultSchema);
    console.log('Prompt template:', promptResult.messages[0].content.text);
  } catch (error) {
    console.log(`Prompt retrieval not supported by this server (${error})`);
  }

  // List available resources
  try {
    const resourcesRequest: ListResourcesRequest = {
      method: 'resources/list',
      params: {}
    };
    const resourcesResult = await client.request(resourcesRequest, ListResourcesResultSchema);
    console.log('Available resources:', resourcesResult.resources);
  } catch (error) {
    console.log(`Resources not supported by this server (${error})`);
  }

  // Close the connection
  await client.close();
}

main().catch((error: unknown) => {
  console.error('Error running MCP client:', error);
  process.exit(1);
});