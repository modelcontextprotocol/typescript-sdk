#!/usr/bin/env node
/**
 * Demonstrates that the ext-apps (mcp-ui) pattern is fully implementable on top of the v2
 * SDK's custom-method-handler API, without extending Protocol or relying on the v1 generic
 * type parameters.
 *
 * In v1, ext-apps defined `class ProtocolWithEvents<...> extends Protocol<SendRequestT, ...>` to
 * widen the request/notification type unions. In v2, the same is achieved by composing
 * setCustomRequestHandler / setCustomNotificationHandler / sendCustomRequest / sendCustomNotification
 * on top of the standard Client and Server classes.
 */

import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, Server } from '@modelcontextprotocol/server';
import { z } from 'zod';

// ───────────────────────────────────────────────────────────────────────────────
// Custom method schemas (mirror the ext-apps spec.types.ts pattern)
// ───────────────────────────────────────────────────────────────────────────────

const InitializeParams = z.object({
    protocolVersion: z.string(),
    appInfo: z.object({ name: z.string(), version: z.string() })
});
const InitializeResult = z.object({
    protocolVersion: z.string(),
    hostInfo: z.object({ name: z.string(), version: z.string() }),
    hostContext: z.object({ theme: z.enum(['light', 'dark']), locale: z.string() })
});

const OpenLinkParams = z.object({ url: z.url() });
const OpenLinkResult = z.object({ opened: z.boolean() });

const TeardownParams = z.object({ reason: z.string().optional() });

const SizeChangedParams = z.object({ width: z.number(), height: z.number() });
const ToolResultParams = z.object({ toolName: z.string(), content: z.array(z.object({ type: z.string(), text: z.string() })) });
const HostContextChangedParams = z.object({ theme: z.enum(['light', 'dark']).optional(), locale: z.string().optional() });

type AppEventMap = {
    toolresult: z.infer<typeof ToolResultParams>;
    hostcontextchanged: z.infer<typeof HostContextChangedParams>;
};

// ───────────────────────────────────────────────────────────────────────────────
// App: wraps Client, exposes typed mcp-ui/* methods + DOM-style events
// (replaces v1's `class App extends ProtocolWithEvents<AppRequest, AppNotification, AppResult, AppEventMap>`)
// ───────────────────────────────────────────────────────────────────────────────

class App {
    readonly client: Client;
    private _listeners: { [K in keyof AppEventMap]: ((p: AppEventMap[K]) => void)[] } = {
        toolresult: [],
        hostcontextchanged: []
    };
    private _hostContext?: z.infer<typeof InitializeResult>['hostContext'];

    onTeardown?: (params: z.infer<typeof TeardownParams>) => void | Promise<void>;

    constructor(appInfo: { name: string; version: string }) {
        this.client = new Client(appInfo, { capabilities: {} });

        // Incoming custom request from host
        this.client.setCustomRequestHandler('mcp-ui/resourceTeardown', TeardownParams, async params => {
            await this.onTeardown?.(params);
            return {};
        });

        // Incoming custom notifications from host -> DOM-style event slots
        this.client.setCustomNotificationHandler('mcp-ui/toolResult', ToolResultParams, p => this._dispatch('toolresult', p));
        this.client.setCustomNotificationHandler('mcp-ui/hostContextChanged', HostContextChangedParams, p => {
            this._hostContext = { ...this._hostContext!, ...p };
            this._dispatch('hostcontextchanged', p);
        });
    }

    addEventListener<K extends keyof AppEventMap>(event: K, listener: (p: AppEventMap[K]) => void): void {
        this._listeners[event].push(listener);
    }

    removeEventListener<K extends keyof AppEventMap>(event: K, listener: (p: AppEventMap[K]) => void): void {
        const arr = this._listeners[event];
        const i = arr.indexOf(listener);
        if (i !== -1) arr.splice(i, 1);
    }

    private _dispatch<K extends keyof AppEventMap>(event: K, params: AppEventMap[K]): void {
        for (const l of this._listeners[event]) l(params);
    }

    async connect(transport: Parameters<Client['connect']>[0]): Promise<void> {
        await this.client.connect(transport);
        const result = await this.client.sendCustomRequest(
            'mcp-ui/initialize',
            { protocolVersion: '2026-01-26', appInfo: { name: 'demo-app', version: '1.0.0' } },
            InitializeResult
        );
        this._hostContext = result.hostContext;
        await this.client.sendCustomNotification('mcp-ui/initialized', {});
    }

    getHostContext() {
        return this._hostContext;
    }

    openLink(url: string) {
        return this.client.sendCustomRequest('mcp-ui/openLink', { url }, OpenLinkResult);
    }

    notifySizeChanged(width: number, height: number) {
        return this.client.sendCustomNotification('mcp-ui/sizeChanged', { width, height });
    }
}

// ───────────────────────────────────────────────────────────────────────────────
// Host: wraps Server, handles mcp-ui/* requests and emits mcp-ui/* notifications
// ───────────────────────────────────────────────────────────────────────────────

class Host {
    readonly server: Server;
    onSizeChanged?: (p: z.infer<typeof SizeChangedParams>) => void;

    constructor() {
        this.server = new Server({ name: 'demo-host', version: '1.0.0' }, { capabilities: {} });

        this.server.setCustomRequestHandler('mcp-ui/initialize', InitializeParams, params => {
            console.log(`[host] mcp-ui/initialize from ${params.appInfo.name}@${params.appInfo.version}`);
            return {
                protocolVersion: params.protocolVersion,
                hostInfo: { name: 'demo-host', version: '1.0.0' },
                hostContext: { theme: 'dark', locale: 'en-US' }
            };
        });

        this.server.setCustomRequestHandler('mcp-ui/openLink', OpenLinkParams, params => {
            console.log(`[host] mcp-ui/openLink url=${params.url}`);
            return { opened: true };
        });

        this.server.setCustomNotificationHandler('mcp-ui/initialized', z.object({}).optional(), () => {
            console.log('[host] mcp-ui/initialized');
        });

        this.server.setCustomNotificationHandler('mcp-ui/sizeChanged', SizeChangedParams, p => {
            console.log(`[host] mcp-ui/sizeChanged ${p.width}x${p.height}`);
            this.onSizeChanged?.(p);
        });
    }

    notifyToolResult(toolName: string, text: string) {
        return this.server.sendCustomNotification('mcp-ui/toolResult', {
            toolName,
            content: [{ type: 'text', text }]
        });
    }

    notifyHostContextChanged(patch: z.infer<typeof HostContextChangedParams>) {
        return this.server.sendCustomNotification('mcp-ui/hostContextChanged', patch);
    }

    requestTeardown(reason: string) {
        return this.server.sendCustomRequest('mcp-ui/resourceTeardown', { reason }, z.object({}));
    }
}

// ───────────────────────────────────────────────────────────────────────────────
// Demo
// ───────────────────────────────────────────────────────────────────────────────

async function main() {
    const host = new Host();
    const app = new App({ name: 'demo-app', version: '1.0.0' });

    app.addEventListener('toolresult', p => console.log(`[app] toolresult: ${p.toolName} -> "${p.content[0]?.text}"`));
    app.addEventListener('hostcontextchanged', p => console.log(`[app] hostcontextchanged: ${JSON.stringify(p)}`));
    app.onTeardown = p => console.log(`[app] teardown: ${p.reason}`);
    host.onSizeChanged = p => console.log(`[host] app resized to ${p.width}x${p.height}`);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await host.server.connect(serverTransport);
    await app.connect(clientTransport);

    console.log(`[app] hostContext after init: ${JSON.stringify(app.getHostContext())}`);

    // App -> Host: custom request
    const { opened } = await app.openLink('https://example.com');
    console.log(`[app] openLink -> opened=${opened}`);

    // App -> Host: custom notification
    await app.notifySizeChanged(800, 600);

    // Host -> App: custom notifications (DOM-style event listeners fire)
    await host.notifyToolResult('search', 'found 3 widgets');
    await host.notifyHostContextChanged({ theme: 'light' });
    console.log(`[app] hostContext after change: ${JSON.stringify(app.getHostContext())}`);

    // Host -> App: custom request
    await host.requestTeardown('navigation');

    await app.client.close();
    await host.server.close();
}

await main();
