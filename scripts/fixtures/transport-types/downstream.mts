import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { configure, configureNode, connect, createTransport, headers } from './consumer.mjs';

const transport = createTransport();
const contract: Transport = transport;
configure(contract);
configureNode(transport);
headers({ authorization: 'example' });
await connect(new Server({ name: 'declaration-consumer', version: '0' }), transport);
