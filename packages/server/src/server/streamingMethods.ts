import type { Server } from './server';

// Methods each server answers as a stream whatever `responseMode` says, as `createMcpHandler` streams `subscriptions/listen`.
const streamingMethods = new WeakMap<Server, Set<string>>();

// Makes `createMcpHandler` serve `method` on `server` with `'auto'` where `responseMode: 'json'` is configured.
export function markStreamingMethod(server: Server, method: string): void {
    const methods = streamingMethods.get(server) ?? new Set<string>();
    methods.add(method);
    streamingMethods.set(server, methods);
}

export function isStreamingMethod(server: Server, method: string): boolean {
    return streamingMethods.get(server)?.has(method) === true;
}
