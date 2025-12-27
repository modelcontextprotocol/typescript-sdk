import { McpServer } from "../../src/server/mcp.js";
import { JSONRPCMessage } from "@modelcontextprotocol/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

describe("McpServer Middleware", () => {
    let server: McpServer;

    beforeEach(() => {
        server = new McpServer({
            name: "test-server",
            version: "1.0.0",
        });
    });

    // Helper to simulate a tool call and capture the response
    async function simulateCallTool(toolName: string): Promise<JSONRPCMessage> {
        let serverOnMessage: (message: any) => Promise<void>;
        let capturedResponse: JSONRPCMessage | undefined;
        let resolveSend: () => void;
        const sendPromise = new Promise<void>((resolve) => {
            resolveSend = resolve;
        });

        const transport = {
            start: vi.fn(),
            send: vi.fn().mockImplementation(async (msg) => {
                capturedResponse = msg as JSONRPCMessage;
                resolveSend();
            }),
            close: vi.fn(),
            set onmessage(handler: any) {
                serverOnMessage = handler;
            },
        };

        await server.connect(transport);

        const request = {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
                name: toolName,
                arguments: {},
            },
        };

        if (!serverOnMessage!) {
            throw new Error("Server did not attach onMessage listener");
        }

        // Trigger request
        serverOnMessage(request);

        // Wait for response
        await sendPromise;

        return capturedResponse!;
    }

    it("should execute middleware in registration order (Onion model)", async () => {
        const sequence: string[] = [];

        server.use(async (context, next) => {
            sequence.push("mw1 start");
            await next();
            sequence.push("mw1 end");
        });

        server.use(async (context, next) => {
            sequence.push("mw2 start");
            await next();
            sequence.push("mw2 end");
        });

        server.tool("test-tool", {}, async () => {
            sequence.push("handler");
            return { content: [{ type: "text", text: "result" }] };
        });

        await simulateCallTool("test-tool");

        expect(sequence).toEqual([
            "mw1 start",
            "mw2 start",
            "handler",
            "mw2 end",
            "mw1 end",
        ]);
    });

    it("should short-circuit if next() is not called", async () => {
        const sequence: string[] = [];

        server.use(async (context, next) => {
            sequence.push("mw1 start");
            // next() NOT called
            sequence.push("mw1 end");
        });

        server.use(async (context, next) => {
            sequence.push("mw2 start");
            await next();
        });

        server.tool("test-tool", {}, async () => {
            sequence.push("handler");
            return { content: [{ type: "text", text: "result" }] };
        });

        await simulateCallTool("test-tool");

        // mw2 and handler should NOT run
        expect(sequence).toEqual(["mw1 start", "mw1 end"]);
    });

    it("should execute middleware for other methods (e.g. tools/list)", async () => {
        // For this check, we need to simulate tools/list.
        // We can adapt our helper or just copy-paste a simplified version here for variety.
        const sequence: string[] = [];
        server.use(async (context, next) => {
            sequence.push("mw");
            await next();
        });

        // Register a dummy tool to ensure tools/list handler is set up
        server.tool("dummy", {}, async () => ({ content: [] }));

        let serverOnMessage: any;
        let resolveSend: any;
        const p = new Promise((r) => resolveSend = r);
        const transport = {
            start: vi.fn(),
            send: vi.fn().mockImplementation(() => resolveSend()),
            close: vi.fn(),
            set onmessage(h: any) {
                serverOnMessage = h;
            },
        };
        await server.connect(transport);

        serverOnMessage({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/list",
            params: {},
        });
        await p;

        expect(sequence).toEqual(["mw"]);
    });

    it("should allow middleware to catch errors from downstream", async () => {
        server.use(async (context, next) => {
            try {
                await next();
            } catch (e) {
                // Suppress error
            }
        });

        server.tool("error-tool", {}, async () => {
            throw new Error("Boom");
        });

        const response = await simulateCallTool("error-tool");

        // Since middleware swallowed the error, the handler returns undefined (or whatever executed).
        // Actually, if handler throws and middleware catches, `result` in `_executeRequest` will be undefined.
        // The server transport might expect a result.
        // Typescript core SDK might throw if result is missing maybe?
        // Or it sends a success response with "undefined"?

        // Let's check what response we got. If error was swallowed, it shouldn't be an error response.
        expect((response as any).error).toBeUndefined();
    });

    it("should propagate errors if middleware throws", async () => {
        server.use(async (context, next) => {
            throw new Error("Middleware Error");
        });

        server.tool("test-tool", {}, async () => ({ content: [] }));

        const response = await simulateCallTool("test-tool");

        // Standard JSON-RPC error response
        expect((response as any).error).toBeDefined();
        expect((response as any).error.message).toContain("Middleware Error");
    });

    it("should throw an error if next() is called multiple times", async () => {
        server.use(async (context, next) => {
            await next();
            await next(); // Second call should throw
        });

        server.tool("test-tool", {}, async () => ({ content: [] }));

        const response = await simulateCallTool("test-tool");

        // Expect an error response due to double-call
        expect((response as any).error).toBeDefined();
        expect((response as any).error.message).toContain(
            "next() called multiple times",
        );
    });

    it("should throw an error if use() is called after connect()", async () => {
        const transport = {
            start: vi.fn(),
            send: vi.fn(),
            close: vi.fn(),
            set onmessage(_handler: any) {},
        };

        await server.connect(transport);

        // Trying to register middleware after connect should throw
        expect(() => {
            server.use(async (context, next) => {
                await next();
            });
        }).toThrow("Cannot register middleware after the server has started");
    });
});
