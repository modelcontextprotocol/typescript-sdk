import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, tasksPlugin } from '@modelcontextprotocol/core';
import type { ClientCapabilities, ServerCapabilities } from '@modelcontextprotocol/server';
import { InMemoryTaskStore, Server } from '@modelcontextprotocol/server';

export interface InMemoryTaskEnvironment {
    client: Client;
    server: Server;
    taskStore: InMemoryTaskStore;
    clientTransport: InMemoryTransport;
    serverTransport: InMemoryTransport;
}

export async function createInMemoryTaskEnvironment(options?: {
    clientCapabilities?: ClientCapabilities;
    serverCapabilities?: ServerCapabilities;
}): Promise<InMemoryTaskEnvironment> {
    const taskStore = new InMemoryTaskStore();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    const client = new Client(
        {
            name: 'test-client',
            version: '1.0.0'
        },
        {
            capabilities: options?.clientCapabilities ?? {}
        }
    );

    const server = new Server(
        {
            name: 'test-server',
            version: '1.0.0'
        },
        {
            capabilities: options?.serverCapabilities ?? {
                tasks: { list: {}, cancel: {} }
            }
        }
    );
    server.use(tasksPlugin({ store: taskStore }));

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    return {
        client,
        server,
        taskStore,
        clientTransport,
        serverTransport
    };
}
