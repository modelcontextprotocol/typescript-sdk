/**
 * Self-contained test bodies for elicitation (form and URL modes).
 *
 * Each export is a {@link TestCase}: it builds its own server, client, wires
 * them with {@link wire}, and asserts. Elicitation is a server→client request
 * flow, so tests inline `client.setRequestHandler(ElicitRequestSchema, ...)` to
 * script the responses the server will receive.
 *
 * Function names mirror the requirement id in camelCase.
 */

import { Client } from '@modelcontextprotocol/client';
import type { ElicitRequest, ElicitRequestFormParams } from '@modelcontextprotocol/server';
import {
    McpServer,
    ProtocolError,
    ProtocolErrorCode,
    Server,
    specTypeSchemas,
    UrlElicitationRequiredError
} from '@modelcontextprotocol/server';
import { expect } from 'vitest';
import { z } from 'zod/v4';

import { tapWire, wire } from '../helpers/index.js';
import { verifies } from '../helpers/verifies.js';
import type { TestArgs } from '../types.js';

/** Client with form-mode elicitation support. */
const formClient = () => new Client({ name: 'c', version: '0' }, { capabilities: { elicitation: { form: {} } } });

/** Client with form-mode elicitation AND applyDefaults support. */
const formClientWithDefaults = () =>
    new Client({ name: 'c', version: '0' }, { capabilities: { elicitation: { form: { applyDefaults: true } } } });

/** Client with URL-mode elicitation support. */
const urlClient = () => new Client({ name: 'c', version: '0' }, { capabilities: { elicitation: { url: {} } } });

verifies('elicitation:form:basic', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('ask-name', { inputSchema: z.object({}) }, async () => {
            const ans = await s.server.elicitInput({
                mode: 'form',
                message: 'What is your name?',
                requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
            });
            const name = ans.action === 'accept' ? String(ans.content?.name) : '<declined>';
            return { content: [{ type: 'text', text: `Hello, ${name}` }] };
        });
        return s;
    };

    const received: Array<{ method: string; params: unknown }> = [];
    const client = formClient();
    client.setRequestHandler('elicitation/create', async req => {
        received.push({ method: req.method, params: req.params });
        return { action: 'accept', content: { name: 'Ada' } };
    });

    await using _ = await wire(transport, makeServer, client);

    const r = await client.callTool({ name: 'ask-name', arguments: {} });

    expect(received).toHaveLength(1);
    const firstRequest = received[0];
    if (firstRequest === undefined) throw new Error('expected exactly one elicitation request');
    expect(firstRequest.method).toBe('elicitation/create');
    expect(firstRequest.params).toMatchObject({
        mode: 'form',
        message: 'What is your name?',
        requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
    });

    expect(r.isError).toBeFalsy();
    expect(r.content).toEqual([{ type: 'text', text: 'Hello, Ada' }]);
});

verifies('elicitation:form:action:accept', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('ask', { inputSchema: z.object({}) }, async () => {
            const ans = await s.server.elicitInput({
                mode: 'form',
                message: 'Enter name',
                requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
            });
            return {
                content: [{ type: 'text', text: ans.action === 'accept' ? String(ans.content?.name) : 'none' }]
            };
        });
        return s;
    };

    const client = formClient();
    client.setRequestHandler('elicitation/create', async () => {
        return { action: 'accept', content: { name: 'Ada' } };
    });

    await using _ = await wire(transport, makeServer, client);

    const r = await client.callTool({ name: 'ask', arguments: {} });
    expect(r.content).toEqual([{ type: 'text', text: 'Ada' }]);
});

verifies('elicitation:form:action:cancel', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('ask', { inputSchema: z.object({}) }, async () => {
            const ans = await s.server.elicitInput({
                mode: 'form',
                message: 'Enter name',
                requestedSchema: { type: 'object', properties: { name: { type: 'string' } } }
            });
            return {
                content: [{ type: 'text', text: `action:${ans.action},hasContent:${'content' in ans && ans.content !== undefined}` }]
            };
        });
        return s;
    };

    const client = formClient();
    client.setRequestHandler('elicitation/create', async () => {
        return { action: 'cancel' };
    });

    await using _ = await wire(transport, makeServer, client);

    const r = await client.callTool({ name: 'ask', arguments: {} });
    expect(r.content).toEqual([{ type: 'text', text: 'action:cancel,hasContent:false' }]);
});

verifies('elicitation:form:action:decline', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('ask', { inputSchema: z.object({}) }, async () => {
            const ans = await s.server.elicitInput({
                mode: 'form',
                message: 'Enter name',
                requestedSchema: { type: 'object', properties: { name: { type: 'string' } } }
            });
            return {
                content: [{ type: 'text', text: `action:${ans.action},hasContent:${'content' in ans && ans.content !== undefined}` }]
            };
        });
        return s;
    };

    const client = formClient();
    client.setRequestHandler('elicitation/create', async () => {
        return { action: 'decline' };
    });

    await using _ = await wire(transport, makeServer, client);

    const r = await client.callTool({ name: 'ask', arguments: {} });
    expect(r.content).toEqual([{ type: 'text', text: 'action:decline,hasContent:false' }]);
});

verifies('elicitation:form:defaults', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('ask', { inputSchema: z.object({}) }, async () => {
            const ans = await s.server.elicitInput({
                mode: 'form',
                message: 'Fill form',
                requestedSchema: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', default: 'anon' },
                        age: { type: 'integer', default: 42 },
                        subscribe: { type: 'boolean', default: true }
                    }
                }
            });
            return { content: [], structuredContent: ans.action === 'accept' ? ans.content : undefined };
        });
        return s;
    };

    const client = formClientWithDefaults();
    client.setRequestHandler('elicitation/create', async () => ({ action: 'accept', content: { name: 'Ada' } }));

    await using _ = await wire(transport, makeServer, client);

    const r = await client.callTool({ name: 'ask', arguments: {} });
    expect(r.structuredContent).toEqual({ name: 'Ada', age: 42, subscribe: true });
});

verifies('elicitation:form:mode-omitted-default', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new Server({ name: 's', version: '0' }, { capabilities: { tools: {} } });
        s.setRequestHandler('tools/list', () => ({ tools: [{ name: 'ask', inputSchema: { type: 'object' } }] }));
        s.setRequestHandler('tools/call', async (_req, ctx) => {
            try {
                const ans = await ctx.mcpReq.send(
                    {
                        method: 'elicitation/create',
                        params: {
                            message: 'Enter name',
                            requestedSchema: { type: 'object', properties: { name: { type: 'string' } } }
                        }
                    },
                    specTypeSchemas.ElicitResult
                );
                return { content: [{ type: 'text', text: ans.action }] };
            } catch (error) {
                if (!(error instanceof ProtocolError)) throw error;
                return { content: [{ type: 'text', text: `error:${error.code}` }] };
            }
        });
        return s;
    };

    const formReceived: ElicitRequest['params'][] = [];
    const formClientInstance = formClient();
    formClientInstance.setRequestHandler('elicitation/create', async req => {
        formReceived.push(req.params);
        return { action: 'accept', content: { name: 'Test' } };
    });

    {
        await using _ = await wire(transport, makeServer, formClientInstance);

        const formResult = await formClientInstance.callTool({ name: 'ask', arguments: {} });

        expect(formReceived).toHaveLength(1);
        const firstFormRequest = formReceived[0];
        if (firstFormRequest === undefined) throw new Error('expected exactly one form elicitation request');
        expect(firstFormRequest.mode).toBeUndefined();
        expect(formResult.content).toEqual([{ type: 'text', text: 'accept' }]);
    }

    let urlHandlerInvoked = 0;
    const urlClientInstance = urlClient();
    urlClientInstance.setRequestHandler('elicitation/create', async () => {
        urlHandlerInvoked++;
        return { action: 'accept' };
    });

    {
        await using _ = await wire(transport, makeServer, urlClientInstance);

        const urlResult = await urlClientInstance.callTool({ name: 'ask', arguments: {} });
        expect(urlResult.content).toEqual([{ type: 'text', text: `error:${ProtocolErrorCode.InvalidParams}` }]);
        expect(urlHandlerInvoked).toBe(0);
    }
});

verifies('elicitation:form:schema:primitives', async ({ transport }: TestArgs) => {
    const requestedSchema: ElicitRequestFormParams['requestedSchema'] = {
        type: 'object',
        properties: {
            name: { type: 'string' },
            email: { type: 'string', format: 'email' },
            age: { type: 'integer' },
            score: { type: 'number' },
            active: { type: 'boolean' }
        }
    };
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('ask', { inputSchema: z.object({}) }, async () => {
            const ans = await s.server.elicitInput({ mode: 'form', message: 'Fill form', requestedSchema });
            return { content: [], structuredContent: ans.action === 'accept' ? ans.content : undefined };
        });
        return s;
    };

    const expected = { name: 'Ada', email: 'ada@example.com', age: 30, score: 95.5, active: true };
    const received: ElicitRequest['params'][] = [];
    const client = formClient();
    client.setRequestHandler('elicitation/create', async req => {
        received.push(req.params);
        return { action: 'accept', content: expected };
    });

    await using _ = await wire(transport, makeServer, client);

    const r = await client.callTool({ name: 'ask', arguments: {} });
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ mode: 'form', message: 'Fill form', requestedSchema });
    expect(r.structuredContent).toEqual(expected);
});

verifies('elicitation:form:schema:enum-variants', async ({ transport }: TestArgs) => {
    const requestedSchema: ElicitRequestFormParams['requestedSchema'] = {
        type: 'object',
        properties: {
            bare: { type: 'string', enum: ['Red', 'Green', 'Blue'] },
            titled: {
                type: 'string',
                oneOf: [
                    { const: '#FF0000', title: 'Red' },
                    { const: '#00FF00', title: 'Green' }
                ]
            },
            multi: {
                type: 'array',
                items: {
                    anyOf: [
                        { const: '#FF0000', title: 'Red' },
                        { const: '#0000FF', title: 'Blue' }
                    ]
                }
            }
        }
    };
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('ask', { inputSchema: z.object({}) }, async () => {
            const ans = await s.server.elicitInput({ mode: 'form', message: 'Pick colors', requestedSchema });
            return { content: [], structuredContent: ans.action === 'accept' ? ans.content : undefined };
        });
        return s;
    };

    const expected = { bare: 'Red', titled: '#00FF00', multi: ['#FF0000', '#0000FF'] };
    const received: ElicitRequest['params'][] = [];
    const client = formClient();
    client.setRequestHandler('elicitation/create', async req => {
        received.push(req.params);
        return { action: 'accept', content: expected };
    });

    await using _ = await wire(transport, makeServer, client);

    const r = await client.callTool({ name: 'ask', arguments: {} });
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ mode: 'form', message: 'Pick colors', requestedSchema });
    expect(r.structuredContent).toEqual(expected);
});

verifies('elicitation:form:response-validation', async ({ transport }: TestArgs) => {
    const requestedSchema: ElicitRequestFormParams['requestedSchema'] = {
        type: 'object',
        properties: { username: { type: 'string' } },
        required: ['username']
    };
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('signup', { inputSchema: z.object({}) }, async () => {
            try {
                const ans = await s.server.elicitInput({ mode: 'form', message: 'Choose a username', requestedSchema });
                return {
                    isError: true,
                    content: [{ type: 'text', text: `SDK accepted invalid content: ${JSON.stringify(ans.content)}` }]
                };
            } catch (error) {
                if (!(error instanceof ProtocolError)) throw error;
                return { content: [{ type: 'text', text: `rejected:${error.code}:${error.message}` }] };
            }
        });
        return s;
    };

    // Each accepted response violates the requested schema: wrong type for `username`, then missing required `username`.
    const invalidContents: Array<Record<string, string | number | boolean>> = [{ username: 42 }, {}];
    let handlerInvoked = 0;
    const client = formClient();
    client.setRequestHandler('elicitation/create', async () => {
        const content = invalidContents[handlerInvoked];
        handlerInvoked++;
        return { action: 'accept', content };
    });

    await using _ = await wire(transport, makeServer, client);

    const schemaRejection = expect.stringMatching(
        new RegExp(`^rejected:${ProtocolErrorCode.InvalidParams}:.*does not match requested schema`)
    );

    const wrongType = await client.callTool({ name: 'signup', arguments: {} });
    expect(wrongType.isError).toBeFalsy();
    expect(wrongType.content).toEqual([{ type: 'text', text: schemaRejection }]);

    const missingRequired = await client.callTool({ name: 'signup', arguments: {} });
    expect(missingRequired.isError).toBeFalsy();
    expect(missingRequired.content).toEqual([{ type: 'text', text: schemaRejection }]);

    expect(handlerInvoked).toBe(2);
});

verifies('elicitation:form:schema:restricted-subset', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new Server({ name: 's', version: '0' }, { capabilities: { tools: {} } });
        s.setRequestHandler('tools/list', () => ({ tools: [{ name: 'profile', inputSchema: { type: 'object' } }] }));
        s.setRequestHandler('tools/call', async (_req, ctx) => {
            try {
                await ctx.mcpReq.send(
                    {
                        method: 'elicitation/create',
                        params: {
                            mode: 'form',
                            message: 'Profile details',
                            requestedSchema: {
                                type: 'object',
                                properties: {
                                    address: {
                                        type: 'object',
                                        properties: { street: { type: 'string' }, city: { type: 'string' } }
                                    },
                                    contacts: {
                                        type: 'array',
                                        items: { type: 'object', properties: { name: { type: 'string' } } }
                                    }
                                }
                            }
                        }
                    },
                    specTypeSchemas.ElicitResult
                );
                return { content: [{ type: 'text', text: 'should-not-reach' }] };
            } catch (error) {
                if (!(error instanceof ProtocolError)) throw error;
                return { content: [{ type: 'text', text: `error:${error.code}` }] };
            }
        });
        return s;
    };

    let handlerInvoked = 0;
    const client = formClient();
    client.setRequestHandler('elicitation/create', async () => {
        handlerInvoked++;
        return { action: 'accept', content: {} };
    });

    // strictValidation off: the nested requestedSchema deliberately violates the spec's flat-primitive restriction on the wire.
    await using _ = await wire(transport, makeServer, client, { strictValidation: false });

    const r = await client.callTool({ name: 'profile', arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(r.content).toEqual([{ type: 'text', text: `error:${ProtocolErrorCode.InvalidParams}` }]);
    expect(handlerInvoked).toBe(0);
});

verifies('elicitation:url:basic', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('auth', { inputSchema: z.object({}) }, async () => {
            const ans = await s.server.elicitInput({
                mode: 'url',
                message: 'Please sign in',
                elicitationId: 'url-1',
                url: 'https://example.com/auth?state=test'
            });
            return { content: [{ type: 'text', text: ans.action }] };
        });
        return s;
    };

    const received: ElicitRequest['params'][] = [];
    const client = urlClient();
    client.setRequestHandler('elicitation/create', async req => {
        received.push(req.params);
        return { action: 'accept' };
    });

    await using _ = await wire(transport, makeServer, client);

    const r = await client.callTool({ name: 'auth', arguments: {} });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
        mode: 'url',
        message: 'Please sign in',
        elicitationId: 'url-1',
        url: 'https://example.com/auth?state=test'
    });
    expect(r.content).toEqual([{ type: 'text', text: 'accept' }]);
});

verifies('elicitation:url:action:accept-no-content', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('auth', { inputSchema: z.object({}) }, async () => {
            const ans = await s.server.elicitInput({
                mode: 'url',
                message: 'Please sign in',
                elicitationId: 'url-2',
                url: 'https://example.com/auth'
            });
            return {
                content: [{ type: 'text', text: `action:${ans.action},hasContent:${'content' in ans && ans.content !== undefined}` }]
            };
        });
        return s;
    };

    const client = urlClient();
    client.setRequestHandler('elicitation/create', async () => ({ action: 'accept' }));

    await using _ = await wire(transport, makeServer, client);

    const r = await client.callTool({ name: 'auth', arguments: {} });
    expect(r.content).toEqual([{ type: 'text', text: 'action:accept,hasContent:false' }]);
});

verifies('elicitation:url:action:cancel', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('auth', { inputSchema: z.object({}) }, async () => {
            const ans = await s.server.elicitInput({
                mode: 'url',
                message: 'Please sign in',
                elicitationId: 'url-cancel-1',
                url: 'https://example.com/auth'
            });
            return {
                content: [{ type: 'text', text: `action:${ans.action},hasContent:${'content' in ans && ans.content !== undefined}` }]
            };
        });
        return s;
    };

    const client = urlClient();
    client.setRequestHandler('elicitation/create', async () => ({ action: 'cancel' }));

    await using _ = await wire(transport, makeServer, client);

    const r = await client.callTool({ name: 'auth', arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(r.content).toEqual([{ type: 'text', text: 'action:cancel,hasContent:false' }]);
});

verifies('elicitation:url:action:decline', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('auth', { inputSchema: z.object({}) }, async () => {
            const ans = await s.server.elicitInput({
                mode: 'url',
                message: 'Please sign in',
                elicitationId: 'url-decline-1',
                url: 'https://example.com/auth'
            });
            return {
                content: [{ type: 'text', text: `action:${ans.action},hasContent:${'content' in ans && ans.content !== undefined}` }]
            };
        });
        return s;
    };

    const client = urlClient();
    client.setRequestHandler('elicitation/create', async () => ({ action: 'decline' }));

    await using _ = await wire(transport, makeServer, client);

    const r = await client.callTool({ name: 'auth', arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(r.content).toEqual([{ type: 'text', text: 'action:decline,hasContent:false' }]);
});

verifies('elicitation:url:complete-notification', async ({ transport }: TestArgs) => {
    const notifications: Array<{ method: string; params: unknown }> = [];

    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('auth', { inputSchema: z.object({}) }, async () => {
            throw new UrlElicitationRequiredError([
                {
                    mode: 'url',
                    message: 'Sign in required',
                    elicitationId: 'complete-1',
                    url: 'https://example.com/auth'
                }
            ]);
        });
        s.registerTool('complete', { inputSchema: z.object({ elicitationId: z.string() }) }, async ({ elicitationId }, ctx) => {
            const notify = s.server.createElicitationCompletionNotifier(elicitationId, { relatedRequestId: ctx.mcpReq.id });
            await notify();
            return { content: [{ type: 'text', text: 'notified' }] };
        });
        return s;
    };

    const client = urlClient();
    client.setNotificationHandler('notifications/elicitation/complete', n => {
        notifications.push({ method: n.method, params: n.params });
    });

    await using _ = await wire(transport, makeServer, client);

    const err = await client.callTool({ name: 'auth', arguments: {} }).catch(error => error);
    if (!(err instanceof UrlElicitationRequiredError)) throw new Error(`expected UrlElicitationRequiredError, got ${err}`);
    const pending = err.elicitations[0];
    if (pending === undefined) throw new Error('expected one pending elicitation');
    const elicitationId = pending.elicitationId;

    await client.callTool({ name: 'complete', arguments: { elicitationId } });

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toEqual({
        method: 'notifications/elicitation/complete',
        params: { elicitationId: 'complete-1' }
    });
});

verifies('elicitation:url:complete-unknown-ignored', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('auth', { inputSchema: z.object({}) }, () => {
            throw new UrlElicitationRequiredError([
                { mode: 'url', message: 'Sign in required', elicitationId: 'seen-1', url: 'https://example.com/auth' }
            ]);
        });
        // Raw send: the server-side capability gate cannot pass on stateless (client capabilities never learned),
        // and the behavior under test is the client's handling of the notification.
        s.registerTool('complete', { inputSchema: z.object({ elicitationId: z.string() }) }, async ({ elicitationId }, ctx) => {
            const tx = s.server.transport;
            if (!tx) throw new Error('server transport not connected');
            await tx.send(
                { jsonrpc: '2.0', method: 'notifications/elicitation/complete', params: { elicitationId } },
                { relatedRequestId: ctx.mcpReq.id }
            );
            return { content: [{ type: 'text', text: 'sent' }] };
        });
        s.registerTool('noop', { inputSchema: z.object({}) }, () => ({ content: [] }));
        return s;
    };

    const notifications: Array<{ method: string; params: unknown }> = [];
    const errors: Error[] = [];
    const client = urlClient();
    client.onerror = e => errors.push(e);
    client.setNotificationHandler('notifications/elicitation/complete', n => {
        notifications.push({ method: n.method, params: n.params });
    });

    await using _ = await wire(transport, makeServer, client);

    const err = await client.callTool({ name: 'auth', arguments: {} }).catch(error => error);
    if (!(err instanceof UrlElicitationRequiredError)) throw new Error(`expected UrlElicitationRequiredError, got ${err}`);
    const seenPending = err.elicitations[0];
    if (seenPending === undefined) throw new Error('expected one pending elicitation');
    const seenId = seenPending.elicitationId;

    await client.callTool({ name: 'complete', arguments: { elicitationId: seenId } });
    // Already-completed id, then an id the client never saw: both must be ignored without error.
    await client.callTool({ name: 'complete', arguments: { elicitationId: seenId } });
    await client.callTool({ name: 'complete', arguments: { elicitationId: 'never-issued' } });

    expect(notifications).toEqual([
        { method: 'notifications/elicitation/complete', params: { elicitationId: 'seen-1' } },
        { method: 'notifications/elicitation/complete', params: { elicitationId: 'seen-1' } },
        { method: 'notifications/elicitation/complete', params: { elicitationId: 'never-issued' } }
    ]);
    expect(errors).toEqual([]);

    const after = await client.callTool({ name: 'noop', arguments: {} });
    expect(after.isError).toBeFalsy();
    expect(after.content).toEqual([]);
});

verifies('elicitation:url:required-error', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('auth-required', { inputSchema: z.object({}) }, () => {
            throw new UrlElicitationRequiredError([
                {
                    mode: 'url',
                    message: 'Please authenticate',
                    elicitationId: 'err-1',
                    url: 'https://example.com/oauth'
                }
            ]);
        });
        return s;
    };

    const client = urlClient();
    await using _ = await wire(transport, makeServer, client);

    const err = await client.callTool({ name: 'auth-required', arguments: {} }).catch(error => error);
    if (!(err instanceof UrlElicitationRequiredError)) throw new Error(`expected UrlElicitationRequiredError, got ${err}`);
    expect(err.code).toBe(ProtocolErrorCode.UrlElicitationRequired);
    expect(err.elicitations).toHaveLength(1);
    expect(err.elicitations[0]).toMatchObject({
        mode: 'url',
        message: 'Please authenticate',
        elicitationId: 'err-1',
        url: 'https://example.com/oauth'
    });
});

verifies('elicitation:capability:empty-is-form', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('ask', { inputSchema: z.object({}) }, async () => {
            const ans = await s.server.elicitInput({
                mode: 'form',
                message: 'Name?',
                requestedSchema: { type: 'object', properties: { name: { type: 'string' } } }
            });
            return { content: [{ type: 'text', text: ans.action }] };
        });
        return s;
    };

    const client = new Client({ name: 'c', version: '0' }, { capabilities: { elicitation: {} } });
    client.setRequestHandler('elicitation/create', async () => {
        return { action: 'accept', content: { name: 'Test' } };
    });

    await using _ = await wire(transport, makeServer, client);

    const r = await client.callTool({ name: 'ask', arguments: {} });
    expect(r.content).toEqual([{ type: 'text', text: 'accept' }]);
});

verifies('elicitation:capability:mode-mismatch', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new Server({ name: 's', version: '0' }, { capabilities: { tools: {} } });
        s.setRequestHandler('tools/list', () => ({ tools: [{ name: 'auth', inputSchema: { type: 'object' } }] }));
        s.setRequestHandler('tools/call', async (_req, ctx) => {
            try {
                await ctx.mcpReq.send(
                    {
                        method: 'elicitation/create',
                        params: { mode: 'url', message: 'Sign in', elicitationId: 'mismatch-1', url: 'https://example.com/auth' }
                    },
                    specTypeSchemas.ElicitResult
                );
                return { content: [{ type: 'text', text: 'should-not-reach' }] };
            } catch (error) {
                if (!(error instanceof ProtocolError)) throw error;
                return { content: [{ type: 'text', text: `error:${error.code}` }] };
            }
        });
        return s;
    };

    let handlerInvoked = 0;
    const client = formClient();
    client.setRequestHandler('elicitation/create', async () => {
        handlerInvoked++;
        return { action: 'accept', content: {} };
    });

    await using _ = await wire(transport, makeServer, client);

    const r = await client.callTool({ name: 'auth', arguments: {} });
    expect(r.content).toEqual([{ type: 'text', text: `error:${ProtocolErrorCode.InvalidParams}` }]);
    expect(handlerInvoked).toBe(0);
});

verifies('elicitation:capability:server-respects-mode', async ({ transport }: TestArgs) => {
    let reachedClient = 0;
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('auth', { inputSchema: z.object({}) }, async () => {
            try {
                await s.server.elicitInput({
                    mode: 'url',
                    message: 'Sign in',
                    elicitationId: 'gate-1',
                    url: 'https://example.com/auth'
                });
                return { isError: true, content: [{ type: 'text', text: 'SDK let it through' }] };
            } catch (error) {
                return { content: [{ type: 'text', text: `refused:${error instanceof Error ? error.message : error}` }] };
            }
        });
        return s;
    };

    const client = formClient();
    client.setRequestHandler('elicitation/create', async () => {
        reachedClient++;
        return { action: 'accept' };
    });

    await using _ = await wire(transport, makeServer, client);

    const r = await client.callTool({ name: 'auth', arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(r.content).toEqual([{ type: 'text', text: expect.stringMatching(/^refused:.*url elicitation/i) }]);
    expect(reachedClient).toBe(0);
});

verifies('elicitation:capability:not-declared', async ({ transport }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('ask-form', { inputSchema: z.object({}) }, async () => {
            try {
                await s.server.elicitInput({
                    mode: 'form',
                    message: 'What is your name?',
                    requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
                });
                return { isError: true, content: [{ type: 'text', text: 'SDK let the form elicitation through' }] };
            } catch (error) {
                return { content: [{ type: 'text', text: `refused:${error instanceof Error ? error.message : error}` }] };
            }
        });
        s.registerTool('ask-url', { inputSchema: z.object({}) }, async () => {
            try {
                await s.server.elicitInput({
                    mode: 'url',
                    message: 'Please sign in',
                    elicitationId: 'no-cap-1',
                    url: 'https://example.com/auth'
                });
                return { isError: true, content: [{ type: 'text', text: 'SDK let the url elicitation through' }] };
            } catch (error) {
                return { content: [{ type: 'text', text: `refused:${error instanceof Error ? error.message : error}` }] };
            }
        });
        return s;
    };

    // No elicitation capability declared at all — neither mode may reach the wire.
    const client = new Client({ name: 'c', version: '0' });

    await using _ = await wire(transport, makeServer, client);
    const tap = tapWire(client);

    const form = await client.callTool({ name: 'ask-form', arguments: {} });
    expect(form.isError).toBeFalsy();
    expect(form.content).toEqual([{ type: 'text', text: 'refused:Client does not support form elicitation.' }]);

    const url = await client.callTool({ name: 'ask-url', arguments: {} });
    expect(url.isError).toBeFalsy();
    expect(url.content).toEqual([{ type: 'text', text: 'refused:Client does not support url elicitation.' }]);

    expect(tap.received.filter(m => 'method' in m && m.method === 'elicitation/create')).toEqual([]);
});
