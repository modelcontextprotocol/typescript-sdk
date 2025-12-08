import { InMemoryTransport } from '../../src/inMemory.js';
import { Client } from '../../src/client/index.js';
import { Server } from '../../src/server/index.js';
import { InMemoryTaskStore, InMemoryTaskMessageQueue } from '../../src/experimental/tasks/stores/in-memory.js';
import type { ClientCapabilities, ServerCapabilities } from '../../src/types.js';

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
            capabilities: options?.clientCapabilities ?? {
                tasks: {
                    list: {},
                    requests: {
                        tools: {
                            call: {}
                        }
                    }
                }
            }
        }
    );

    const server = new Server(
        {
            name: 'test-server',
            version: '1.0.0'
        },
        {
            capabilities: options?.serverCapabilities ?? {
                tasks: {
                    list: {},
                    requests: {
                        tools: {
                            call: {}
                        }
                    }
                }
            },
            taskStore,
            taskMessageQueue: new InMemoryTaskMessageQueue()
        }
    );

    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    return {
        client,
        server,
        taskStore,
        clientTransport,
        serverTransport
    };
}
