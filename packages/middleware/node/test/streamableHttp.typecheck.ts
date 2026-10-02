import type { Transport } from '@modelcontextprotocol/core';
import { NodeStreamableHTTPServerTransport } from '../src/streamableHttp.js';

const transport: Transport = new NodeStreamableHTTPServerTransport({});
transport.onclose = undefined;
