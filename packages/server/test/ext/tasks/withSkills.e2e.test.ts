/**
 * Two extensions on one server, end to end: the Skills and Tasks extensions,
 * passed together in `extensions` and served by the stateless
 * `createMcpHandler` to a real `Client`.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { SkillsClient } from '@modelcontextprotocol/client/ext/skills';
import { TasksClientExtension } from '@modelcontextprotocol/client/ext/tasks';
import { afterEach, describe, expect, it } from 'vitest';
import * as z from 'zod/v4';

import { memorySkillFiles, SkillsExtension } from '../../../src/ext/skills/index';
import { InMemoryTaskStore, TASKS_EXTENSION_ID, TasksExtension } from '../../../src/ext/tasks/index';
import { createMcpHandler, McpServer } from '../../../src/index';

const SKILL_MD = '---\nname: release-notes\ndescription: Write release notes.\n---\n# Release notes\n';

describe('Skills and Tasks extensions on one server', () => {
    let store: InMemoryTaskStore | undefined;
    afterEach(() => store?.close());

    it('serves skills and answers a tool with a task, through one client', async () => {
        store = new InMemoryTaskStore();
        const taskStore = store;
        const tasks = new TasksExtension(taskStore, { defaultPollIntervalMs: 10 });
        const skills = await SkillsExtension.load(memorySkillFiles({ 'release-notes/SKILL.md': SKILL_MD }));

        const mcpHandler = createMcpHandler(() => {
            const server = new McpServer({ name: 'skills-and-tasks', version: '1.0.0' }, { extensions: [skills, tasks] });
            server.registerTool('draft_notes', { inputSchema: z.object({ version: z.string() }) }, async ({ version }, ctx) => {
                const task = await tasks.create(ctx);
                void taskStore.handle(task.taskId).complete({ content: [{ type: 'text', text: `notes for ${version}` }] });
                return task;
            });
            return server;
        });

        const clientTasks = new TasksClientExtension();
        const client = new Client({ name: 'host', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' }, extensions: [clientTasks] });
        await client.connect(
            new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
                fetch: (url, init) => mcpHandler.fetch(new Request(url, init))
            })
        );

        expect(client.getServerCapabilities()?.extensions).toEqual({
            'io.modelcontextprotocol/skills': { directoryRead: true },
            [TASKS_EXTENSION_ID]: {}
        });

        const skillsClient = new SkillsClient(client);
        const { skills: entries } = await skillsClient.list();
        expect(entries.map(entry => entry.uri)).toEqual(['skill://release-notes/SKILL.md']);
        const [entry] = entries;
        if (entry === undefined) throw new Error('expected one skill');
        const manifest = await skillsClient.read(entry);
        expect(manifest).toMatchObject({ verified: true, text: SKILL_MD });

        const outcome = await clientTasks.callTool({ name: 'draft_notes', arguments: { version: '2.4.0' } });
        if (outcome.kind !== 'task') throw new Error('expected a task handle');
        const done = await clientTasks.waitFor(outcome.task.taskId);
        expect(done.status === 'completed' && done.result).toEqual({ content: [{ type: 'text', text: 'notes for 2.4.0' }] });

        await client.close();
    });
});
