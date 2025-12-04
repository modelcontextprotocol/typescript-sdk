import { JSONRPCMessage } from '../../src/types.js';
import { ReadBuffer } from '../../src/shared/stdio.js';
import { ZodError } from 'zod/v4';

const testMessage: JSONRPCMessage = {
    jsonrpc: '2.0',
    method: 'foobar'
};

test('should have no messages after initialization', () => {
    const readBuffer = new ReadBuffer();
    expect(readBuffer.readMessage()).toBeNull();
});

test('should only yield a message after a newline', () => {
    const readBuffer = new ReadBuffer();

    readBuffer.append(Buffer.from(JSON.stringify(testMessage)));
    expect(readBuffer.readMessage()).toBeNull();

    readBuffer.append(Buffer.from('\n'));
    expect(readBuffer.readMessage()).toEqual(testMessage);
    expect(readBuffer.readMessage()).toBeNull();
});

test('should be reusable after clearing', () => {
    const readBuffer = new ReadBuffer();

    readBuffer.append(Buffer.from('foobar'));
    readBuffer.clear();
    expect(readBuffer.readMessage()).toBeNull();

    readBuffer.append(Buffer.from(JSON.stringify(testMessage)));
    readBuffer.append(Buffer.from('\n'));
    expect(readBuffer.readMessage()).toEqual(testMessage);
});

test('should override invalid json message and return null', () => {
    const readBuffer = new ReadBuffer();

    readBuffer.append(Buffer.from('invalid message\n'));
    expect(readBuffer.readMessage()).toBeNull();
});

test('should throw validation error on invalid JSON-RPC message', () => {
    const readBuffer = new ReadBuffer();
    const invalidJsonRpcMessage = '{"jsonrpc":"2.0","method":123}\n';
    readBuffer.append(Buffer.from(invalidJsonRpcMessage));
    expect(() => readBuffer.readMessage()).toThrowError(ZodError);
});
