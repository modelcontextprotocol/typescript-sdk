import { SdkError, SdkErrorCode } from '../../src/errors/sdkErrors.js';
import { ReadBuffer } from '../../src/shared/stdio.js';
import type { JSONRPCMessage } from '../../src/types/index.js';

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

describe('chunked message assembly', () => {
    test('should assemble a message split across many small chunks', () => {
        const readBuffer = new ReadBuffer();
        const serialized = JSON.stringify(testMessage) + '\n';

        for (const char of serialized) {
            readBuffer.append(Buffer.from(char));
        }

        expect(readBuffer.readMessage()).toEqual(testMessage);
        expect(readBuffer.readMessage()).toBeNull();
    });

    test('should yield multiple messages from a single chunk', () => {
        const readBuffer = new ReadBuffer();
        const message1: JSONRPCMessage = { jsonrpc: '2.0', method: 'method1' };
        const message2: JSONRPCMessage = { jsonrpc: '2.0', method: 'method2' };
        const message3: JSONRPCMessage = { jsonrpc: '2.0', method: 'method3' };
        readBuffer.append(Buffer.from([message1, message2, message3].map(m => JSON.stringify(m) + '\n').join('')));

        expect(readBuffer.readMessage()).toEqual(message1);
        expect(readBuffer.readMessage()).toEqual(message2);
        expect(readBuffer.readMessage()).toEqual(message3);
        expect(readBuffer.readMessage()).toBeNull();
    });

    test('should handle a message boundary exactly at a chunk boundary', () => {
        const readBuffer = new ReadBuffer();
        readBuffer.append(Buffer.from(JSON.stringify(testMessage) + '\n'));
        readBuffer.append(Buffer.from(JSON.stringify(testMessage) + '\n'));

        expect(readBuffer.readMessage()).toEqual(testMessage);
        expect(readBuffer.readMessage()).toEqual(testMessage);
        expect(readBuffer.readMessage()).toBeNull();
    });

    test('should handle CRLF line endings', () => {
        const readBuffer = new ReadBuffer();
        readBuffer.append(Buffer.from(JSON.stringify(testMessage) + '\r\n'));

        expect(readBuffer.readMessage()).toEqual(testMessage);
    });

    test('should handle messages larger than the initial buffer capacity', () => {
        const readBuffer = new ReadBuffer();
        const bigMessage: JSONRPCMessage = {
            jsonrpc: '2.0',
            method: 'big',
            params: { payload: 'x'.repeat(100_000) }
        };

        const serialized = Buffer.from(JSON.stringify(bigMessage) + '\n');
        // Append in 1 KiB slices to exercise growth across many appends.
        for (let offset = 0; offset < serialized.length; offset += 1024) {
            readBuffer.append(serialized.subarray(offset, Math.min(offset + 1024, serialized.length)));
        }

        expect(readBuffer.readMessage()).toEqual(bigMessage);
        expect(readBuffer.readMessage()).toBeNull();
    });
});

describe('maxMessageBytes', () => {
    const expectMessageTooLarge = (fn: () => unknown) => {
        try {
            fn();
            throw new Error('expected readMessage to throw');
        } catch (error) {
            expect(error).toBeInstanceOf(SdkError);
            expect((error as SdkError).code).toBe(SdkErrorCode.MessageTooLarge);
        }
    };

    test('does not limit message size by default', () => {
        const readBuffer = new ReadBuffer();
        readBuffer.append(Buffer.from('x'.repeat(1_000_000)));
        expect(readBuffer.readMessage()).toBeNull();
    });

    test('accepts messages up to the limit', () => {
        const message: JSONRPCMessage = { jsonrpc: '2.0', method: 'test' };
        const serialized = JSON.stringify(message);
        const readBuffer = new ReadBuffer({ maxMessageBytes: serialized.length });
        readBuffer.append(Buffer.from(serialized + '\n'));

        expect(readBuffer.readMessage()).toEqual(message);
    });

    test('throws once for an incomplete oversized message, then recovers at the next newline', () => {
        const readBuffer = new ReadBuffer({ maxMessageBytes: 64 });

        // Oversized data with no newline: a single error when the limit is crossed...
        readBuffer.append(Buffer.from('x'.repeat(100)));
        expectMessageTooLarge(() => readBuffer.readMessage());

        // ...then silence while the rest of the oversized message streams in.
        readBuffer.append(Buffer.from('x'.repeat(100)));
        expect(readBuffer.readMessage()).toBeNull();
        readBuffer.append(Buffer.from('x'.repeat(100)));
        expect(readBuffer.readMessage()).toBeNull();

        // The tail of the oversized message ends at the newline; the following
        // message is processed normally.
        readBuffer.append(Buffer.from('xxx\n' + JSON.stringify(testMessage) + '\n'));
        expect(readBuffer.readMessage()).toEqual(testMessage);
        expect(readBuffer.readMessage()).toBeNull();
    });

    test('drops an oversized complete line and continues with the rest of the buffer', () => {
        const readBuffer = new ReadBuffer({ maxMessageBytes: 64 });
        readBuffer.append(Buffer.from('y'.repeat(200) + '\n' + JSON.stringify(testMessage) + '\n'));

        expectMessageTooLarge(() => readBuffer.readMessage());
        expect(readBuffer.readMessage()).toEqual(testMessage);
        expect(readBuffer.readMessage()).toBeNull();
    });

    test('counts incomplete bytes across many appends', () => {
        const readBuffer = new ReadBuffer({ maxMessageBytes: 64 });
        for (let i = 0; i < 6; i++) {
            readBuffer.append(Buffer.from('z'.repeat(10)));
            expect(readBuffer.readMessage()).toBeNull();
        }

        readBuffer.append(Buffer.from('z'.repeat(10)));
        expectMessageTooLarge(() => readBuffer.readMessage());
    });

    test('clear() resets oversized-message recovery state', () => {
        const readBuffer = new ReadBuffer({ maxMessageBytes: 64 });
        readBuffer.append(Buffer.from('x'.repeat(100)));
        expectMessageTooLarge(() => readBuffer.readMessage());

        readBuffer.clear();

        readBuffer.append(Buffer.from(JSON.stringify(testMessage) + '\n'));
        expect(readBuffer.readMessage()).toEqual(testMessage);
    });
});
