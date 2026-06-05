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

import { expect } from 'vitest';
import { z } from 'zod/v4';

import { Client } from '../../../src/client/index.js';
import { Server } from '../../../src/server/index.js';
import { McpServer } from '../../../src/server/mcp.js';
import {
    CallToolRequestSchema,
    ElicitationCompleteNotificationSchema,
    type ElicitRequest,
    type ElicitRequestFormParams,
    ElicitRequestSchema,
    ElicitResultSchema,
    ErrorCode,
    ListToolsRequestSchema,
    McpError,
    UrlElicitationRequiredError
} from '../../../src/types.js';

import { tapWire, wire } from '../helpers/index.js';
import type { TestArgs } from '../types.js';
import { verifies } from '../helpers/verifies.js';

/** Client with form-mode elicitation support. */
const formClient = () => new Client({ name: 'c', version: '0' }, { capabilities: { elicitation: { form: {} } } });

/** Client with form-mode elicitation AND applyDefaults support. */
const formClientWithDefaults = () =>
    new Client({ name: 'c', version: '0' }, { capabilities: { elicitation: { form: { applyDefaults: true } } } });

/** Client with URL-mode elicitation support. */
const urlClient = () => new Client({ name: 'c', version: '0' }, { capabilities: { elicitation: { url: {} } } });

verifies('elicitation:form:basic', async ({ transport, protocolVersion }: TestArgs) => {
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
    client.setRequestHandler(ElicitRequestSchema, async req => {
        received.push({ method: req.method, params: req.params });
        return { action: 'accept', content: { name: 'Ada' } };
    });

    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const r = await client.callTool({ name: 'ask-name', arguments: {} });

    expect(received).toHaveLength(1);
    expect(received[0].method).toBe('elicitation/create');
    expect(received[0].params).toMatchObject({
        mode: 'form',
        message: 'What is your name?',
        requestedSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }
    });

    expect(r.isError).toBeFalsy();
    expect(r.content).toEqual([{ type: 'text', text: 'Hello, Ada' }]);
});

verifies('elicitation:form:action:accept', async ({ transport, protocolVersion }: TestArgs) => {
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
    client.setRequestHandler(ElicitRequestSchema, async () => {
        return { action: 'accept', content: { name: 'Ada' } };
    });

    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const r = await client.callTool({ name: 'ask', arguments: {} });
    expect(r.content).toEqual([{ type: 'text', text: 'Ada' }]);
});

verifies('elicitation:form:action:cancel', async ({ transport, protocolVersion }: TestArgs) => {
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
    client.setRequestHandler(ElicitRequestSchema, async () => {
        return { action: 'cancel' };
    });

    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const r = await client.callTool({ name: 'ask', arguments: {} });
    expect(r.content).toEqual([{ type: 'text', text: 'action:cancel,hasContent:false' }]);
});

verifies('elicitation:form:action:decline', async ({ transport, protocolVersion }: TestArgs) => {
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
    client.setRequestHandler(ElicitRequestSchema, async () => {
        return { action: 'decline' };
    });

    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const r = await client.callTool({ name: 'ask', arguments: {} });
    expect(r.content).toEqual([{ type: 'text', text: 'action:decline,hasContent:false' }]);
});

verifies('elicitation:form:defaults', async ({ transport, protocolVersion }: TestArgs) => {
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
    client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'accept', content: { name: 'Ada' } }));

    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const r = await client.callTool({ name: 'ask', arguments: {} });
    expect(r.structuredContent).toEqual({ name: 'Ada', age: 42, subscribe: true });
});

verifies('elicitation:form:mode-omitted-default', async ({ transport, protocolVersion }: TestArgs) => {
    const makeServer = () => {
        const s = new Server({ name: 's', version: '0' }, { capabilities: { tools: {} } });
        s.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{ name: 'ask', inputSchema: { type: 'object' } }] }));
        s.setRequestHandler(CallToolRequestSchema, async (_req, extra) => {
            try {
                const ans = await extra.sendRequest(
                    {
                        method: 'elicitation/create',
                        params: {
                            message: 'Enter name',
                            requestedSchema: { type: 'object', properties: { name: { type: 'string' } } }
                        }
                    },
                    ElicitResultSchema
                );
                return { content: [{ type: 'text', text: ans.action }] };
            } catch (e) {
                if (!(e instanceof McpError)) throw e;
                return { content: [{ type: 'text', text: `error:${e.code}` }] };
            }
        });
        return s;
    };

    const formReceived: ElicitRequest['params'][] = [];
    const formClientInstance = formClient();
    formClientInstance.setRequestHandler(ElicitRequestSchema, async req => {
        formReceived.push(req.params);
        return { action: 'accept', content: { name: 'Test' } };
    });

    await using _1 = await wire({ transport, protocolVersion }, makeServer, formClientInstance);

    const formResult = await formClientInstance.callTool({ name: 'ask', arguments: {} });

    expect(formReceived).toHaveLength(1);
    expect(formReceived[0].mode).toBeUndefined();
    expect(formResult.content).toEqual([{ type: 'text', text: 'accept' }]);

    let urlHandlerInvoked = 0;
    const urlClientInstance = urlClient();
    urlClientInstance.setRequestHandler(ElicitRequestSchema, async () => {
        urlHandlerInvoked++;
        return { action: 'accept' };
    });

    await using _2 = await wire({ transport, protocolVersion }, makeServer, urlClientInstance);

    const urlResult = await urlClientInstance.callTool({ name: 'ask', arguments: {} });
    expect(urlResult.content).toEqual([{ type: 'text', text: `error:${ErrorCode.InvalidParams}` }]);
    expect(urlHandlerInvoked).toBe(0);
});

verifies('elicitation:form:schema:primitives', async ({ transport, protocolVersion }: TestArgs) => {
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
    client.setRequestHandler(ElicitRequestSchema, async req => {
        received.push(req.params);
        return { action: 'accept', content: expected };
    });

    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const r = await client.callTool({ name: 'ask', arguments: {} });
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ mode: 'form', message: 'Fill form', requestedSchema });
    expect(r.structuredContent).toEqual(expected);
});

verifies('elicitation:form:schema:enum-variants', async ({ transport, protocolVersion }: TestArgs) => {
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
    client.setRequestHandler(ElicitRequestSchema, async req => {
        received.push(req.params);
        return { action: 'accept', content: expected };
    });

    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const r = await client.callTool({ name: 'ask', arguments: {} });
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual({ mode: 'form', message: 'Pick colors', requestedSchema });
    expect(r.structuredContent).toEqual(expected);
});

verifies('elicitation:form:response-validation', async ({ transport, protocolVersion }: TestArgs) => {
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
            } catch (e) {
                if (!(e instanceof McpError)) throw e;
                return { content: [{ type: 'text', text: `rejected:${e.code}:${e.message}` }] };
            }
        });
        return s;
    };

    // Each accepted response violates the requested schema: wrong type for `username`, then missing required `username`.
    const invalidContents: Array<Record<string, string | number | boolean>> = [{ username: 42 }, {}];
    let handlerInvoked = 0;
    const client = formClient();
    client.setRequestHandler(ElicitRequestSchema, async () => {
        const content = invalidContents[handlerInvoked];
        handlerInvoked++;
        return { action: 'accept', content };
    });

    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const schemaRejection = expect.stringMatching(new RegExp(`^rejected:${ErrorCode.InvalidParams}:.*does not match requested schema`));

    const wrongType = await client.callTool({ name: 'signup', arguments: {} });
    expect(wrongType.isError).toBeFalsy();
    expect(wrongType.content).toEqual([{ type: 'text', text: schemaRejection }]);

    const missingRequired = await client.callTool({ name: 'signup', arguments: {} });
    expect(missingRequired.isError).toBeFalsy();
    expect(missingRequired.content).toEqual([{ type: 'text', text: schemaRejection }]);

    expect(handlerInvoked).toBe(2);
});

verifies('elicitation:form:schema:restricted-subset', async ({ transport, protocolVersion }: TestArgs) => {
    const makeServer = () => {
        const s = new Server({ name: 's', version: '0' }, { capabilities: { tools: {} } });
        s.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{ name: 'profile', inputSchema: { type: 'object' } }] }));
        s.setRequestHandler(CallToolRequestSchema, async (_req, extra) => {
            try {
                await extra.sendRequest(
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
                    ElicitResultSchema
                );
                return { content: [{ type: 'text', text: 'should-not-reach' }] };
            } catch (e) {
                if (!(e instanceof McpError)) throw e;
                return { content: [{ type: 'text', text: `error:${e.code}` }] };
            }
        });
        return s;
    };

    let handlerInvoked = 0;
    const client = formClient();
    client.setRequestHandler(ElicitRequestSchema, async () => {
        handlerInvoked++;
        return { action: 'accept', content: {} };
    });

    // strictValidation off: the nested requestedSchema deliberately violates the spec's flat-primitive restriction on the wire.
    await using _ = await wire({ transport, protocolVersion }, makeServer, client, { strictValidation: false });

    const r = await client.callTool({ name: 'profile', arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(r.content).toEqual([{ type: 'text', text: `error:${ErrorCode.InvalidParams}` }]);
    expect(handlerInvoked).toBe(0);
});

verifies('elicitation:url:basic', async ({ transport, protocolVersion }: TestArgs) => {
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
    client.setRequestHandler(ElicitRequestSchema, async req => {
        received.push(req.params);
        return { action: 'accept' };
    });

    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

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

verifies('elicitation:url:action:accept-no-content', async ({ transport, protocolVersion }: TestArgs) => {
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
    client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'accept' }));

    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const r = await client.callTool({ name: 'auth', arguments: {} });
    expect(r.content).toEqual([{ type: 'text', text: 'action:accept,hasContent:false' }]);
});

verifies(
    'elicitation:url:action:accept-no-content',
    async ({ transport, protocolVersion }: TestArgs) => {
        // The SDK has no url-mode content enforcement: the client wrapper validates only the mode-agnostic
        // ElicitResultSchema and the elicitInput url branch returns the result unvalidated. This arm pins the
        // pass-through, so if either side ever starts stripping or rejecting content on a url-mode accept, the
        // change shows up here and gets a conscious review instead of shipping silently.
        const makeServer = () => {
            const s = new McpServer({ name: 's', version: '0' });
            s.registerTool('auth', { inputSchema: z.object({}) }, async () => {
                const ans = await s.server.elicitInput({
                    mode: 'url',
                    message: 'Please sign in',
                    elicitationId: 'url-3',
                    url: 'https://example.com/auth'
                });
                return {
                    content: [{ type: 'text', text: `action:${ans.action},content:${JSON.stringify(ans.content)}` }]
                };
            });
            return s;
        };

        const client = urlClient();
        client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'accept', content: { note: 'should-be-absent' } }));

        await using _ = await wire({ transport, protocolVersion }, makeServer, client);

        const r = await client.callTool({ name: 'auth', arguments: {} });
        expect(r.content).toEqual([{ type: 'text', text: 'action:accept,content:{"note":"should-be-absent"}' }]);
    },
    { title: 'content-passthrough' }
);

verifies('elicitation:url:action:cancel', async ({ transport, protocolVersion }: TestArgs) => {
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
    client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'cancel' }));

    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const r = await client.callTool({ name: 'auth', arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(r.content).toEqual([{ type: 'text', text: 'action:cancel,hasContent:false' }]);
});

verifies('elicitation:url:action:decline', async ({ transport, protocolVersion }: TestArgs) => {
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
    client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'decline' }));

    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const r = await client.callTool({ name: 'auth', arguments: {} });
    expect(r.isError).toBeFalsy();
    expect(r.content).toEqual([{ type: 'text', text: 'action:decline,hasContent:false' }]);
});

verifies('elicitation:url:complete-notification', async ({ transport, protocolVersion }: TestArgs) => {
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
        s.registerTool('complete', { inputSchema: z.object({ elicitationId: z.string() }) }, async ({ elicitationId }, extra) => {
            const notify = s.server.createElicitationCompletionNotifier(elicitationId, { relatedRequestId: extra.requestId });
            await notify();
            return { content: [{ type: 'text', text: 'notified' }] };
        });
        return s;
    };

    const client = urlClient();
    client.setNotificationHandler(ElicitationCompleteNotificationSchema, n => {
        notifications.push({ method: n.method, params: n.params });
    });

    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const err = await client.callTool({ name: 'auth', arguments: {} }).catch(e => e);
    if (!(err instanceof UrlElicitationRequiredError)) throw new Error(`expected UrlElicitationRequiredError, got ${err}`);
    const elicitationId = err.elicitations[0].elicitationId;

    await client.callTool({ name: 'complete', arguments: { elicitationId } });

    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toEqual({
        method: 'notifications/elicitation/complete',
        params: { elicitationId: 'complete-1' }
    });
});

verifies('elicitation:url:complete-unknown-ignored', async ({ transport, protocolVersion }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('auth', { inputSchema: z.object({}) }, () => {
            throw new UrlElicitationRequiredError([
                { mode: 'url', message: 'Sign in required', elicitationId: 'seen-1', url: 'https://example.com/auth' }
            ]);
        });
        // Raw send: the server-side capability gate cannot pass on stateless (client capabilities never learned),
        // and the behavior under test is the client's handling of the notification.
        s.registerTool('complete', { inputSchema: z.object({ elicitationId: z.string() }) }, async ({ elicitationId }, extra) => {
            await s.server.transport!.send(
                { jsonrpc: '2.0', method: 'notifications/elicitation/complete', params: { elicitationId } },
                { relatedRequestId: extra.requestId }
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
    // Observed via fallbackNotificationHandler, NOT setNotificationHandler: a specific registration would Map.set-
    // REPLACE any future built-in notifications/elicitation/complete handler (none exists at tip), hiding exactly
    // the strictness regression this cell exists to catch. With the fallback, a built-in handler that starts
    // erroring on unknown/completed ids keeps its place and surfaces through errors[]; a built-in that swallows the
    // notifications flips the delivery assert below, flagging the displacement for a conscious re-point.
    client.fallbackNotificationHandler = async n => {
        notifications.push({ method: n.method, params: n.params });
    };

    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const err = await client.callTool({ name: 'auth', arguments: {} }).catch(e => e);
    if (!(err instanceof UrlElicitationRequiredError)) throw new Error(`expected UrlElicitationRequiredError, got ${err}`);
    const seenId = err.elicitations[0].elicitationId;

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

    // Session still fully live after the ignored notifications: request roundtrips in both shapes succeed.
    const after = await client.callTool({ name: 'noop', arguments: {} });
    expect(after.isError).toBeFalsy();
    expect(after.content).toEqual([]);
    await expect(client.ping()).resolves.toBeDefined();
});

verifies('elicitation:url:required-error', async ({ transport, protocolVersion }: TestArgs) => {
    // Two pending elicitations: the spec says the error data includes a LIST, so N≥2 must round-trip, not just a singleton.
    const pending = [
        {
            mode: 'url' as const,
            message: 'Please authenticate',
            elicitationId: 'err-1',
            url: 'https://example.com/oauth'
        },
        {
            mode: 'url' as const,
            message: 'Please link your account',
            elicitationId: 'err-2',
            url: 'https://example.com/link'
        }
    ];
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('auth-required', { inputSchema: z.object({}) }, () => {
            throw new UrlElicitationRequiredError(pending);
        });
        return s;
    };

    const client = urlClient();
    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const err = await client.callTool({ name: 'auth-required', arguments: {} }).catch(e => e);
    if (!(err instanceof UrlElicitationRequiredError)) throw new Error(`expected UrlElicitationRequiredError, got ${err}`);
    expect(err.code).toBe(ErrorCode.UrlElicitationRequired);
    expect(err.elicitations).toEqual(pending);
});

verifies(
    'elicitation:url:required-error',
    async ({ transport, protocolVersion }: TestArgs) => {
        // Non-tool sibling: tools/call is the ONLY McpServer wrapper that catches handler errors into isError
        // results and special-cases -32042 to rethrow. resources/read has no catch wrapper, so the thrown error
        // takes the plain protocol error path — this arm locks that the -32042 contract holds there too.
        const makeServer = () => {
            const s = new McpServer({ name: 's', version: '0' });
            s.registerResource('gated', 'gated://doc', {}, () => {
                throw new UrlElicitationRequiredError([
                    { mode: 'url', message: 'Please authenticate', elicitationId: 'res-err-1', url: 'https://example.com/oauth' }
                ]);
            });
            return s;
        };

        const client = urlClient();
        await using _ = await wire({ transport, protocolVersion }, makeServer, client);

        const err = await client.readResource({ uri: 'gated://doc' }).catch(e => e);
        if (!(err instanceof UrlElicitationRequiredError)) throw new Error(`expected UrlElicitationRequiredError, got ${err}`);
        expect(err.code).toBe(ErrorCode.UrlElicitationRequired);
        expect(err.elicitations).toEqual([
            { mode: 'url', message: 'Please authenticate', elicitationId: 'res-err-1', url: 'https://example.com/oauth' }
        ]);
    },
    { title: 'resource-handler' }
);

verifies('elicitation:capability:empty-is-form', async ({ transport, protocolVersion }: TestArgs) => {
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
    client.setRequestHandler(ElicitRequestSchema, async () => {
        return { action: 'accept', content: { name: 'Test' } };
    });

    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const r = await client.callTool({ name: 'ask', arguments: {} });
    expect(r.content).toEqual([{ type: 'text', text: 'accept' }]);
});

verifies('elicitation:capability:mode-mismatch', async ({ transport, protocolVersion }: TestArgs) => {
    const makeServer = () => {
        const s = new Server({ name: 's', version: '0' }, { capabilities: { tools: {} } });
        s.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{ name: 'auth', inputSchema: { type: 'object' } }] }));
        s.setRequestHandler(CallToolRequestSchema, async (_req, extra) => {
            try {
                await extra.sendRequest(
                    {
                        method: 'elicitation/create',
                        params: { mode: 'url', message: 'Sign in', elicitationId: 'mismatch-1', url: 'https://example.com/auth' }
                    },
                    ElicitResultSchema
                );
                return { content: [{ type: 'text', text: 'should-not-reach' }] };
            } catch (e) {
                if (!(e instanceof McpError)) throw e;
                return { content: [{ type: 'text', text: `error:${e.code}` }] };
            }
        });
        return s;
    };

    let handlerInvoked = 0;
    const client = formClient();
    client.setRequestHandler(ElicitRequestSchema, async () => {
        handlerInvoked++;
        return { action: 'accept', content: {} };
    });

    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const r = await client.callTool({ name: 'auth', arguments: {} });
    expect(r.content).toEqual([{ type: 'text', text: `error:${ErrorCode.InvalidParams}` }]);
    expect(handlerInvoked).toBe(0);
});

verifies('elicitation:capability:server-respects-mode', async ({ transport, protocolVersion }: TestArgs) => {
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
            } catch (e) {
                return { content: [{ type: 'text', text: `refused:${e instanceof Error ? e.message : e}` }] };
            }
        });
        return s;
    };

    const client = formClient();
    client.setRequestHandler(ElicitRequestSchema, async () => {
        reachedClient++;
        return { action: 'accept' };
    });

    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const r = await client.callTool({ name: 'auth', arguments: {} });
    expect(r.isError).toBeFalsy();
    // Exact server-gate message (already pinned verbatim by elicitation:capability:not-declared): discriminates the
    // elicitInput gate from the client-side wrapper rejection, which a loose /url elicitation/i regex could not.
    expect(r.content).toEqual([{ type: 'text', text: 'refused:Client does not support url elicitation.' }]);
    expect(reachedClient).toBe(0);
});

verifies(
    'elicitation:capability:server-respects-mode',
    async ({ transport, protocolVersion }: TestArgs) => {
        // The untitled body above drives the elicitInput helper, whose own gate refuses undeclared modes. This arm
        // bypasses the helper: a raw elicitation/create with mode 'url' sent via extra.sendRequest against a
        // form-only client. The spec says the server must refuse to SEND it, so no elicitation/create frame may
        // reach the wire. knownFailure: the protocol-layer capability gate is mode-blind today (see requirements.ts).
        const makeServer = () => {
            const s = new Server({ name: 's', version: '0' }, { capabilities: { tools: {} } });
            s.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{ name: 'auth', inputSchema: { type: 'object' } }] }));
            s.setRequestHandler(CallToolRequestSchema, async (_req, extra) => {
                try {
                    await extra.sendRequest(
                        {
                            method: 'elicitation/create',
                            params: { mode: 'url', message: 'Sign in', elicitationId: 'bypass-1', url: 'https://example.com/auth' }
                        },
                        ElicitResultSchema
                    );
                    return { content: [{ type: 'text', text: 'completed' }] };
                } catch (e) {
                    if (!(e instanceof McpError)) throw e;
                    return { content: [{ type: 'text', text: `error:${e.code}` }] };
                }
            });
            return s;
        };

        let handlerInvoked = 0;
        const client = formClient();
        client.setRequestHandler(ElicitRequestSchema, async () => {
            handlerInvoked++;
            return { action: 'accept' };
        });

        await using _ = await wire({ transport, protocolVersion }, makeServer, client);
        const tap = tapWire(client);

        await client.callTool({ name: 'auth', arguments: {} });

        // True at tip AND after the fix: the user-level handler never runs for an undeclared mode.
        expect(handlerInvoked).toBe(0);
        // The MUST NOT under test: no elicitation/create frame crosses the wire. Fails at tip (the frame is sent and
        // only the client wrapper rejects it); passes once the server gains a mode-aware send gate.
        expect(tap.received.filter(m => 'method' in m && m.method === 'elicitation/create')).toEqual([]);
    },
    { title: 'raw-bypass' }
);

verifies('elicitation:capability:not-declared', async ({ transport, protocolVersion }: TestArgs) => {
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
            } catch (e) {
                return { content: [{ type: 'text', text: `refused:${e instanceof Error ? e.message : e}` }] };
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
            } catch (e) {
                return { content: [{ type: 'text', text: `refused:${e instanceof Error ? e.message : e}` }] };
            }
        });
        return s;
    };

    // No elicitation capability declared at all — neither mode may reach the wire.
    const client = new Client({ name: 'c', version: '0' });

    await using _ = await wire({ transport, protocolVersion }, makeServer, client);
    const tap = tapWire(client);

    const form = await client.callTool({ name: 'ask-form', arguments: {} });
    expect(form.isError).toBeFalsy();
    expect(form.content).toEqual([{ type: 'text', text: 'refused:Client does not support form elicitation.' }]);

    const url = await client.callTool({ name: 'ask-url', arguments: {} });
    expect(url.isError).toBeFalsy();
    expect(url.content).toEqual([{ type: 'text', text: 'refused:Client does not support url elicitation.' }]);

    expect(tap.received.filter(m => 'method' in m && m.method === 'elicitation/create')).toEqual([]);
});

verifies('typescript:consumer:elicitation-handler-replacement', async ({ transport, protocolVersion }: TestArgs) => {
    const makeServer = () => {
        const s = new McpServer({ name: 's', version: '0' });
        s.registerTool('ask', { inputSchema: z.object({}) }, async () => {
            const ans = await s.server.elicitInput({
                mode: 'form',
                message: 'Name?',
                requestedSchema: { type: 'object', properties: { name: { type: 'string' } } }
            });
            return {
                content: [{ type: 'text', text: `${ans.action}:${ans.action === 'accept' ? String(ans.content?.name) : ''}` }]
            };
        });
        return s;
    };

    // Consumers install a refuse-all default handler at startup…
    let defaultInvoked = 0;
    const client = formClient();
    client.setRequestHandler(ElicitRequestSchema, async () => {
        defaultInvoked++;
        return { action: 'cancel' };
    });
    // …and replace it with the real handler once UI wiring is ready. Registration must be last-write-wins:
    // a duplicate-registration guard in the client elicitation branch would throw right here.
    client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'accept', content: { name: 'Ada' } }));

    await using _ = await wire({ transport, protocolVersion }, makeServer, client);

    const first = await client.callTool({ name: 'ask', arguments: {} });
    expect(first.content).toEqual([{ type: 'text', text: 'accept:Ada' }]);

    // Replacement also works mid-session (the wrapper re-wraps on every registration).
    client.setRequestHandler(ElicitRequestSchema, async () => ({ action: 'accept', content: { name: 'Grace' } }));
    const second = await client.callTool({ name: 'ask', arguments: {} });
    expect(second.content).toEqual([{ type: 'text', text: 'accept:Grace' }]);

    // The replaced default never ran.
    expect(defaultInvoked).toBe(0);
});
