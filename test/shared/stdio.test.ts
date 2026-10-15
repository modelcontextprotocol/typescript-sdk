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

describe('byte order mark', () => {
    const utf8ByteOrderMark = Buffer.from([0xef, 0xbb, 0xbf]);

    test('should parse a message preceded by a UTF-8 byte order mark', () => {
        const readBuffer = new ReadBuffer();
        readBuffer.append(Buffer.concat([utf8ByteOrderMark, Buffer.from(JSON.stringify(testMessage) + '\n')]));

        expect(readBuffer.readMessage()).toEqual(testMessage);
        expect(readBuffer.readMessage()).toBeNull();
    });

    test('should parse a CRLF-terminated message whose byte order mark is split across chunks', () => {
        const readBuffer = new ReadBuffer();
        readBuffer.append(utf8ByteOrderMark.subarray(0, 1));
        readBuffer.append(Buffer.concat([utf8ByteOrderMark.subarray(1), Buffer.from(JSON.stringify(testMessage) + '\r\n')]));

        expect(readBuffer.readMessage()).toEqual(testMessage);
    });

    test('should keep a U+FEFF character that is part of the message', () => {
        const readBuffer = new ReadBuffer();
        const message: JSONRPCMessage = { jsonrpc: '2.0', method: 'test', params: { text: String.fromCharCode(0xfeff) + 'hello' } };
        readBuffer.append(Buffer.from(JSON.stringify(message) + '\n'));

        expect(readBuffer.readMessage()).toEqual(message);
    });
});
