import { vi } from 'vitest';
import { JSONRPCMessage } from '../../src/types.js';
import { STDIO_DEFAULT_MAX_BUFFER_SIZE, ReadBuffer } from '../../src/shared/stdio.js';

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

describe('consumed buffer', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('should release the backing allocation after the final newline', () => {
        const readBuffer = new ReadBuffer();
        const message = Buffer.from(JSON.stringify(testMessage) + '\n');
        const allocation = Buffer.alloc(64 * 1024);
        message.copy(allocation);
        readBuffer.append(allocation.subarray(0, message.length));

        expect(readBuffer.readMessage()).toEqual(testMessage);
        expect(readBuffer).toHaveProperty('_buffer', undefined);
        expect(readBuffer.readMessage()).toBeNull();
    });

    test('should append the next chunk without copying after draining', () => {
        const readBuffer = new ReadBuffer();
        readBuffer.append(Buffer.from(JSON.stringify(testMessage) + '\n'));
        expect(readBuffer.readMessage()).toEqual(testMessage);

        const nextChunk = Buffer.from(JSON.stringify(testMessage) + '\n');
        const concatSpy = vi.spyOn(Buffer, 'concat');
        readBuffer.append(nextChunk);

        expect(concatSpy).not.toHaveBeenCalled();
        expect(readBuffer.readMessage()).toEqual(testMessage);
        expect(readBuffer.readMessage()).toBeNull();
    });

    test('should preserve a partial message after a complete message', () => {
        const readBuffer = new ReadBuffer();
        const nextMessage: JSONRPCMessage = { jsonrpc: '2.0', method: 'second' };
        const message = JSON.stringify(nextMessage);
        const split = Math.floor(message.length / 2);
        readBuffer.append(Buffer.from(JSON.stringify(testMessage) + '\n' + message.slice(0, split)));

        expect(readBuffer.readMessage()).toEqual(testMessage);
        expect(readBuffer.readMessage()).toBeNull();

        readBuffer.append(Buffer.from(message.slice(split) + '\r\n'));
        expect(readBuffer.readMessage()).toEqual(nextMessage);
        expect(readBuffer.readMessage()).toBeNull();
    });
});

describe('buffer size limit', () => {
    test('should throw when buffer exceeds default max size', () => {
        const readBuffer = new ReadBuffer();
        const chunkSize = 1024 * 1024; // 1 MB
        const chunk = Buffer.alloc(chunkSize);
        const chunksToFill = Math.floor(STDIO_DEFAULT_MAX_BUFFER_SIZE / chunkSize);
        for (let i = 0; i < chunksToFill; i++) {
            readBuffer.append(chunk);
        }
        expect(() => readBuffer.append(chunk)).toThrow(/ReadBuffer exceeded maximum size/);
    });

    test('should throw when buffer exceeds custom max size', () => {
        const readBuffer = new ReadBuffer({ maxBufferSize: 100 });
        readBuffer.append(Buffer.alloc(50));
        expect(() => readBuffer.append(Buffer.alloc(51))).toThrow(/ReadBuffer exceeded maximum size/);
    });

    test('should clear buffer before throwing on overflow', () => {
        const readBuffer = new ReadBuffer({ maxBufferSize: 100 });
        readBuffer.append(Buffer.alloc(50));
        expect(() => readBuffer.append(Buffer.alloc(51))).toThrow();

        // Buffer should be cleared — can append again
        readBuffer.append(Buffer.alloc(50));
        // And read messages normally
        expect(readBuffer.readMessage()).toBeNull();
    });

    test('should allow appending up to exactly the max size', () => {
        const readBuffer = new ReadBuffer({ maxBufferSize: 100 });
        // Should not throw — exactly at limit
        expect(() => readBuffer.append(Buffer.alloc(100))).not.toThrow();
    });

    test('should work with no options (backwards compatible)', () => {
        const readBuffer = new ReadBuffer();
        // Small append should always work
        readBuffer.append(Buffer.from(JSON.stringify({ jsonrpc: '2.0', method: 'ping' }) + '\n'));
        expect(readBuffer.readMessage()).not.toBeNull();
    });
});
