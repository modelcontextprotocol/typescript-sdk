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

describe('multi-byte UTF-8 across chunk boundaries', () => {
    test('should preserve em-dash split across two chunks', () => {
        const readBuffer = new ReadBuffer();
        const message: JSONRPCMessage = { jsonrpc: '2.0', method: 'test', params: { text: 'a—b' } };
        const fullBuffer = Buffer.from(JSON.stringify(message) + '\n');
        // Em-dash (U+2014) encodes as three bytes (0xE2 0x80 0x94). Split the buffer
        // mid-character so the first chunk ends inside the em-dash sequence.
        const splitIndex = fullBuffer.indexOf(0xe2) + 1;

        readBuffer.append(fullBuffer.subarray(0, splitIndex));
        readBuffer.append(fullBuffer.subarray(splitIndex));

        expect(readBuffer.readMessage()).toEqual(message);
    });

    test('should preserve emoji split across two chunks', () => {
        const readBuffer = new ReadBuffer();
        const message: JSONRPCMessage = { jsonrpc: '2.0', method: 'test', params: { text: '✅' } };
        const fullBuffer = Buffer.from(JSON.stringify(message) + '\n');
        // ✅ (U+2705) encodes as three bytes (0xE2 0x9C 0x85). Split inside it.
        const splitIndex = fullBuffer.indexOf(0xe2) + 2;

        readBuffer.append(fullBuffer.subarray(0, splitIndex));
        readBuffer.append(fullBuffer.subarray(splitIndex));

        expect(readBuffer.readMessage()).toEqual(message);
    });

    test('should preserve four-byte emoji split across chunks', () => {
        const readBuffer = new ReadBuffer();
        const message: JSONRPCMessage = { jsonrpc: '2.0', method: 'test', params: { text: '🎉' } };
        const fullBuffer = Buffer.from(JSON.stringify(message) + '\n');
        // 🎉 (U+1F389) encodes as four bytes (0xF0 0x9F 0x8E 0x89). Split mid-sequence.
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
