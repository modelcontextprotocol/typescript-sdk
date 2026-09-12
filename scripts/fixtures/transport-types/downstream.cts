import ServerModule = require('@modelcontextprotocol/sdk/server/index.js');
import consumer = require('./consumer.cjs');
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

async function check(): Promise<void> {
    const transport = consumer.createTransport();
    const contract: Transport = transport;
    consumer.configure(contract);
    consumer.headers({ authorization: 'example' });
    await consumer.connect(new ServerModule.Server({ name: 'declaration-consumer', version: '0' }), transport);
}

export = check;
