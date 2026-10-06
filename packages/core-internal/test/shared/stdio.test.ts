import { ReadBuffer, STDIO_DEFAULT_MAX_BUFFER_SIZE } from '../../src/shared/stdio';
import type { JSONRPCMessage } from '../../src/types/index';

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

describe('non-JSON line filtering', () => {
    test('should skip empty lines', () => {
        const readBuffer = new ReadBuffer();
        readBuffer.append(Buffer.from('\n\n' + JSON.stringify(testMessage) + '\n\n'));

        expect(readBuffer.readMessage()).toEqual(testMessage);
        expect(readBuffer.readMessage()).toBeNull();
    });

    test('should skip non-JSON lines before a valid message', () => {
        const readBuffer = new ReadBuffer();
        readBuffer.append(Buffer.from('Debug: Starting server\n' + 'Warning: Something happened\n' + JSON.stringify(testMessage) + '\n'));

        expect(readBuffer.readMessage()).toEqual(testMessage);
        expect(readBuffer.readMessage()).toBeNull();
    });

    test('should skip non-JSON lines interleaved with multiple valid messages', () => {
        const readBuffer = new ReadBuffer();
        const message1: JSONRPCMessage = { jsonrpc: '2.0', method: 'method1' };
        const message2: JSONRPCMessage = { jsonrpc: '2.0', method: 'method2' };

        readBuffer.append(
            Buffer.from(
                'Debug line 1\n' +
                    JSON.stringify(message1) +
                    '\n' +
                    'Debug line 2\n' +
                    'Another non-JSON line\n' +
                    JSON.stringify(message2) +
                    '\n'
            )
        );

        expect(readBuffer.readMessage()).toEqual(message1);
        expect(readBuffer.readMessage()).toEqual(message2);
        expect(readBuffer.readMessage()).toBeNull();
    });

    test('should preserve incomplete JSON at end of buffer until completed', () => {
        const readBuffer = new ReadBuffer();
        readBuffer.append(Buffer.from('{"jsonrpc": "2.0", "method": "test"'));
        expect(readBuffer.readMessage()).toBeNull();

        readBuffer.append(Buffer.from('}\n'));
        expect(readBuffer.readMessage()).toEqual({ jsonrpc: '2.0', method: 'test' });
    });

    test('should skip lines with unbalanced braces', () => {
        const readBuffer = new ReadBuffer();
        readBuffer.append(Buffer.from('{incomplete\n' + 'incomplete}\n' + JSON.stringify(testMessage) + '\n'));

        expect(readBuffer.readMessage()).toEqual(testMessage);
        expect(readBuffer.readMessage()).toBeNull();
    });

    test('should skip lines that look like JSON but fail to parse', () => {
        const readBuffer = new ReadBuffer();
        readBuffer.append(Buffer.from('{invalidJson: true}\n' + JSON.stringify(testMessage) + '\n'));

        expect(readBuffer.readMessage()).toEqual(testMessage);
        expect(readBuffer.readMessage()).toBeNull();
    });

    test('should tolerate leading/trailing whitespace around valid JSON', () => {
        const readBuffer = new ReadBuffer();
        const message: JSONRPCMessage = { jsonrpc: '2.0', method: 'test' };
        readBuffer.append(Buffer.from('  ' + JSON.stringify(message) + '  \n'));

        expect(readBuffer.readMessage()).toEqual(message);
    });

    test('should still throw on valid JSON that fails schema validation', () => {
        const readBuffer = new ReadBuffer();
        readBuffer.append(Buffer.from('{"not": "a jsonrpc message"}\n'));

        expect(() => readBuffer.readMessage()).toThrow();
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

describe('chunked message reading', () => {
    test('should handle large messages received across many small chunks without quadratic overhead', () => {
        const readBuffer = new ReadBuffer();
        const payloadText = 'a'.repeat(2 * 1024 * 1024); // 2 MB
        const message: JSONRPCMessage = {
            jsonrpc: '2.0',
            id: 'large-msg',
            result: { text: payloadText }
        };
        const raw = Buffer.from(JSON.stringify(message) + '\n');
        const chunkSize = 1024; // 1 KB chunks (over 2000 chunks)

        for (let offset = 0; offset < raw.length; offset += chunkSize) {
            readBuffer.append(raw.subarray(offset, Math.min(offset + chunkSize, raw.length)));
            // Read before final chunk should be null
            if (offset + chunkSize < raw.length) {
                expect(readBuffer.readMessage()).toBeNull();
            }
        }

        const parsed = readBuffer.readMessage();
        expect(parsed).toEqual(message);
        expect(readBuffer.readMessage()).toBeNull();
    });

    test('should extract multiple messages delivered in a single chunk', () => {
        const readBuffer = new ReadBuffer();
        const msg1: JSONRPCMessage = { jsonrpc: '2.0', method: 'm1' };
        const msg2: JSONRPCMessage = { jsonrpc: '2.0', method: 'm2' };
        const msg3: JSONRPCMessage = { jsonrpc: '2.0', method: 'm3' };

        const chunk = Buffer.from(JSON.stringify(msg1) + '\n' + JSON.stringify(msg2) + '\n' + JSON.stringify(msg3) + '\n');

        readBuffer.append(chunk);
        expect(readBuffer.readMessage()).toEqual(msg1);
        expect(readBuffer.readMessage()).toEqual(msg2);
        expect(readBuffer.readMessage()).toEqual(msg3);
        expect(readBuffer.readMessage()).toBeNull();
    });

    test('should handle consecutive messages split unevenly across chunks', () => {
        const readBuffer = new ReadBuffer();
        const msg1: JSONRPCMessage = { jsonrpc: '2.0', method: 'first' };
        const msg2: JSONRPCMessage = { jsonrpc: '2.0', method: 'second' };

        const str1 = JSON.stringify(msg1) + '\n';
        const str2 = JSON.stringify(msg2) + '\n';
        const full = Buffer.from(str1 + str2);

        // Split into 3 arbitrary chunks:
        // Chunk 1: middle of msg1
        // Chunk 2: end of msg1 + newline + start of msg2
        // Chunk 3: rest of msg2 + newline
        const split1 = Math.floor(str1.length / 2);
        const split2 = str1.length + Math.floor(str2.length / 2);

        readBuffer.append(full.subarray(0, split1));
        expect(readBuffer.readMessage()).toBeNull();

        readBuffer.append(full.subarray(split1, split2));
        expect(readBuffer.readMessage()).toEqual(msg1);
        expect(readBuffer.readMessage()).toBeNull();

        readBuffer.append(full.subarray(split2));
        expect(readBuffer.readMessage()).toEqual(msg2);
        expect(readBuffer.readMessage()).toBeNull();
    });

    test('should handle empty chunks gracefully', () => {
        const readBuffer = new ReadBuffer();
        const msg: JSONRPCMessage = { jsonrpc: '2.0', method: 'test' };

        readBuffer.append(Buffer.alloc(0));
        expect(readBuffer.readMessage()).toBeNull();

        readBuffer.append(Buffer.from(JSON.stringify(msg)));
        readBuffer.append(Buffer.alloc(0));
        expect(readBuffer.readMessage()).toBeNull();

        readBuffer.append(Buffer.from('\n'));
        readBuffer.append(Buffer.alloc(0));
        expect(readBuffer.readMessage()).toEqual(msg);
        expect(readBuffer.readMessage()).toBeNull();
    });
});
