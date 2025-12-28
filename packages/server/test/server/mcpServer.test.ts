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

    it("should allow middleware to communicate via ctx.state", async () => {
        const server = new McpServer({ name: "test", version: "1.0" });
        server.use(async (ctx, next) => {
            ctx.state.value = 1;
            await next();
        });
        server.use(async (ctx, next) => {
            ctx.state.value = (ctx.state.value as number) + 1;
            await next();
        });

        // Use a tool list request to trigger the chain
        server.tool(
            "test-tool",
            {},
            async () => ({ content: [{ type: "text", text: "ok" }] }),
        );

        let capturedState: any;
        server.use(async (ctx, next) => {
            capturedState = ctx.state;
            await next();
        });

        let resolveSend: () => void;
        const sendPromise = new Promise<void>((resolve) => {
            resolveSend = resolve;
        });

        const transport = {
            start: vi.fn(),
            send: vi.fn().mockImplementation(async () => {
                resolveSend();
            }),
            close: vi.fn(),
        };
        await server.connect(transport as any);
        // @ts-ignore
        const onMsg = (server.server.transport as any).onmessage;
        onMsg({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "test-tool", arguments: {} },
        });

        await sendPromise;

        expect(capturedState).toBeDefined();
        expect(capturedState.value).toBe(2);
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

    // ============================================================
    // Real World Use Case Integration Tests
    // ============================================================

    describe("Real World Use Cases", () => {
        it("Logging: should observe request method and capture response timing", async () => {
            const logs: { method: string; durationMs: number }[] = [];

            server.use(async (context, next) => {
                const start = Date.now();
                const method = (context.request as any).method || "unknown";

                await next();

                const durationMs = Date.now() - start;
                logs.push({ method, durationMs });
            });

            server.tool("fast-tool", {}, async () => {
                return { content: [{ type: "text", text: "done" }] };
            });

            await simulateCallTool("fast-tool");

            expect(logs).toHaveLength(1);
            expect(logs[0]!.method).toBe("tools/call");
            expect(logs[0]!.durationMs).toBeGreaterThanOrEqual(0);
        });

        it("Auth: should short-circuit unauthorized requests", async () => {
            const VALID_TOKEN = "secret-token";

            server.use(async (context, next) => {
                // Simulate checking for an auth token in extra/authInfo
                const authInfo = (context.extra as any)?.authInfo;

                // In real usage, authInfo would come from the transport.
                // For this test, we simulate by checking a header-like property.
                // Since we can't inject authInfo easily, we'll check a custom property.
                const token = (context.request as any).params?._authToken;

                if (token !== VALID_TOKEN) {
                    // Short-circuit: don't call next(), effectively blocking the request
                    // In a real scenario, you might throw an error or set a response
                    throw new Error("Unauthorized");
                }

                await next();
            });

            server.tool("protected-tool", {}, async () => {
                return { content: [{ type: "text", text: "secret data" }] };
            });

            // Simulate unauthorized request (no token)
            const response = await simulateCallTool("protected-tool");

            expect((response as any).error).toBeDefined();
            expect((response as any).error.message).toContain("Unauthorized");
        });

        it("Activity Aggregation: should intercept tools/list and count discoveries", async () => {
            let toolListCount = 0;
            let toolCallCount = 0;

            server.use(async (context, next) => {
                const method = (context.request as any).method;

                if (method === "tools/list") {
                    toolListCount++;
                } else if (method === "tools/call") {
                    toolCallCount++;
                }

                await next();
            });

            server.tool("my-tool", {}, async () => ({ content: [] }));

            // Simulate tools/list
            let serverOnMessage: any;
            let resolveSend: any;
            const p = new Promise((r) => (resolveSend = r));
            const transport = {
                start: vi.fn(),
                send: vi.fn().mockImplementation(() => resolveSend()),
                close: vi.fn(),
                set onmessage(h: any) {
                    serverOnMessage = h;
                },
            };
            await server.connect(transport);

            // First: tools/list
            serverOnMessage({
                jsonrpc: "2.0",
                id: 1,
                method: "tools/list",
                params: {},
            });
            await p;

            // Second: tools/call (need new promise)
            let resolveSend2: any;
            const p2 = new Promise((r) => (resolveSend2 = r));
            transport.send.mockImplementation(() => resolveSend2());

            serverOnMessage({
                jsonrpc: "2.0",
                id: 2,
                method: "tools/call",
                params: { name: "my-tool", arguments: {} },
            });
            await p2;

            expect(toolListCount).toBe(1);
            expect(toolCallCount).toBe(1);
        });
    });

    // ============================================================
    // Failure Mode Verification Tests
    // ============================================================

    describe("Failure Mode Verification", () => {
        it("Pre-next: error thrown before next() maps to JSON-RPC error", async () => {
            server.use(async (context, next) => {
                // Error thrown BEFORE calling next()
                throw new Error("Pre-next failure");
            });

            server.tool("test-tool", {}, async () => ({ content: [] }));

            const response = await simulateCallTool("test-tool");

            // Should be a proper JSON-RPC error response
            expect((response as any).jsonrpc).toBe("2.0");
            expect((response as any).id).toBe(1);
            expect((response as any).error).toBeDefined();
            expect((response as any).error.message).toContain(
                "Pre-next failure",
            );
            // Server should not crash - we got a response
        });

        it("Post-next: error thrown after next() maps to JSON-RPC error", async () => {
            server.use(async (context, next) => {
                await next();
                // Error thrown AFTER calling next()
                throw new Error("Post-next failure");
            });

            server.tool("test-tool", {}, async () => ({ content: [] }));

            const response = await simulateCallTool("test-tool");

            // Should be a proper JSON-RPC error response
            expect((response as any).jsonrpc).toBe("2.0");
            expect((response as any).id).toBe(1);
            expect((response as any).error).toBeDefined();
            expect((response as any).error.message).toContain(
                "Post-next failure",
            );
        });

        it("Handler: error thrown in tool handler returns error result (SDK behavior)", async () => {
            // No middleware - test pure handler error
            server.tool("failing-tool", {}, async () => {
                throw new Error("Handler failure");
            });

            const response = await simulateCallTool("failing-tool");

            // MCP SDK converts handler errors to result with isError: true
            // (not JSON-RPC error - this is intentional SDK behavior)
            expect((response as any).jsonrpc).toBe("2.0");
            expect((response as any).id).toBe(1);
            expect((response as any).result).toBeDefined();
            expect((response as any).result.isError).toBe(true);
            expect((response as any).result.content[0]!.text).toContain(
                "Handler failure",
            );
        });

        it("Multiple middleware: error in second middleware propagates correctly", async () => {
            const sequence: string[] = [];

            server.use(async (context, next) => {
                sequence.push("mw1 start");
                try {
                    await next();
                } catch (e) {
                    sequence.push("mw1 caught");
                    throw e; // Re-throw to propagate
                }
                sequence.push("mw1 end");
            });

            server.use(async (context, next) => {
                sequence.push("mw2 start");
                throw new Error("mw2 failure");
            });

            server.tool("test-tool", {}, async () => ({ content: [] }));

            const response = await simulateCallTool("test-tool");

            expect((response as any).error).toBeDefined();
            expect((response as any).error.message).toContain("mw2 failure");
            // Verify mw1 caught the error
            expect(sequence).toContain("mw1 caught");
            // mw1 end should NOT be in sequence since error was re-thrown
            expect(sequence).not.toContain("mw1 end");
        });

        it("Error contains proper JSON-RPC error code", async () => {
            server.use(async (context, next) => {
                throw new Error("Generic middleware error");
            });

            server.tool("test-tool", {}, async () => ({ content: [] }));

            const response = await simulateCallTool("test-tool");

            expect((response as any).error).toBeDefined();
            // JSON-RPC internal error code is -32603
            expect((response as any).error.code).toBeDefined();
            expect(typeof (response as any).error.code).toBe("number");
        });
    });
});
