import {generateSessionId, LoopbackTransport} from "./loopback.js";
import {JSONRPCNotification, JSONRPCRequest, JSONRPCResponse} from "../types.js";

describe("LoopbackTransport - Happy Path", () => {
    let clientTransport: LoopbackTransport;
    let serverTransport: LoopbackTransport;

    beforeEach(async () => {
        clientTransport = new LoopbackTransport();
        serverTransport = new LoopbackTransport();

        // Set onmessage handlers so that start() does not throw
        clientTransport.onmessage = () => {
        };
        serverTransport.onmessage = () => {
        };

        // Connect the transports
        clientTransport.connect(serverTransport);

        // Start them so that they check for proper registration and connection
        await clientTransport.start();
        await serverTransport.start();
    });

    afterEach(async () => {
        await clientTransport.close();
        await serverTransport.close();
    });

    test("client sends JSONRPCRequest to server", async () => {
        const request: JSONRPCRequest = {
            jsonrpc: "2.0",
            id: 1,
            method: "echo",
            params: {message: "hello"},
        };

        const serverReceived = new Promise<JSONRPCRequest>((resolve) => {
            // Overwrite server's onmessage to capture the request
            serverTransport.onmessage = (msg) => resolve(msg as JSONRPCRequest);
        });

        await clientTransport.send(request);
        const received = await serverReceived;
        expect(received).toEqual(request);
    });

    test("server sends JSONRPCResponse to client", async () => {
        const response: JSONRPCResponse = {
            jsonrpc: "2.0",
            id: 1,
            result: {message: "hi there!"},
        };

        const clientReceived = new Promise<JSONRPCResponse>((resolve) => {
            clientTransport.onmessage = (msg) => resolve(msg as JSONRPCResponse);
        });

        await serverTransport.send(response);
        const received = await clientReceived;
        expect(received).toEqual(response);
    });

    test("client sends JSONRPCNotification to server", async () => {
        const notification: JSONRPCNotification = {
            jsonrpc: "2.0",
            method: "notify",
            params: {alert: "test"},
        };

        const serverReceived = new Promise<JSONRPCNotification>((resolve) => {
            serverTransport.onmessage = (msg) => resolve(msg as JSONRPCNotification);
        });

        await clientTransport.send(notification);
        const received = await serverReceived;
        expect(received).toEqual(notification);
    });

    test("closing client transport calls server's onclose", async () => {
        const serverClosed = new Promise<void>((resolve) => {
            serverTransport.onclose = () => resolve();
        });
        await clientTransport.close();
        await expect(serverClosed).resolves.toBeUndefined();
    });

    test("closing server transport calls client's onclose", async () => {
        const clientClosed = new Promise<void>((resolve) => {
            clientTransport.onclose = () => resolve();
        });
        await serverTransport.close();
        await expect(clientClosed).resolves.toBeUndefined();
    });

    test("close() can be called multiple times safely", async () => {
        await clientTransport.close();
        await expect(clientTransport.close()).resolves.not.toThrow();
    });


});

describe("LoopbackTransport - Error Cases", () => {
    let transport: LoopbackTransport;
    let peer: LoopbackTransport;
    const sampleRequest: JSONRPCRequest = {
        jsonrpc: "2.0",
        id: 1,
        method: "test",
        params: {sample: "data"},
    };

    beforeEach(async () => {
        transport = new LoopbackTransport();
        peer = new LoopbackTransport();
        // Pre-register onmessage handlers for start() when needed.
        transport.onmessage = () => {
        };
        peer.onmessage = () => {
        };
    });


    test("start() should throw if onmessage is not set", async () => {
        const t = new LoopbackTransport();
        // Do not set t.onmessage.
        await expect(t.start()).rejects.toThrow(
            "Cannot start without being registered to a protocol"
        );
    });

    test("start() should throw if not connected", async () => {
        const t = new LoopbackTransport();
        t.onmessage = () => {
        };
        await expect(t.start()).rejects.toThrow("Cannot start without connect");
    });

    test("connect() should throw if one transport is already connected", () => {
        transport.connect(peer);
        const another = new LoopbackTransport();
        expect(() => transport.connect(another)).toThrow(
            "One of the transports is already connected"
        );
        expect(() => peer.connect(another)).toThrow(
            "One of the transports is already connected"
        );
    });

    test("send() should throw if peer's onmessage handler is not set", async () => {
        transport.connect(peer);
        // Remove peer's onmessage handler.
        peer.onmessage = undefined;
        await expect(transport.send(sampleRequest)).rejects.toThrow(
            "Peer transport has no onmessage handler set"
        );
    });

    test("send() should throw if sending after transport is closed", async () => {
        transport.connect(peer);
        transport.onmessage = () => {
        };
        peer.onmessage = () => {
        };
        await transport.close();
        await expect(transport.send(sampleRequest)).rejects.toThrow(
            "Peer transport has no onmessage handler set"
        );
    });
    test("send() handles JSON serialization errors gracefully", async () => {
        const transport = new LoopbackTransport({ stringifyMessage: true });
        const peer = new LoopbackTransport();
        transport.connect(peer);
        transport.onmessage = () => {};
        peer.onmessage = () => {};

        // eslint-disable-next-line @typescript-eslint/no-explicit-any  -- We are making a test for 'broken data'. The type is not important
        const circular: any = {};
        circular.self = circular; // intentionally cause serialization error

        await expect(transport.send(circular)).rejects.toThrow(/Error stringifying message/);
    });

});


describe("generateSessionId", () => {
    test("should return a non-empty string", () => {
        const id = generateSessionId();
        expect(typeof id).toBe("string");
        expect(id.length).toBeGreaterThan(0);
    });

    test("should return different values on successive calls", () => {
        const id1 = generateSessionId();
        const id2 = generateSessionId();
        expect(id1).not.toEqual(id2);
    });

    test("should generate expected session id using fallback when uuid returns falsy", () => {
        // Custom UUID generator that returns undefined to force fallback.
        const customUuid = () => undefined;
        // Custom functions for predictable output.
        const customNow = () => 1234567890;
        const customRandom = () => 0.123456; // Math.floor(0.123456 * 1e8) = 12345600

        const expected = "123456789012345600"; // "1234567890" + "12345600"
        const id = generateSessionId(customUuid, customNow, customRandom);
        expect(id).toBe(expected);
    });
});
