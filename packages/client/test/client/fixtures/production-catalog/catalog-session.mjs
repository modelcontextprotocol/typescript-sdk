/**
 * Catalogue-derived MCP fixture for the frozen 170-tool public catalog.
 * This is not the REA product. It serves schema bytes and a benign closed
 * session. It does not launch REA or inspect binaries.
 *
 * FIXTURE_MODE, when this file is the process entry:
 * - call: every tools/call returns the benign closed session
 * - malformed: the first tools/call is malformed, later calls are benign
 * - schema: the first tools/call is benign and is followed by
 *   notifications/tools/list_changed; the list then carries a replacement
 *   output schema; the second call returns the previous body; later calls
 *   return the recovery body
 */
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

import { loadProductionCatalog } from './load-catalog.mjs';

export const changedOutputSchema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    required: ['result'],
    properties: {
        result: {
            type: 'object',
            additionalProperties: false,
            required: ['open', 'receivingProbe'],
            properties: {
                open: { type: 'boolean', const: false },
                receivingProbe: { type: 'string', const: 'recovered' }
            }
        }
    }
};

export const recoveryOutput = {
    result: { open: false, receivingProbe: 'recovered' }
};

export const malformedOutput = { result: 'malformed' };

const FIXTURE_TEXT = 'catalogue-derived fixture; no binary was analyzed';

function result(structuredContent, text) {
    return {
        content: [{ type: 'text', text }],
        structuredContent,
        isError: false
    };
}

export function withChangedBinarySession(tools) {
    return tools.map(tool => (tool.name === 'binary_session' ? { ...tool, outputSchema: changedOutputSchema } : tool));
}

export function createCatalogSession({ tools, structuredContent, mode = 'call' }) {
    let changed = false;
    let calls = 0;
    return {
        setChanged(value) {
            changed = value;
        },
        listedTools() {
            return changed ? withChangedBinarySession(tools) : tools;
        },
        callResult() {
            calls += 1;
            if (mode === 'malformed' && calls === 1) return result(malformedOutput, 'malformed fixture');
            if (mode === 'schema' && calls === 2) return result(structuredContent, 'previous fixture after schema change');
            if (mode === 'schema' && calls >= 3) return result(recoveryOutput, 'recovered fixture');
            return result(structuredContent, FIXTURE_TEXT);
        },
        calls: () => calls
    };
}

export function handleMessage(session, message) {
    if (message?.jsonrpc !== '2.0' || message.id === undefined) return undefined;
    if (message.method === 'initialize') {
        return {
            jsonrpc: '2.0',
            id: message.id,
            result: {
                protocolVersion: message.params?.protocolVersion,
                capabilities: { tools: { listChanged: true } },
                serverInfo: { name: 'catalogue-derived-fixture', version: '211240' }
            }
        };
    }
    if (message.method === 'ping') {
        return { jsonrpc: '2.0', id: message.id, result: {} };
    }
    if (message.method === 'tools/list') {
        return { jsonrpc: '2.0', id: message.id, result: { tools: session.listedTools(), ttlMs: 0 } };
    }
    if (message.method === 'tools/call') {
        return { jsonrpc: '2.0', id: message.id, result: session.callResult() };
    }
    return {
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `method not found: ${message.method}` }
    };
}

function isDirectRun() {
    const entry = process.argv[1];
    return entry !== undefined && import.meta.url === pathToFileURL(entry).href;
}

async function serveStdio() {
    const { tools, structuredContent } = loadProductionCatalog();
    const mode = process.env.FIXTURE_MODE ?? 'call';
    const session = createCatalogSession({ tools, structuredContent, mode });
    const lines = createInterface({ input: process.stdin });
    lines.on('close', () => process.exit(0));
    for await (const line of lines) {
        if (line.trim() === '') continue;
        const message = JSON.parse(line);
        const response = handleMessage(session, message);
        if (response !== undefined) process.stdout.write(`${JSON.stringify(response)}\n`);
        if (mode === 'schema' && message.method === 'tools/call' && session.calls() === 1) {
            session.setChanged(true);
            process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n`);
        }
    }
}

if (isDirectRun()) void serveStdio();
