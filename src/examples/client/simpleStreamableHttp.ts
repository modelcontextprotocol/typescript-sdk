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
  ListResourcesResultSchema
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

  // List available prompts
  const promptsRequest: ListPromptsRequest = {
    method: 'prompts/list',
    params: {}
  };
  const promptsResult = await client.request(promptsRequest, ListPromptsResultSchema);
  console.log('Available prompts:', promptsResult.prompts);

  // Get a prompt
  const promptRequest: GetPromptRequest = {
    method: 'prompts/get',
    params: {
      name: 'greeting-template',
      arguments: { name: 'MCP User' }
    }
  };
  const promptResult = await client.request(promptRequest, GetPromptResultSchema);
  console.log('Prompt template:', promptResult.messages[0].content.text);

  // List available resources
  const resourcesRequest: ListResourcesRequest = {
    method: 'resources/list',
    params: {}
  };
  const resourcesResult = await client.request(resourcesRequest, ListResourcesResultSchema);
  console.log('Available resources:', resourcesResult.resources);
  
  // Close the connection
  await client.close();
}

main().catch((error: unknown) => {
  console.error('Error running MCP client:', error);
  process.exit(1);
});