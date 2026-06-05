import type { Transport } from '@modelcontextprotocol/core';

import type { Client } from './client.js';

export type McpEra = 'legacy' | 'modern';

export interface ClientVersionRouterOptions {
    forceLegacy?: boolean;
}

export abstract class ClientVersionRouter {
    private _era: McpEra | undefined;

    constructor(
        protected client: Client,
        protected options?: ClientVersionRouterOptions
    ) {}

    get era(): McpEra | undefined {
        return this._era;
    }

    /**
     * Probe the server to determine protocol era.
     * Called after transport is connected but before initialize.
     * Returns 'modern' if server supports 2026-06, 'legacy' if not.
     * Subclasses implement the transport-specific probe logic.
     */
    protected abstract probe(): Promise<McpEra>;

    async connect(transport: Transport): Promise<void> {
        if (this.options?.forceLegacy) {
            await this.client.connect(transport);
            this._era = 'legacy';
            return;
        }

        // Connect without initialize — let probe decide
        await this.client.connect(transport, { skipInitialize: true });

        try {
            this._era = await this.probe();
        } catch {
            this._era = 'legacy';
        }

        if (this._era === 'legacy') {
            await this.client.initialize();
        } else {
            // Modern mode: configure _meta injection for all outgoing requests
            this.client.setRequestMeta({
                protocolVersion: '2026-06-30',
                clientInfo: this.client.getClientInfo(),
                clientCapabilities: this.client.getClientCapabilities()
            });
        }
    }

    async close(): Promise<void> {
        await this.client.close();
    }
}
