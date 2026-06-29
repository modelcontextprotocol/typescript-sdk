import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type {
    CallToolResult,
    CreateMessageRequest,
    ElicitResult,
    GetPromptResult,
    McpSubscription,
    Prompt,
    Resource,
    ResourceTemplateType,
    Tool
} from '@modelcontextprotocol/client';
import {
    Client,
    LOG_LEVEL_META_KEY,
    ProtocolError,
    ProtocolErrorCode,
    SdkError,
    StreamableHTTPClientTransport,
    UnauthorizedError
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import type { ChatMessage, ContentPart, GenerateResult, LLMProvider, ToolCall, ToolDefinition } from '../providers/provider';
import { isRecord } from '../providers/provider';
import { completeAuthorizationWithBrowser, createOAuthProvider, findCallbackPort, isSafeBrowserUrl } from './auth';
import type { CliClientConfig, ServerConfig } from './config';
import { isHttpServer } from './config';
import { contentBlockToParts, resourceToContextText, toolResultToParts } from './content';
import { namespaceTool, routeNamespacedTool, sanitizeServerName } from './naming';
import type { HostUI } from './ui';
import { collectFormInput } from './ui';

const CLIENT_INFO = { name: 'cli-client', version: '0.1.0' };

/** Cap what a server can spend through the sampling handler, regardless of what it asks for. */
const SAMPLING_MAX_TOKENS_CAP = 2048;

export interface ConnectedServer {
    name: string;
    /** Sanitized name used in tool namespacing and slash commands. */
    key: string;
    client: Client;
    era: 'modern' | 'legacy';
    /** The protocol revision actually negotiated for this connection (e.g. "2026-07-28"). */
    protocolVersion: string;
    httpTransport?: StreamableHTTPClientTransport;
    instructions?: string;
    tools: Tool[];
    resources: Resource[];
    resourceTemplates: ResourceTemplateType[];
    prompts: Prompt[];
}

export interface McpHostOptions {
    ui: HostUI;
    /** The same provider that drives the chat loop also answers sampling requests. */
    provider: LLMProvider;
    /** Workspace roots exposed to servers via `roots/list` (absolute or cwd-relative paths). */
    roots?: string[];
    /** Use the 2025 `initialize` handshake instead of probing for 2026-07-28. */
    legacy?: boolean;
    /** Fixed loopback port for the OAuth callback (default: an OS-assigned free port). Useful over SSH port-forwarding. */
    oauthCallbackPort?: number;
}

function unwrapUnauthorized(error: unknown): UnauthorizedError | undefined {
    if (error instanceof UnauthorizedError) return error;
    // Under versionNegotiation 'auto', a connect-time 401 surfaces as
    // SdkError(EraNegotiationFailed) with the UnauthorizedError in error.data.cause.
    if (error instanceof SdkError && isRecord(error.data) && error.data.cause instanceof UnauthorizedError) {
        return error.data.cause;
    }
    return undefined;
}

function samplingContentToParts(content: CreateMessageRequest['params']['messages'][number]['content']): ContentPart[] {
    const blocks = Array.isArray(content) ? content : [content];
    const parts: ContentPart[] = [];
    for (const block of blocks) {
        if (block.type === 'text') parts.push({ type: 'text', text: block.text });
        else if (block.type === 'image') parts.push({ type: 'image', mimeType: block.mimeType, data: block.data });
        else parts.push({ type: 'text', text: `[${block.type} content]` });
    }
    return parts;
}

/**
 * One MCP client per configured server, plus everything a host owes the servers it connects
 * to: tool aggregation and routing, resources as context, prompts, and the handlers for
 * server-initiated requests (sampling, elicitation, roots), logging, and progress.
 */
export class McpHost {
    private readonly ui: HostUI;
    private readonly provider: LLMProvider;
    private readonly legacy: boolean;
    private roots: string[];
    private readonly watches: McpSubscription[] = [];
    private readonly oauthCallbackPort?: number;
    readonly servers = new Map<string, ConnectedServer>();

    constructor(options: McpHostOptions) {
        this.ui = options.ui;
        this.provider = options.provider;
        this.legacy = options.legacy ?? false;
        this.oauthCallbackPort = options.oauthCallbackPort;
        this.roots = (options.roots ?? [process.cwd()]).map(root => path.resolve(root));
    }

    async connect(config: CliClientConfig): Promise<void> {
        for (const [name, entry] of Object.entries(config.mcpServers)) {
            try {
                const server = await this.connectServer(name, entry);
                if (!server) continue;
                // Sanitized keys can collide ("my server" vs "my_server") — keep them unique so
                // namespaced tool calls always route to exactly one server.
                const usedKeys = new Set([...this.servers.values()].map(existing => existing.key));
                for (let suffix = 2; usedKeys.has(server.key); suffix++) {
                    server.key = `${sanitizeServerName(name)}_${suffix}`;
                }
                this.servers.set(name, server);
                this.ui.status(
                    `connected to "${name}" (${server.protocolVersion}, ${server.tools.length} tools, ${server.resources.length + server.resourceTemplates.length} resources, ${server.prompts.length} prompts)`
                );
            } catch (error) {
                this.ui.status(`failed to connect to "${name}": ${error instanceof Error ? error.message : String(error)}`);
            }
        }
        if (this.servers.size === 0) {
            throw new Error('No MCP servers connected — check the config file');
        }
    }

    /** Aggregated, namespaced tool definitions for the model. */
    toolDefinitions(): ToolDefinition[] {
        const definitions: ToolDefinition[] = [];
        for (const server of this.servers.values()) {
            for (const tool of server.tools) {
                definitions.push({
                    name: namespaceTool(server.key, tool.name),
                    description: tool.description,
                    inputSchema: tool.inputSchema
                });
            }
        }
        return definitions;
    }

    /** Server instructions folded into the system prompt — that is what they exist for. */
    systemInstructions(): string {
        const sections = [...this.servers.values()]
            .filter(server => server.instructions)
            .map(server => `Instructions from the "${server.name}" server:\n${server.instructions}`);
        return sections.join('\n\n');
    }

    /** Execute a model-issued tool call against the server that owns it. */
    async executeToolCall(call: ToolCall, options?: { signal?: AbortSignal }): Promise<{ parts: ContentPart[]; isError: boolean }> {
        const route = routeNamespacedTool(
            call.name,
            [...this.servers.values()].map(server => server.key)
        );
        const server = route && [...this.servers.values()].find(candidate => candidate.key === route.serverKey);
        if (!route || !server) {
            return { parts: [{ type: 'text', text: `Unknown tool: ${call.name}` }], isError: true };
        }
        try {
            const result: CallToolResult = await server.client.callTool(
                {
                    name: route.toolName,
                    arguments: call.arguments,
                    // On 2026-07-28 connections servers only emit log notifications for requests
                    // that opt in via this _meta key; on 2025 the setLoggingLevel call covers it.
                    ...(server.era === 'modern' ? { _meta: { [LOG_LEVEL_META_KEY]: 'info' } } : {})
                },
                {
                    // Aborting this signal cancels the call: the SDK sends notifications/cancelled
                    // and the server can stop work via its own request signal.
                    signal: options?.signal,
                    onprogress: progress => {
                        const total = progress.total === undefined ? '' : `/${progress.total}`;
                        this.ui.status(`${call.name}: ${progress.message ?? 'working'} (${progress.progress}${total})`);
                    },
                    resetTimeoutOnProgress: true
                }
            );
            return { parts: toolResultToParts(result), isError: result.isError === true };
        } catch (error) {
            if (options?.signal?.aborted) {
                return { parts: [{ type: 'text', text: 'Tool call cancelled by the user.' }], isError: true };
            }
            // A thrown ProtocolError/SdkError (unknown tool, timeout, lost connection) is not the
            // same thing as a tool-level isError result, but the model should see both as failures.
            const reason = error instanceof Error ? error.message : String(error);
            return { parts: [{ type: 'text', text: `Tool call failed: ${reason}` }], isError: true };
        }
    }

    /** Resolve a `server:uri` reference (the part after the `@`) to the owning server and the resource URI. */
    private resolveResourceReference(reference: string): { server: ConnectedServer; uri: string } {
        const separator = reference.indexOf(':');
        if (separator === -1) throw new Error(`Resource references look like @server:uri — got "@${reference}"`);
        const serverName = reference.slice(0, separator);
        const uri = reference.slice(separator + 1);
        // Accept the configured name or its sanitized key (the form used in tool names and /commands).
        const server = this.servers.get(serverName) ?? [...this.servers.values()].find(candidate => candidate.key === serverName);
        if (!server) throw new Error(`Unknown server "${serverName}" in @${reference}`);
        return { server, uri };
    }

    /** Resolve an `@server:uri` mention into a provenance-labelled context block. */
    async attachResource(reference: string): Promise<string> {
        const { server, uri } = this.resolveResourceReference(reference);
        const result = await server.client.readResource({ uri });
        return resourceToContextText(server.name, uri, result);
    }

    /**
     * Watch a resource for change notifications. On 2025-era connections this is the
     * `resources/subscribe` request; on 2026-07-28 connections per-resource subscriptions ride
     * a `subscriptions/listen` stream instead. Updates arrive through the same
     * `notifications/resources/updated` handler either way.
     */
    async watchResource(reference: string): Promise<void> {
        const { server, uri } = this.resolveResourceReference(reference);
        if (server.era === 'legacy') {
            await server.client.subscribeResource({ uri });
            return;
        }
        const subscription = await server.client.listen({ resourceSubscriptions: [uri] });
        // The server acknowledges which parts of the filter it will honour — don't pretend to
        // watch a resource the server will never report on.
        if (!subscription.honoredFilter.resourceSubscriptions?.includes(uri)) {
            await subscription.close().catch(() => {});
            throw new Error(`server "${server.name}" does not support resource subscriptions`);
        }
        this.watches.push(subscription);
    }

    listResources(): Array<{ server: string; resource: Resource }> {
        return [...this.servers.values()].flatMap(server => server.resources.map(resource => ({ server: server.name, resource })));
    }

    listPrompts(): Array<{ server: string; prompt: Prompt }> {
        return [...this.servers.values()].flatMap(server => server.prompts.map(prompt => ({ server: server.name, prompt })));
    }

    findPrompt(serverName: string, promptName: string): { server: ConnectedServer; prompt: Prompt } | undefined {
        const server = this.servers.get(serverName) ?? [...this.servers.values()].find(candidate => candidate.key === serverName);
        const prompt = server?.prompts.find(candidate => candidate.name === promptName);
        return server && prompt ? { server, prompt } : undefined;
    }

    /** Argument-value suggestions for a prompt via MCP `completion/complete` (powers tab completion). */
    async completePromptArgument(serverName: string, promptName: string, argumentName: string, value: string): Promise<string[]> {
        const server = this.servers.get(serverName);
        if (!server?.client.getServerCapabilities()?.completions) return [];
        try {
            const result = await server.client.complete({
                ref: { type: 'ref/prompt', name: promptName },
                argument: { name: argumentName, value }
            });
            return result.completion.values;
        } catch {
            return [];
        }
    }

    /** `prompts/get`, with the returned message roles preserved as separate conversation turns. */
    async getPromptMessages(serverName: string, promptName: string, args: Record<string, string>): Promise<ChatMessage[]> {
        const found = this.findPrompt(serverName, promptName);
        if (!found) throw new Error(`Unknown prompt ${serverName}:${promptName}`);
        const result: GetPromptResult = await found.server.client.getPrompt({ name: promptName, arguments: args });
        return result.messages.map(message => ({
            role: message.role,
            content: contentBlockToParts(message.content)
        }));
    }

    listRoots(): string[] {
        return [...this.roots];
    }

    /** Add a workspace root and tell connected (legacy-era) servers the list changed. */
    async addRoot(directory: string): Promise<void> {
        this.roots.push(path.resolve(directory));
        for (const server of this.servers.values()) {
            // roots/list_changed is a 2025-era notification; on 2026-07-28 connections the
            // method is gone and servers re-request roots when they need them.
            if (server.era === 'legacy') {
                await server.client.sendRootsListChanged().catch(() => {});
            }
        }
    }

    async close(): Promise<void> {
        for (const watch of this.watches) {
            await watch.close().catch(() => {});
        }
        for (const server of this.servers.values()) {
            if (server.httpTransport) {
                await server.httpTransport.terminateSession().catch(() => {});
            }
            await server.client.close().catch(() => {});
        }
        this.servers.clear();
    }

    private buildClient(name: string): Client {
        const client = new Client(CLIENT_INFO, {
            versionNegotiation: { mode: this.legacy ? 'legacy' : 'auto' },
            capabilities: {
                // Both elicitation modes are declared because the handler below implements both.
                elicitation: { form: {}, url: {} },
                sampling: {},
                roots: { listChanged: true }
            },
            listChanged: {
                tools: {
                    onChanged: (error, tools) => {
                        const server = this.servers.get(name);
                        if (error || !server || !tools) return;
                        server.tools = tools;
                        this.ui.status(`tool list changed on "${name}" (${tools.length} tools)`);
                    }
                },
                resources: {
                    onChanged: (error, resources) => {
                        const server = this.servers.get(name);
                        if (error || !server || !resources) return;
                        server.resources = resources;
                        this.ui.status(`resource list changed on "${name}" (${resources.length} resources)`);
                    }
                },
                prompts: {
                    onChanged: (error, prompts) => {
                        const server = this.servers.get(name);
                        if (error || !server || !prompts) return;
                        server.prompts = prompts;
                        this.ui.status(`prompt list changed on "${name}" (${prompts.length} prompts)`);
                    }
                }
            }
        });
        client.onerror = error => this.ui.status(`[${name}] transport error: ${error.message}`);
        this.registerSamplingHandler(client, name);
        this.registerElicitationHandler(client, name);
        this.registerRootsHandler(client);
        return client;
    }

    /**
     * Sampling: the server borrows the host's model. The request is shown to the user and
     * nothing is sent to the provider until they approve — a server must not be able to spend
     * the user's API quota (or exfiltrate conversation context) silently.
     */
    private registerSamplingHandler(client: Client, name: string): void {
        client.setRequestHandler('sampling/createMessage', async request => {
            const params = request.params;
            // Show the user the full request they are approving — an abbreviated preview would
            // mean approving something they haven't actually seen.
            const requestText = [
                ...(params.systemPrompt ? [`system: ${params.systemPrompt}`] : []),
                ...params.messages.map(
                    message =>
                        `${message.role}: ${samplingContentToParts(message.content)
                            .map(part => (part.type === 'text' ? part.text : '[image]'))
                            .join(' ')}`
                )
            ].join('\n');
            // Cap the spend regardless of what the server asked for, and approve what is actually sent.
            const grantedMaxTokens = Math.min(params.maxTokens, SAMPLING_MAX_TOKENS_CAP);
            const capNote = grantedMaxTokens === params.maxTokens ? '' : ` (server asked for ${params.maxTokens})`;
            this.ui.attention(
                `[sampling request]\nServer "${name}" wants to run an LLM request through your ${this.provider.name} provider (${grantedMaxTokens} max tokens${capNote}):\n\n${requestText}\n`
            );
            const approved = await this.ui.confirm('Allow?');
            if (!approved) {
                throw new ProtocolError(ProtocolErrorCode.InvalidRequest, 'User declined the sampling request');
            }
            const stopSpinner = this.ui.spinner();
            let result: GenerateResult;
            try {
                result = await this.provider.generate({
                    system: params.systemPrompt,
                    messages: params.messages.map(message => ({ role: message.role, content: samplingContentToParts(message.content) })),
                    maxTokens: grantedMaxTokens
                });
            } finally {
                stopSpinner();
            }
            return {
                role: 'assistant' as const,
                content: { type: 'text' as const, text: result.text },
                model: result.model,
                stopReason: result.stopReason === 'max_tokens' ? 'maxTokens' : 'endTurn'
            };
        });
    }

    /** Elicitation: render the requested form (or URL) in the terminal; errors fail closed to cancel. */
    private registerElicitationHandler(client: Client, name: string): void {
        client.setRequestHandler('elicitation/create', async (request): Promise<ElicitResult> => {
            const params = request.params;
            if (params.mode === 'url') {
                // Same discipline as the OAuth path: never offer a server-controlled URL to the
                // browser unless it is https (or http on loopback) — file:, javascript:, and
                // plain-http phishing URLs all fail closed to a decline.
                let target: URL | undefined;
                try {
                    target = new URL(params.url);
                } catch {
                    target = undefined;
                }
                if (!target || !isSafeBrowserUrl(target)) {
                    this.ui.status(`declined URL elicitation from "${name}" — refusing to open a non-https URL`);
                    return { action: 'decline' };
                }
                this.ui.attention(
                    `[elicitation request]\nServer "${name}" needs you to complete a step in the browser:\n\n${params.url}\n`
                );
                const opened = await this.ui.confirm('Open the URL and confirm once you are done. Continue?');
                return opened ? { action: 'accept' } : { action: 'decline' };
            }
            this.ui.attention(`[elicitation request]\nServer "${name}" is asking for input:\n\n${params.message}\n`);
            return collectFormInput(this.ui, params.requestedSchema);
        });
    }

    private registerRootsHandler(client: Client): void {
        client.setRequestHandler('roots/list', () => ({
            roots: this.roots.map(root => ({ uri: pathToFileURL(root).href, name: path.basename(root) }))
        }));
    }

    private async connectServer(name: string, entry: ServerConfig): Promise<ConnectedServer | undefined> {
        const client = this.buildClient(name);
        let httpTransport: StreamableHTTPClientTransport | undefined;

        if (isHttpServer(entry)) {
            if (entry.headers && Object.keys(entry.headers).length > 0) {
                // Static headers (e.g. a bearer token from the environment). No OAuth fallback —
                // if the token is wrong the connection error is the more honest signal.
                httpTransport = new StreamableHTTPClientTransport(new URL(entry.url), { requestInit: { headers: entry.headers } });
                await client.connect(httpTransport);
            } else {
                const callbackPort = this.oauthCallbackPort ?? (await findCallbackPort());
                const oauthProvider = createOAuthProvider(name, callbackPort);
                httpTransport = new StreamableHTTPClientTransport(new URL(entry.url), { authProvider: oauthProvider });
                try {
                    await client.connect(httpTransport);
                } catch (error) {
                    if (!unwrapUnauthorized(error)) throw error;
                    const finishTransport = httpTransport;
                    const authorized = await completeAuthorizationWithBrowser({
                        serverName: name,
                        ui: this.ui,
                        provider: oauthProvider,
                        callbackPort,
                        finishAuth: params => finishTransport.finishAuth(params)
                    });
                    if (!authorized) return undefined;
                    // finishAuth() exchanged the code on the old transport; reconnect on a fresh one.
                    httpTransport = new StreamableHTTPClientTransport(new URL(entry.url), { authProvider: oauthProvider });
                    await client.connect(httpTransport);
                }
            }
        } else {
            const transport = new StdioClientTransport({
                command: entry.command,
                args: entry.args,
                // The child gets the SDK's minimal default environment plus exactly what the
                // config lists — never the host's full environment (API keys stay here).
                env: entry.env,
                cwd: entry.cwd,
                stderr: 'pipe'
            });
            transport.stderr?.on('data', (chunk: Buffer) => {
                const line = String(chunk).trim();
                if (line) this.ui.serverLog(name, 'stderr', line);
            });
            await client.connect(transport);
        }

        try {
            const era = client.getProtocolEra() === 'modern' ? 'modern' : 'legacy';
            const capabilities = client.getServerCapabilities();

            client.setNotificationHandler('notifications/message', notification => {
                const { level, data, logger } = notification.params;
                this.ui.serverLog(name, `${logger ? `${logger} ` : ''}${level}`, typeof data === 'string' ? data : JSON.stringify(data));
            });
            client.setNotificationHandler('notifications/resources/updated', notification => {
                this.ui.note(`resource updated: @${name}:${notification.params.uri}`);
            });
            if (era === 'legacy' && capabilities?.logging) {
                await client.setLoggingLevel('info').catch(() => {});
            }

            // Discovery is gated on the advertised capabilities and degrades per call: a server
            // may advertise a capability and still not implement every list method
            // (resources/templates/list is the usual gap). One failed listing costs the host an
            // empty list and a status line, not the whole connection.
            const listOrEmpty = async <T>(label: string, advertised: unknown, list: () => Promise<T[]>): Promise<T[]> => {
                if (!advertised) return [];
                return list().catch((error: unknown) => {
                    this.ui.status(`listing ${label} on "${name}" failed: ${error instanceof Error ? error.message : String(error)}`);
                    return [];
                });
            };
            const [tools, resources, resourceTemplates, prompts] = await Promise.all([
                listOrEmpty('tools', capabilities?.tools, () => client.listTools().then(result => result.tools)),
                listOrEmpty('resources', capabilities?.resources, () => client.listResources().then(result => result.resources)),
                listOrEmpty('resource templates', capabilities?.resources, () =>
                    client.listResourceTemplates().then(result => result.resourceTemplates)
                ),
                listOrEmpty('prompts', capabilities?.prompts, () => client.listPrompts().then(result => result.prompts))
            ]);

            return {
                name,
                key: sanitizeServerName(name),
                client,
                era,
                protocolVersion: client.getNegotiatedProtocolVersion() ?? 'unknown',
                httpTransport,
                instructions: client.getInstructions(),
                tools,
                resources,
                resourceTemplates,
                prompts
            };
        } catch (error) {
            // Don't leak a connected client when post-connect setup fails.
            await client.close().catch(() => {});
            throw error;
        }
    }
}
