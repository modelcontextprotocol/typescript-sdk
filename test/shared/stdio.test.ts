import { JSONRPCMessage } from '../../src/types.js';
import { ReadBuffer } from '../../src/shared/stdio.js';

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

describe('multi-byte UTF-8 across chunk boundaries', () => {
    test('should preserve em-dash split across two chunks', () => {
        const readBuffer = new ReadBuffer();
        const message: JSONRPCMessage = { jsonrpc: '2.0', method: 'test', params: { text: 'a—b' } };
        const fullBuffer = Buffer.from(JSON.stringify(message) + '\n');
        const splitIndex = fullBuffer.indexOf(0xe2) + 1;

        readBuffer.append(fullBuffer.subarray(0, splitIndex));
        readBuffer.append(fullBuffer.subarray(splitIndex));

        expect(readBuffer.readMessage()).toEqual(message);
    });

    test('should preserve emoji split across two chunks', () => {
        const readBuffer = new ReadBuffer();
        const message: JSONRPCMessage = { jsonrpc: '2.0', method: 'test', params: { text: '✅' } };
        const fullBuffer = Buffer.from(JSON.stringify(message) + '\n');
        const splitIndex = fullBuffer.indexOf(0xe2) + 2;

        readBuffer.append(fullBuffer.subarray(0, splitIndex));
        readBuffer.append(fullBuffer.subarray(splitIndex));

        expect(readBuffer.readMessage()).toEqual(message);
    });

    test('should preserve four-byte emoji split across chunks', () => {
        const readBuffer = new ReadBuffer();
        const message: JSONRPCMessage = { jsonrpc: '2.0', method: 'test', params: { text: '🎉' } };
        const fullBuffer = Buffer.from(JSON.stringify(message) + '\n');
        const splitIndex = fullBuffer.indexOf(0xf0) + 2;

        readBuffer.append(fullBuffer.subarray(0, splitIndex));
        readBuffer.append(fullBuffer.subarray(splitIndex));

        expect(readBuffer.readMessage()).toEqual(message);
    });

    test('should preserve multi-byte chars across many chunks of size 1', () => {
        const readBuffer = new ReadBuffer();
        const message: JSONRPCMessage = { jsonrpc: '2.0', method: 'test', params: { text: 'em — dash and ✅ check' } };
        const fullBuffer = Buffer.from(JSON.stringify(message) + '\n');

        for (let i = 0; i < fullBuffer.length; i++) {
            readBuffer.append(fullBuffer.subarray(i, i + 1));
        }

        expect(readBuffer.readMessage()).toEqual(message);
    });
});
