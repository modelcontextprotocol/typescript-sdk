import { Server } from './index.js';
import { Client } from '../client/index.js';
import { InMemoryTransport } from '../inMemory.js';
import { z } from 'zod';
import { McpServer, ResourceTemplate } from './mcp.js';

describe('Title field backwards compatibility', () => {
    it('should work with tools that have title', async () => {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        const server = new McpServer({ name: 'test-server', version: '1.0.0' }, { capabilities: {} });

        // Register tool with title
        server.registerTool(
            'test-tool',
            {
                title: 'Test Tool Display Name',
                description: 'A test tool',
                inputSchema: {
                    value: z.string()
                }
            },
            async () => ({ content: [{ type: 'text', text: 'result' }] })
        );

        const client = new Client({ name: 'test-client', version: '1.0.0' });

        await server.server.connect(serverTransport);
        await client.connect(clientTransport);

        const tools = await client.listTools();
        expect(tools.tools).toHaveLength(1);
        expect(tools.tools[0].name).toBe('test-tool');
        expect(tools.tools[0].title).toBe('Test Tool Display Name');
        expect(tools.tools[0].description).toBe('A test tool');
    });

    it('should work with tools without title', async () => {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        const server = new McpServer({ name: 'test-server', version: '1.0.0' }, { capabilities: {} });

        // Register tool without title
        server.tool('test-tool', 'A test tool', { value: z.string() }, async () => ({ content: [{ type: 'text', text: 'result' }] }));

        const client = new Client({ name: 'test-client', version: '1.0.0' });

        await server.server.connect(serverTransport);
        await client.connect(clientTransport);

        const tools = await client.listTools();
        expect(tools.tools).toHaveLength(1);
        expect(tools.tools[0].name).toBe('test-tool');
        expect(tools.tools[0].title).toBeUndefined();
        expect(tools.tools[0].description).toBe('A test tool');
    });

    it('should work with prompts that have title using update', async () => {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        const server = new McpServer({ name: 'test-server', version: '1.0.0' }, { capabilities: {} });

        // Register prompt with title by updating after creation
        const prompt = server.prompt('test-prompt', 'A test prompt', async () => ({
            messages: [{ role: 'user', content: { type: 'text', text: 'test' } }]
        }));
        prompt.update({ title: 'Test Prompt Display Name' });

        const client = new Client({ name: 'test-client', version: '1.0.0' });

        await server.server.connect(serverTransport);
        await client.connect(clientTransport);

        const prompts = await client.listPrompts();
        expect(prompts.prompts).toHaveLength(1);
        expect(prompts.prompts[0].name).toBe('test-prompt');
        expect(prompts.prompts[0].title).toBe('Test Prompt Display Name');
        expect(prompts.prompts[0].description).toBe('A test prompt');
    });

    it('should work with prompts using registerPrompt', async () => {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        const server = new McpServer({ name: 'test-server', version: '1.0.0' }, { capabilities: {} });

        // Register prompt with title using registerPrompt
        server.registerPrompt(
            'test-prompt',
            {
                title: 'Test Prompt Display Name',
                description: 'A test prompt',
                argsSchema: { input: z.string() }
            },
            async ({ input }) => ({
                messages: [
                    {
                        role: 'user',
                        content: { type: 'text', text: `test: ${input}` }
                    }
                ]
            })
        );

        const client = new Client({ name: 'test-client', version: '1.0.0' });

        await server.server.connect(serverTransport);
        await client.connect(clientTransport);

        const prompts = await client.listPrompts();
        expect(prompts.prompts).toHaveLength(1);
        expect(prompts.prompts[0].name).toBe('test-prompt');
        expect(prompts.prompts[0].title).toBe('Test Prompt Display Name');
        expect(prompts.prompts[0].description).toBe('A test prompt');
        expect(prompts.prompts[0].arguments).toHaveLength(1);
    });

    it('should work with resources using registerResource', async () => {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        const server = new McpServer({ name: 'test-server', version: '1.0.0' }, { capabilities: {} });

        // Register resource with title using registerResource
        server.registerResource(
            'test-resource',
            'https://example.com/test',
            {
                title: 'Test Resource Display Name',
                description: 'A test resource',
                mimeType: 'text/plain'
            },
            async () => ({
                contents: [
                    {
                        uri: 'https://example.com/test',
                        text: 'test content'
                    }
                ]
            })
        );

        const client = new Client({ name: 'test-client', version: '1.0.0' });

        await server.server.connect(serverTransport);
        await client.connect(clientTransport);

        const resources = await client.listResources();
        expect(resources.resources).toHaveLength(1);
        expect(resources.resources[0].name).toBe('test-resource');
        expect(resources.resources[0].title).toBe('Test Resource Display Name');
        expect(resources.resources[0].description).toBe('A test resource');
        expect(resources.resources[0].mimeType).toBe('text/plain');
    });

    it('should work with dynamic resources using registerResource', async () => {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        const server = new McpServer({ name: 'test-server', version: '1.0.0' }, { capabilities: {} });

        // Register dynamic resource with title using registerResource
        server.registerResource(
            'user-profile',
            new ResourceTemplate('users://{userId}/profile', { list: undefined }),
            {
                title: 'User Profile',
                description: 'User profile information'
            },
            async (uri, { userId }, _extra) => ({
                contents: [
                    {
                        uri: uri.href,
                        text: `Profile data for user ${userId}`
                    }
                ]
            })
        );

        const client = new Client({ name: 'test-client', version: '1.0.0' });

        await server.server.connect(serverTransport);
        await client.connect(clientTransport);

        const resourceTemplates = await client.listResourceTemplates();
        expect(resourceTemplates.resourceTemplates).toHaveLength(1);
        expect(resourceTemplates.resourceTemplates[0].name).toBe('user-profile');
        expect(resourceTemplates.resourceTemplates[0].title).toBe('User Profile');
        expect(resourceTemplates.resourceTemplates[0].description).toBe('User profile information');
        expect(resourceTemplates.resourceTemplates[0].uriTemplate).toBe('users://{userId}/profile');

        // Test reading the resource
        const readResult = await client.readResource({ uri: 'users://123/profile' });
        expect(readResult.contents).toHaveLength(1);
        expect(readResult.contents[0].text).toBe('Profile data for user 123');
    });

    it('should support serverInfo with title', async () => {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        const server = new Server(
            {
                name: 'test-server',
                version: '1.0.0',
                title: 'Test Server Display Name'
            },
            { capabilities: {} }
        );

        const client = new Client({ name: 'test-client', version: '1.0.0' });

        await server.connect(serverTransport);
        await client.connect(clientTransport);

        const serverInfo = client.getServerVersion();
        expect(serverInfo?.name).toBe('test-server');
        expect(serverInfo?.version).toBe('1.0.0');
        expect(serverInfo?.title).toBe('Test Server Display Name');
    });
});
