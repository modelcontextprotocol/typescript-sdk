import { describe, expect, it } from 'vitest';

import { configFromTargets, interpolateEnv, isHttpServer, parseConfig } from '../host/config';
import { contentBlockToParts, resourceToContextText, stripAnsi, toolResultToParts, truncate } from '../host/content';
import { resolveVersionOptions } from '../host/host';
import { namespaceTool, routeNamespacedTool, sanitizeServerName } from '../host/naming';

describe('tool namespacing and routing', () => {
    it('sanitizes server names the way provider tool-name rules require', () => {
        expect(sanitizeServerName('todos')).toBe('todos');
        expect(sanitizeServerName('my server.prod')).toBe('my_server_prod');
    });

    it('routes namespaced calls back to the owning server, longest key first', () => {
        const keys = ['todos', 'todos_staging'];
        expect(routeNamespacedTool(namespaceTool('todos', 'add_task'), keys)).toEqual({ serverKey: 'todos', toolName: 'add_task' });
        expect(routeNamespacedTool('mcp__todos_staging__add_task', keys)).toEqual({ serverKey: 'todos_staging', toolName: 'add_task' });
        // Tool names may themselves contain double underscores.
        expect(routeNamespacedTool('mcp__todos__weird__tool', keys)).toEqual({ serverKey: 'todos', toolName: 'weird__tool' });
        expect(routeNamespacedTool('mcp__unknown__x', keys)).toBeUndefined();
        expect(routeNamespacedTool('not-namespaced', keys)).toBeUndefined();
    });
});

describe('content conversion', () => {
    it('narrows every content block type', () => {
        expect(contentBlockToParts({ type: 'text', text: 'hi' })).toEqual([{ type: 'text', text: 'hi' }]);
        expect(contentBlockToParts({ type: 'image', data: 'abc', mimeType: 'image/png' })).toEqual([
            { type: 'image', mimeType: 'image/png', data: 'abc' }
        ]);
        expect(contentBlockToParts({ type: 'audio', data: 'abc', mimeType: 'audio/wav' })[0]?.type).toBe('text');
        expect(contentBlockToParts({ type: 'resource_link', uri: 'todos://board', name: 'board' })[0]).toMatchObject({ type: 'text' });
        expect(contentBlockToParts({ type: 'resource', resource: { uri: 'todos://board', text: 'open: 3' } })[0]).toMatchObject({
            type: 'text',
            text: expect.stringContaining('open: 3')
        });
        expect(
            contentBlockToParts({
                type: 'resource',
                resource: { uri: 'todos://blob', blob: 'aGk=', mimeType: 'application/octet-stream' }
            })[0]
        ).toMatchObject({ type: 'text', text: expect.stringContaining('binary resource') });
    });

    it('returns a placeholder for empty tool results and surfaces isError separately', () => {
        expect(toolResultToParts({ content: [] })).toEqual([{ type: 'text', text: '(tool returned no content)' }]);
    });

    it('caps injected content and labels resource context with provenance', () => {
        expect(truncate('abc', 2)).toContain('[truncated 1 characters');
        const context = resourceToContextText('todos', 'todos://board', { contents: [{ uri: 'todos://board', text: 'open: 3' }] });
        expect(context).toContain('<attached-resource server="todos" uri="todos://board">');
        expect(context).toContain('open: 3');
        const binary = resourceToContextText('todos', 'todos://blob', { contents: [{ uri: 'todos://blob', blob: 'aGVsbG8=' }] });
        expect(binary).toContain('[binary content');
    });

    it('strips ANSI escapes from server-provided text', () => {
        expect(stripAnsi('[31mred[0m plain')).toBe('red plain');
    });
});

describe('config parsing', () => {
    it('accepts stdio and http entries and interpolates environment variables', () => {
        const config = parseConfig(
            JSON.stringify({
                mcpServers: {
                    todos: { command: 'npx', args: ['-y', 'tsx', 'server.ts'], env: { API_KEY: '${TEST_TOKEN}' } },
                    remote: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${TEST_TOKEN}' } }
                }
            }),
            { TEST_TOKEN: 'sekret' }
        );
        const todos = config.mcpServers.todos;
        const remote = config.mcpServers.remote;
        expect(todos && !isHttpServer(todos) && todos.env?.API_KEY).toBe('sekret');
        expect(remote && isHttpServer(remote) && remote.headers?.Authorization).toBe('Bearer sekret');
    });

    it('rejects entries that are neither stdio nor http', () => {
        expect(() => parseConfig(JSON.stringify({ mcpServers: { broken: { nope: true } } }))).toThrow();
    });

    it('leaves unknown ${VAR} references empty', () => {
        expect(interpolateEnv('Bearer ${MISSING}', {})).toBe('Bearer ');
    });

    it('builds a config from ad-hoc --server targets', () => {
        const config = configFromTargets(['https://mcp.linear.app/mcp', 'npx -y tsx server.ts']);
        expect(config.mcpServers['linear']).toEqual({ url: 'https://mcp.linear.app/mcp' });
        expect(config.mcpServers['server']).toEqual({ command: 'npx', args: ['-y', 'tsx', 'server.ts'] });
    });

    it('rejects an empty --server list', () => {
        expect(() => configFromTargets([])).toThrow();
    });
});

describe('protocol version selection', () => {
    it('defaults to auto probing, --legacy to the plain 2025 handshake', () => {
        expect(resolveVersionOptions(false)).toEqual({ versionNegotiation: { mode: 'auto' } });
        expect(resolveVersionOptions(true)).toEqual({ versionNegotiation: { mode: 'legacy' } });
    });

    it('runs a known 2025-era revision through the legacy handshake, offering only that revision', () => {
        const expected = { versionNegotiation: { mode: 'legacy' }, supportedProtocolVersions: ['2025-06-18'] };
        expect(resolveVersionOptions(false, '2025-06-18')).toEqual(expected);
        // --legacy alongside a 2025-era revision is redundant but consistent.
        expect(resolveVersionOptions(true, '2025-06-18')).toEqual(expected);
    });

    it('pins anything newer via the modern handshake', () => {
        expect(resolveVersionOptions(false, '2026-07-28')).toEqual({ versionNegotiation: { mode: { pin: '2026-07-28' } } });
    });

    it('rejects --legacy combined with a revision the 2025 handshake cannot reach', () => {
        expect(() => resolveVersionOptions(true, '2026-07-28')).toThrow(/--legacy conflicts with --protocol-version/);
    });
});
