import { Client } from '../../../client/src/index.js';
import { GROUPS_META_KEY, InMemoryTransport } from '../../../core/src/index.js';
import { McpServer } from '../../src/index.js';

describe('Server Groups', () => {
    let server: McpServer;
    let client: Client;
    let serverTransport: InMemoryTransport;
    let clientTransport: InMemoryTransport;

    beforeEach(async () => {
        server = new McpServer({
            name: 'test-server',
            version: '1.0.0'
        });

        const [ct, st] = InMemoryTransport.createLinkedPair();
        clientTransport = ct;
        serverTransport = st;

        client = new Client({
            name: 'test-client',
            version: '1.0.0'
        });
    });

    afterEach(async () => {
        await Promise.all([client.close(), server.close()]);
    });

    test('should register groups and list them', async () => {
        server.registerGroup('group1', {
            title: 'Group 1',
            description: 'First test group'
        });

        server.registerGroup('group2', {
            title: 'Group 2',
            description: 'Second test group'
        });

        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        const result = await client.listGroups();
        expect(result.groups).toHaveLength(2);
        expect(result.groups.find(g => g.name === 'group1')).toMatchObject({
            name: 'group1',
            title: 'Group 1',
            description: 'First test group'
        });
        expect(result.groups.find(g => g.name === 'group2')).toMatchObject({
            name: 'group2',
            title: 'Group 2',
            description: 'Second test group'
        });
    });

    test('should add tools, prompts, resources, and tasks to groups (mixed fashion)', async () => {
        server.registerGroup('mixed-group', {
            description: 'A group with different primitives'
        });

        // Add tools to the group
        server.registerTool(
            'tool1',
            {
                description: 'Test tool 1',
                _meta: {
                    [GROUPS_META_KEY]: ['mixed-group']
                }
            },
            async () => ({ content: [{ type: 'text', text: 'hi' }] })
        );

        server.registerTool('tool-no-group', { description: 'Tool with no group' }, async () => ({
            content: [{ type: 'text', text: 'hi' }]
        }));

        // Add a prompt to the same group
        server.registerPrompt(
            'prompt1',
            {
                description: 'Test prompt 1',
                _meta: {
                    [GROUPS_META_KEY]: ['mixed-group']
                }
            },
            async () => ({ messages: [] })
        );

        server.registerPrompt('prompt-no-group', { description: 'Prompt with no group' }, async () => ({ messages: [] }));

        // Add a resource to the same group
        server.registerResource(
            'resource1',
            'test://resource1',
            {
                description: 'Test resource 1',
                _meta: {
                    [GROUPS_META_KEY]: ['mixed-group']
                }
            },
            async () => ({ contents: [] })
        );

        server.registerResource('resource-no-group', 'test://resource-no-group', { description: 'Resource with no group' }, async () => ({
            contents: []
        }));

        // Add a task tool to the same group
        server.experimental.tasks.registerToolTask(
            'task-tool1',
            {
                description: 'Test task tool 1',
                _meta: {
                    [GROUPS_META_KEY]: ['mixed-group']
                }
            },
            {
                createTask: async () => {
                    throw new Error('not implemented');
                },
                getTask: async () => {
                    throw new Error('not implemented');
                },
                getTaskResult: async () => {
                    throw new Error('not implemented');
                }
            }
        );

        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        // Verify tools (including task tool)
        const toolsResult = await client.listTools();
        const tool1 = toolsResult.tools.find(t => t.name === 'tool1');
        const toolNoGroup = toolsResult.tools.find(t => t.name === 'tool-no-group');
        const taskTool1 = toolsResult.tools.find(t => t.name === 'task-tool1');

        expect(tool1?._meta?.[GROUPS_META_KEY]).toEqual(['mixed-group']);
        expect(taskTool1?._meta?.[GROUPS_META_KEY]).toEqual(['mixed-group']);
        expect(toolNoGroup?._meta?.[GROUPS_META_KEY]).toBeUndefined();

        if (toolNoGroup?._meta) {
            expect(toolNoGroup._meta).not.toHaveProperty(GROUPS_META_KEY);
        }

        // Verify prompts
        const promptsResult = await client.listPrompts();
        const prompt1 = promptsResult.prompts.find(p => p.name === 'prompt1');
        const promptNoGroup = promptsResult.prompts.find(p => p.name === 'prompt-no-group');
        expect(prompt1?._meta?.[GROUPS_META_KEY]).toEqual(['mixed-group']);
        if (promptNoGroup?._meta) {
            expect(promptNoGroup._meta).not.toHaveProperty(GROUPS_META_KEY);
        }

        // Verify resources
        const resourcesResult = await client.listResources();
        const resource1 = resourcesResult.resources.find(r => r.name === 'resource1');
        const resourceNoGroup = resourcesResult.resources.find(r => r.name === 'resource-no-group');
        expect(resource1?._meta?.[GROUPS_META_KEY]).toEqual(['mixed-group']);
        if (resourceNoGroup?._meta) {
            expect(resourceNoGroup._meta).not.toHaveProperty(GROUPS_META_KEY);
        }
    });

    test('should add a group to another group', async () => {
        server.registerGroup('parent-group', {
            description: 'A parent group'
        });

        server.registerGroup('child-group', {
            description: 'A child group',
            _meta: {
                [GROUPS_META_KEY]: ['parent-group']
            }
        });

        await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

        const result = await client.listGroups();
        const childGroup = result.groups.find(g => g.name === 'child-group');
        expect(childGroup?._meta?.[GROUPS_META_KEY]).toEqual(['parent-group']);
    });
});
