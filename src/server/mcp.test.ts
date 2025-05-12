import { McpServer } from "./mcp.js";
import { Client } from "../client/index.js";
import { InMemoryTransport } from "../inMemory.js";
import { z } from "zod";
import {
  ListToolsResultSchema,
  CallToolResultSchema,
  ListResourcesResultSchema,
  ListResourceTemplatesResultSchema,
  ReadResourceResultSchema,
  ListPromptsResultSchema,
  GetPromptResultSchema,
  CompleteResultSchema,
  LoggingMessageNotificationSchema,
  Notification,
} from "../types.js";
import { ResourceTemplate } from "./mcp.js";
import { completable } from "./completable.js";
import { UriTemplate } from "../shared/uriTemplate.js";

describe("McpServer", () => {
  test("should expose underlying Server instance", () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });

    expect(mcpServer.server).toBeDefined();
  });

  test("should allow sending notifications via Server", async () => {
    const mcpServer = new McpServer(
      {
        name: "test server",
        version: "1.0",
      },
      { capabilities: { logging: {} } },
    );

    const notifications: Notification[] = []
    const client = new Client({
      name: "test client",
      version: "1.0",
    });
    client.fallbackNotificationHandler = async (notification) => {
      notifications.push(notification)
    }

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.server.connect(serverTransport),
    ]);

    // This should work because we're using the underlying server
    await expect(
      mcpServer.server.sendLoggingMessage({
        level: "info",
        data: "Test log message",
      }),
    ).resolves.not.toThrow();

    expect(notifications).toMatchObject([
      {
        "method": "notifications/message",
        params: {
          level: "info",
          data: "Test log message",
        }
      }
    ])
  });
});

describe("ResourceTemplate", () => {
  test("should create ResourceTemplate with string pattern", () => {
    const template = new ResourceTemplate("test://{category}/{id}", {
      list: undefined,
    });
    expect(template.uriTemplate.toString()).toBe("test://{category}/{id}");
    expect(template.listCallback).toBeUndefined();
  });

  test("should create ResourceTemplate with UriTemplate", () => {
    const uriTemplate = new UriTemplate("test://{category}/{id}");
    const template = new ResourceTemplate(uriTemplate, { list: undefined });
    expect(template.uriTemplate).toBe(uriTemplate);
    expect(template.listCallback).toBeUndefined();
  });

  test("should create ResourceTemplate with list callback", async () => {
    const list = jest.fn().mockResolvedValue({
      resources: [{ name: "Test", uri: "test://example" }],
    });

    const template = new ResourceTemplate("test://{id}", { list });
    expect(template.listCallback).toBe(list);

    const abortController = new AbortController();
    const result = await template.listCallback?.({
      signal: abortController.signal,
      requestId: 'not-implemented',
      sendRequest: () => { throw new Error("Not implemented") },
      sendNotification: () => { throw new Error("Not implemented") }
    });
    expect(result?.resources).toHaveLength(1);
    expect(list).toHaveBeenCalled();
  });
});

describe("tool()", () => {
  test("should register zero-argument tool", async () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });
    const notifications: Notification[] = []
    const client = new Client({
      name: "test client",
      version: "1.0",
    });
    client.fallbackNotificationHandler = async (notification) => {
      notifications.push(notification)
    }

    mcpServer.tool("test", async () => ({
      content: [
        {
          type: "text",
          text: "Test response",
        },
      ],
    }));

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.connect(serverTransport),
    ]);

    const result = await client.request(
      {
        method: "tools/list",
      },
      ListToolsResultSchema,
    );

    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe("test");
    expect(result.tools[0].inputSchema).toEqual({
      type: "object",
    });

    // Adding the tool before the connection was established means no notification was sent
    expect(notifications).toHaveLength(0)

    // Adding another tool triggers the update notification
    mcpServer.tool("test2", async () => ({
      content: [
        {
          type: "text",
          text: "Test response",
        },
      ],
    }));

    // Yield event loop to let the notification fly
    await new Promise(process.nextTick)

    expect(notifications).toMatchObject([
      {
        method: "notifications/tools/list_changed",
      }
    ])
  });

  test("should update existing tool", async () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });
    const notifications: Notification[] = []
    const client = new Client({
      name: "test client",
      version: "1.0",
    });
    client.fallbackNotificationHandler = async (notification) => {
      notifications.push(notification)
    }

    // Register initial tool
    const tool = mcpServer.tool("test", async () => ({
      content: [
        {
          type: "text",
          text: "Initial response",
        },
      ],
    }));

    // Update the tool
    tool.update({
      callback: async () => ({
        content: [
          {
            type: "text",
            text: "Updated response",
          },
        ],
      })
    });

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.connect(serverTransport),
    ]);

    // Call the tool and verify we get the updated response
    const result = await client.request(
      {
        method: "tools/call",
        params: {
          name: "test",
        },
      },
      CallToolResultSchema,
    );

    expect(result.content).toEqual([
      {
        type: "text",
        text: "Updated response",
      },
    ]);

    // Update happened before transport was connected, so no notifications should be expected
    expect(notifications).toHaveLength(0)
  });

  test("should update tool with schema", async () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });
    const notifications: Notification[] = []
    const client = new Client({
      name: "test client",
      version: "1.0",
    });
    client.fallbackNotificationHandler = async (notification) => {
      notifications.push(notification)
    }

    // Register initial tool
    const tool = mcpServer.tool(
      "test",
      {
        name: z.string(),
      },
      async ({ name }) => ({
        content: [
          {
            type: "text",
            text: `Initial: ${name}`,
          },
        ],
      }),
    );

    // Update the tool with a different schema
    tool.update({
      paramsSchema: {
        name: z.string(),
        value: z.number(),
      },
      callback: async ({name, value}) => ({
        content: [
          {
            type: "text",
            text: `Updated: ${name}, ${value}`,
          },
        ],
      })
    });

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.connect(serverTransport),
    ]);

    // Verify the schema was updated
    const listResult = await client.request(
      {
        method: "tools/list",
      },
      ListToolsResultSchema,
    );

    expect(listResult.tools[0].inputSchema).toMatchObject({
      properties: {
        name: { type: "string" },
        value: { type: "number" },
      },
    });

    // Call the tool with the new schema
    const callResult = await client.request(
      {
        method: "tools/call",
        params: {
          name: "test",
          arguments: {
            name: "test",
            value: 42,
          },
        },
      },
      CallToolResultSchema,
    );

    expect(callResult.content).toEqual([
      {
        type: "text",
        text: "Updated: test, 42",
      },
    ]);

    // Update happened before transport was connected, so no notifications should be expected
    expect(notifications).toHaveLength(0)
  });

  test("should send tool list changed notifications when connected", async () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });
    const notifications: Notification[] = []
    const client = new Client({
      name: "test client",
      version: "1.0",
    });
    client.fallbackNotificationHandler = async (notification) => {
      notifications.push(notification)
    }

    // Register initial tool
    const tool = mcpServer.tool("test", async () => ({
      content: [
        {
          type: "text",
          text: "Test response",
        },
      ],
    }));

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.connect(serverTransport),
    ]);

    expect(notifications).toHaveLength(0)

    // Now update the tool
    tool.update({
      callback: async () => ({
        content: [
          {
            type: "text",
            text: "Updated response",
          },
        ],
      })
    });

    // Yield event loop to let the notification fly
    await new Promise(process.nextTick)

    expect(notifications).toMatchObject([
      { method: "notifications/tools/list_changed" }
    ])

    // Now delete the tool
    tool.remove();

    // Yield event loop to let the notification fly
    await new Promise(process.nextTick)

    expect(notifications).toMatchObject([
      { method: "notifications/tools/list_changed" },
      { method: "notifications/tools/list_changed" },
    ])
  });

  test("should register tool with params", async () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });
    const client = new Client({
      name: "test client",
      version: "1.0",
    });

    mcpServer.tool(
      "test",
      {
        name: z.string(),
        value: z.number(),
      },
      async ({ name, value }) => ({
        content: [
          {
            type: "text",
            text: `${name}: ${value}`,
          },
        ],
      }),
    );

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.server.connect(serverTransport),
    ]);

    const result = await client.request(
      {
        method: "tools/list",
      },
      ListToolsResultSchema,
    );

    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe("test");
    expect(result.tools[0].inputSchema).toMatchObject({
      type: "object",
      properties: {
        name: { type: "string" },
        value: { type: "number" },
      },
    });
  });

  test("should register tool with description", async () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });
    const client = new Client({
      name: "test client",
      version: "1.0",
    });

    mcpServer.tool("test", "Test description", async () => ({
      content: [
        {
          type: "text",
          text: "Test response",
        },
      ],
    }));

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.server.connect(serverTransport),
    ]);

    const result = await client.request(
      {
        method: "tools/list",
      },
      ListToolsResultSchema,
    );

    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe("test");
    expect(result.tools[0].description).toBe("Test description");
  });
  
  test("should register tool with annotations", async () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });
    const client = new Client({
      name: "test client",
      version: "1.0",
    });

    mcpServer.tool("test", { title: "Test Tool", readOnlyHint: true }, async () => ({
      content: [
        {
          type: "text",
          text: "Test response",
        },
      ],
    }));

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.server.connect(serverTransport),
    ]);

    const result = await client.request(
      {
        method: "tools/list",
      },
      ListToolsResultSchema,
    );

    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe("test");
    expect(result.tools[0].annotations).toEqual({ title: "Test Tool", readOnlyHint: true });
  });
  
  test("should register tool with params and annotations", async () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });
    const client = new Client({
      name: "test client",
      version: "1.0",
    });

    mcpServer.tool(
      "test", 
      { name: z.string() },
      { title: "Test Tool", readOnlyHint: true },
      async ({ name }) => ({
        content: [{ type: "text", text: `Hello, ${name}!` }]
      })
    );

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.server.connect(serverTransport),
    ]);

    const result = await client.request(
      { method: "tools/list" },
      ListToolsResultSchema,
    );

    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe("test");
    expect(result.tools[0].inputSchema).toMatchObject({
      type: "object",
      properties: { name: { type: "string" } }
    });
    expect(result.tools[0].annotations).toEqual({ title: "Test Tool", readOnlyHint: true });
  });
  
  test("should register tool with description, params, and annotations", async () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });
    const client = new Client({
      name: "test client",
      version: "1.0",
    });

    mcpServer.tool(
      "test", 
      "A tool with everything",
      { name: z.string() },
      { title: "Complete Test Tool", readOnlyHint: true, openWorldHint: false },
      async ({ name }) => ({
        content: [{ type: "text", text: `Hello, ${name}!` }]
      })
    );

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.server.connect(serverTransport),
    ]);

    const result = await client.request(
      { method: "tools/list" },
      ListToolsResultSchema,
    );

    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe("test");
    expect(result.tools[0].description).toBe("A tool with everything");
    expect(result.tools[0].inputSchema).toMatchObject({
      type: "object",
      properties: { name: { type: "string" } }
    });
    expect(result.tools[0].annotations).toEqual({ 
      title: "Complete Test Tool", 
      readOnlyHint: true,
      openWorldHint: false
    });
  });

  test("should register tool with description, empty params, and annotations", async () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });
    const client = new Client({
      name: "test client",
      version: "1.0",
    });

    mcpServer.tool(
      "test", 
      "A tool with everything but empty params",
      {},
      { title: "Complete Test Tool with empty params", readOnlyHint: true, openWorldHint: false },
      async () => ({
        content: [{ type: "text", text: "Test response" }]
      })
    );

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.server.connect(serverTransport),
    ]);

    const result = await client.request(
      { method: "tools/list" },
      ListToolsResultSchema,
    );

    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe("test");
    expect(result.tools[0].description).toBe("A tool with everything but empty params");
    expect(result.tools[0].inputSchema).toMatchObject({
      type: "object",
      properties: {}
    });
    expect(result.tools[0].annotations).toEqual({ 
      title: "Complete Test Tool with empty params", 
      readOnlyHint: true,
      openWorldHint: false
    });
  });

  test("should validate tool args", async () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });

    const client = new Client(
      {
        name: "test client",
        version: "1.0",
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    mcpServer.tool(
      "test",
      {
        name: z.string(),
        value: z.number(),
      },
      async ({ name, value }) => ({
        content: [
          {
            type: "text",
            text: `${name}: ${value}`,
          },
        ],
      }),
    );

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.server.connect(serverTransport),
    ]);

    await expect(
      client.request(
        {
          method: "tools/call",
          params: {
            name: "test",
            arguments: {
              name: "test",
              value: "not a number",
            },
          },
        },
        CallToolResultSchema,
      ),
    ).rejects.toThrow(/Invalid arguments/);
  });

  test("should prevent duplicate tool registration", () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });

    mcpServer.tool("test", async () => ({
      content: [
        {
          type: "text",
          text: "Test response",
        },
      ],
    }));

    expect(() => {
      mcpServer.tool("test", async () => ({
        content: [
          {
            type: "text",
            text: "Test response 2",
          },
        ],
      }));
    }).toThrow(/already registered/);
  });

  test("should allow registering multiple tools", () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });

    // This should succeed
    mcpServer.tool("tool1", () => ({ content: [] }));

    // This should also succeed and not throw about request handlers
    mcpServer.tool("tool2", () => ({ content: [] }));
  });

  test("should pass sessionId to tool callback via RequestHandlerExtra", async () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });

    const client = new Client(
      {
        name: "test client",
        version: "1.0",
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    let receivedSessionId: string | undefined;
    mcpServer.tool("test-tool", async (extra) => {
      receivedSessionId = extra.sessionId;
      return {
        content: [
          {
            type: "text",
            text: "Test response",
          },
        ],
      };
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    // Set a test sessionId on the server transport
    serverTransport.sessionId = "test-session-123";

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.server.connect(serverTransport),
    ]);

    await client.request(
      {
        method: "tools/call",
        params: {
          name: "test-tool",
        },
      },
      CallToolResultSchema,
    );

    expect(receivedSessionId).toBe("test-session-123");
  });

  test("should pass requestId to tool callback via RequestHandlerExtra", async () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });

    const client = new Client(
      {
        name: "test client",
        version: "1.0",
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    let receivedRequestId: string | number | undefined;
    mcpServer.tool("request-id-test", async (extra) => {
      receivedRequestId = extra.requestId;
      return {
        content: [
          {
            type: "text",
            text: `Received request ID: ${extra.requestId}`,
          },
        ],
      };
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.server.connect(serverTransport),
    ]);

    const result = await client.request(
      {
        method: "tools/call",
        params: {
          name: "request-id-test",
        },
      },
      CallToolResultSchema,
    );

    expect(receivedRequestId).toBeDefined();
    expect(typeof receivedRequestId === 'string' || typeof receivedRequestId === 'number').toBe(true);
    expect(result.content[0].text).toContain("Received request ID:");
  });

  test("should provide sendNotification within tool call", async () => {
    const mcpServer = new McpServer(
      {
        name: "test server",
        version: "1.0",
      },
      { capabilities: { logging: {} } },
    );

    const client = new Client(
      {
        name: "test client",
        version: "1.0",
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    let receivedLogMessage: string | undefined;
    const loggingMessage = "hello here is log message 1";

    client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
      receivedLogMessage = notification.params.data as string;
    });

    mcpServer.tool("test-tool", async ({ sendNotification }) => {
      await sendNotification({ method: "notifications/message", params: { level: "debug", data: loggingMessage } });
      return {
        content: [
          {
            type: "text",
            text: "Test response",
          },
        ],
      };
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      mcpServer.server.connect(serverTransport),
    ]);
    await client.request(
      {
        method: "tools/call",
        params: {
          name: "test-tool",
        },
      },
      CallToolResultSchema,
    );
    expect(receivedLogMessage).toBe(loggingMessage);
  });

  test("should allow client to call server tools", async () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });

    const client = new Client(
      {
        name: "test client",
        version: "1.0",
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    mcpServer.tool(
      "test",
      "Test tool",
      {
        input: z.string(),
      },
      async ({ input }) => ({
        content: [
          {
            type: "text",
            text: `Processed: ${input}`,
          },
        ],
      }),
    );

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.server.connect(serverTransport),
    ]);

    const result = await client.request(
      {
        method: "tools/call",
        params: {
          name: "test",
          arguments: {
            input: "hello",
          },
        },
      },
      CallToolResultSchema,
    );

    expect(result.content).toEqual([
      {
        type: "text",
        text: "Processed: hello",
      },
    ]);
  });

  test("should handle server tool errors gracefully", async () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });

    const client = new Client(
      {
        name: "test client",
        version: "1.0",
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    mcpServer.tool("error-test", async () => {
      throw new Error("Tool execution failed");
    });

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.server.connect(serverTransport),
    ]);

    const result = await client.request(
      {
        method: "tools/call",
        params: {
          name: "error-test",
        },
      },
      CallToolResultSchema,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: "text",
        text: "Tool execution failed",
      },
    ]);
  });

  test("should throw McpError for invalid tool name", async () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });

    const client = new Client(
      {
        name: "test client",
        version: "1.0",
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    mcpServer.tool("test-tool", async () => ({
      content: [
        {
          type: "text",
          text: "Test response",
        },
      ],
    }));

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.server.connect(serverTransport),
    ]);

    await expect(
      client.request(
        {
          method: "tools/call",
          params: {
            name: "nonexistent-tool",
          },
        },
        CallToolResultSchema,
      ),
    ).rejects.toThrow(/Tool nonexistent-tool not found/);
  });
});

describe("resource()", () => {
  test("should register resource with uri and readCallback", async () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });
    const client = new Client({
      name: "test client",
      version: "1.0",
    });

    mcpServer.resource("test", "test://resource", async () => ({
      contents: [
        {
          uri: "test://resource",
          text: "Test content",
        },
      ],
    }));

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.server.connect(serverTransport),
    ]);

    const result = await client.request(
      {
        method: "resources/list",
      },
      ListResourcesResultSchema,
    );

    expect(result.resources).toHaveLength(1);
    expect(result.resources[0].name).toBe("test");
    expect(result.resources[0].uri).toBe("test://resource");
  });

  test("should update resource with uri", async () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });
    const notifications: Notification[] = [];
    const client = new Client({
      name: "test client",
      version: "1.0",
    });
    client.fallbackNotificationHandler = async (notification) => {
      notifications.push(notification);
    };

    // Register initial resource
    const resource = mcpServer.resource("test", "test://resource", async () => ({
      contents: [
        {
          uri: "test://resource",
          text: "Initial content",
        },
      ],
    }));

    // Update the resource
    resource.update({
      callback: async () => ({
        contents: [
          {
            uri: "test://resource",
            text: "Updated content",
          },
        ],
      })
    });

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.connect(serverTransport),
    ]);

    // Read the resource and verify we get the updated content
    const result = await client.request(
      {
        method: "resources/read",
        params: {
          uri: "test://resource",
        },
      },
      ReadResourceResultSchema,
    );

    expect(result.contents).toHaveLength(1);
    expect(result.contents[0].text).toBe("Updated content");

    // Update happened before transport was connected, so no notifications should be expected
    expect(notifications).toHaveLength(0);
  });

  test("should update resource template", async () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });
    const notifications: Notification[] = [];
    const client = new Client({
      name: "test client",
      version: "1.0",
    });
    client.fallbackNotificationHandler = async (notification) => {
      notifications.push(notification);
    };

    // Register initial resource template
    const resourceTemplate = mcpServer.resource(
      "test",
      new ResourceTemplate("test://resource/{id}", { list: undefined }),
      async (uri) => ({
        contents: [
          {
            uri: uri.href,
            text: "Initial content",
          },
        ],
      }),
    );

    // Update the resource template
    resourceTemplate.update({
      callback: async (uri) => ({
        contents: [
          {
            uri: uri.href,
            text: "Updated content",
          },
        ],
      })
    });

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.connect(serverTransport),
    ]);

    // Read the resource and verify we get the updated content
    const result = await client.request(
      {
        method: "resources/read",
        params: {
          uri: "test://resource/123",
        },
      },
      ReadResourceResultSchema,
    );

    expect(result.contents).toHaveLength(1);
    expect(result.contents[0].text).toBe("Updated content");

    // Update happened before transport was connected, so no notifications should be expected
    expect(notifications).toHaveLength(0);
  });

  test("should send resource list changed notification when connected", async () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });
    const notifications: Notification[] = [];
    const client = new Client({
      name: "test client",
      version: "1.0",
    });
    client.fallbackNotificationHandler = async (notification) => {
      notifications.push(notification);
    };

    // Register initial resource
    const resource = mcpServer.resource("test", "test://resource", async () => ({
      contents: [
        {
          uri: "test://resource",
          text: "Test content",
        },
      ],
    }));

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.connect(serverTransport),
    ]);

    expect(notifications).toHaveLength(0);

    // Now update the resource while connected
    resource.update({
      callback: async () => ({
        contents: [
          {
            uri: "test://resource",
            text: "Updated content",
          },
        ],
      })
    });

    // Yield event loop to let the notification fly
    await new Promise(process.nextTick);

    expect(notifications).toMatchObject([
      { method: "notifications/resources/list_changed" }
    ]);
  });

  test("should remove resource and send notification when connected", async () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });
    const notifications: Notification[] = [];
    const client = new Client({
      name: "test client",
      version: "1.0",
    });
    client.fallbackNotificationHandler = async (notification) => {
      notifications.push(notification);
    };

    // Register initial resources
    const resource1 = mcpServer.resource("resource1", "test://resource1", async () => ({
      contents: [{ uri: "test://resource1", text: "Resource 1 content" }],
    }));

    mcpServer.resource("resource2", "test://resource2", async () => ({
      contents: [{ uri: "test://resource2", text: "Resource 2 content" }],
    }));

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.connect(serverTransport),
    ]);

    // Verify both resources are registered
    let result = await client.request(
      { method: "resources/list" },
      ListResourcesResultSchema,
    );

    expect(result.resources).toHaveLength(2);

    expect(notifications).toHaveLength(0);

    // Remove a resource
    resource1.remove()

    // Yield event loop to let the notification fly
    await new Promise(process.nextTick);

    // Should have sent notification
    expect(notifications).toMatchObject([
      { method: "notifications/resources/list_changed" }
    ]);

    // Verify the resource was removed
    result = await client.request(
      { method: "resources/list" },
      ListResourcesResultSchema,
    );

    expect(result.resources).toHaveLength(1);
    expect(result.resources[0].uri).toBe("test://resource2");
  });

  test("should remove resource template and send notification when connected", async () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });
    const notifications: Notification[] = [];
    const client = new Client({
      name: "test client",
      version: "1.0",
    });
    client.fallbackNotificationHandler = async (notification) => {
      notifications.push(notification);
    };

    // Register resource template
    const resourceTemplate = mcpServer.resource(
      "template",
      new ResourceTemplate("test://resource/{id}", { list: undefined }),
      async (uri) => ({
        contents: [
          {
            uri: uri.href,
            text: "Template content",
          },
        ],
      }),
    );

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.connect(serverTransport),
    ]);

    // Verify template is registered
    const result = await client.request(
      { method: "resources/templates/list" },
      ListResourceTemplatesResultSchema,
    );

    expect(result.resourceTemplates).toHaveLength(1);
    expect(notifications).toHaveLength(0);

    // Remove the template
    resourceTemplate.remove()

    // Yield event loop to let the notification fly
    await new Promise(process.nextTick);

    // Should have sent notification
    expect(notifications).toMatchObject([
      { method: "notifications/resources/list_changed" }
    ]);

    // Verify the template was removed
    const result2 = await client.request(
      { method: "resources/templates/list" },
      ListResourceTemplatesResultSchema,
    );

    expect(result2.resourceTemplates).toHaveLength(0);
  });

  test("should register resource with metadata", async () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });
    const client = new Client({
      name: "test client",
      version: "1.0",
    });

    mcpServer.resource(
      "test",
      "test://resource",
      {
        description: "Test resource",
        mimeType: "text/plain",
      },
      async () => ({
        contents: [
          {
            uri: "test://resource",
            text: "Test content",
          },
        ],
      }),
    );

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.server.connect(serverTransport),
    ]);

    const result = await client.request(
      {
        method: "resources/list",
      },
      ListResourcesResultSchema,
    );

    expect(result.resources).toHaveLength(1);
    expect(result.resources[0].description).toBe("Test resource");
    expect(result.resources[0].mimeType).toBe("text/plain");
  });

  test("should register resource template", async () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });
    const client = new Client({
      name: "test client",
      version: "1.0",
    });

    mcpServer.resource(
      "test",
      new ResourceTemplate("test://resource/{id}", { list: undefined }),
      async () => ({
        contents: [
          {
            uri: "test://resource/123",
            text: "Test content",
          },
        ],
      }),
    );

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.server.connect(serverTransport),
    ]);

    const result = await client.request(
      {
        method: "resources/templates/list",
      },
      ListResourceTemplatesResultSchema,
    );

    expect(result.resourceTemplates).toHaveLength(1);
    expect(result.resourceTemplates[0].name).toBe("test");
    expect(result.resourceTemplates[0].uriTemplate).toBe(
      "test://resource/{id}",
    );
  });

  test("should register resource template with listCallback", async () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });
    const client = new Client({
      name: "test client",
      version: "1.0",
    });

    mcpServer.resource(
      "test",
      new ResourceTemplate("test://resource/{id}", {
        list: async () => ({
          resources: [
            {
              name: "Resource 1",
              uri: "test://resource/1",
            },
            {
              name: "Resource 2",
              uri: "test://resource/2",
            },
          ],
        }),
      }),
      async (uri) => ({
        contents: [
          {
            uri: uri.href,
            text: "Test content",
          },
        ],
      }),
    );

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.server.connect(serverTransport),
    ]);

    const result = await client.request(
      {
        method: "resources/list",
      },
      ListResourcesResultSchema,
    );

    expect(result.resources).toHaveLength(2);
    expect(result.resources[0].name).toBe("Resource 1");
    expect(result.resources[0].uri).toBe("test://resource/1");
    expect(result.resources[1].name).toBe("Resource 2");
    expect(result.resources[1].uri).toBe("test://resource/2");
  });

  test("should pass template variables to readCallback", async () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });
    const client = new Client({
      name: "test client",
      version: "1.0",
    });

    mcpServer.resource(
      "test",
      new ResourceTemplate("test://resource/{category}/{id}", {
        list: undefined,
      }),
      async (uri, { category, id }) => ({
        contents: [
          {
            uri: uri.href,
            text: `Category: ${category}, ID: ${id}`,
          },
        ],
      }),
    );

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.server.connect(serverTransport),
    ]);

    const result = await client.request(
      {
        method: "resources/read",
        params: {
          uri: "test://resource/books/123",
        },
      },
      ReadResourceResultSchema,
    );

    expect(result.contents[0].text).toBe("Category: books, ID: 123");
  });

  test("should prevent duplicate resource registration", () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });

    mcpServer.resource("test", "test://resource", async () => ({
      contents: [
        {
          uri: "test://resource",
          text: "Test content",
        },
      ],
    }));

    expect(() => {
      mcpServer.resource("test2", "test://resource", async () => ({
        contents: [
          {
            uri: "test://resource",
            text: "Test content 2",
          },
        ],
      }));
    }).toThrow(/already registered/);
  });

  test("should allow registering multiple resources", () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });

    // This should succeed
    mcpServer.resource("resource1", "test://resource1", async () => ({
      contents: [
        {
          uri: "test://resource1",
          text: "Test content 1",
        },
      ],
    }));

    // This should also succeed and not throw about request handlers
    mcpServer.resource("resource2", "test://resource2", async () => ({
      contents: [
        {
          uri: "test://resource2",
          text: "Test content 2",
        },
      ],
    }));
  });

  test("should prevent duplicate resource template registration", () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });

    mcpServer.resource(
      "test",
      new ResourceTemplate("test://resource/{id}", { list: undefined }),
      async () => ({
        contents: [
          {
            uri: "test://resource/123",
            text: "Test content",
          },
        ],
      }),
    );

    expect(() => {
      mcpServer.resource(
        "test",
        new ResourceTemplate("test://resource/{id}", { list: undefined }),
        async () => ({
          contents: [
            {
              uri: "test://resource/123",
              text: "Test content 2",
            },
          ],
        }),
      );
    }).toThrow(/already registered/);
  });

  test("should handle resource read errors gracefully", async () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });
    const client = new Client({
      name: "test client",
      version: "1.0",
    });

    mcpServer.resource("error-test", "test://error", async () => {
      throw new Error("Resource read failed");
    });

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.server.connect(serverTransport),
    ]);

    await expect(
      client.request(
        {
          method: "resources/read",
          params: {
            uri: "test://error",
          },
        },
        ReadResourceResultSchema,
      ),
    ).rejects.toThrow(/Resource read failed/);
  });

  test("should throw McpError for invalid resource URI", async () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });
    const client = new Client({
      name: "test client",
      version: "1.0",
    });

    mcpServer.resource("test", "test://resource", async () => ({
      contents: [
        {
          uri: "test://resource",
          text: "Test content",
        },
      ],
    }));

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.server.connect(serverTransport),
    ]);

    await expect(
      client.request(
        {
          method: "resources/read",
          params: {
            uri: "test://nonexistent",
          },
        },
        ReadResourceResultSchema,
      ),
    ).rejects.toThrow(/Resource test:\/\/nonexistent not found/);
  });

  test("should support completion of resource template parameters", async () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });

    const client = new Client(
      {
        name: "test client",
        version: "1.0",
      },
      {
        capabilities: {
          resources: {},
        },
      },
    );

    mcpServer.resource(
      "test",
      new ResourceTemplate("test://resource/{category}", {
        list: undefined,
        complete: {
          category: () => ["books", "movies", "music"],
        },
      }),
      async () => ({
        contents: [
          {
            uri: "test://resource/test",
            text: "Test content",
          },
        ],
      }),
    );

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.server.connect(serverTransport),
    ]);

    const result = await client.request(
      {
        method: "completion/complete",
        params: {
          ref: {
            type: "ref/resource",
            uri: "test://resource/{category}",
          },
          argument: {
            name: "category",
            value: "",
          },
        },
      },
      CompleteResultSchema,
    );

    expect(result.completion.values).toEqual(["books", "movies", "music"]);
    expect(result.completion.total).toBe(3);
  });

  test("should support filtered completion of resource template parameters", async () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });

    const client = new Client(
      {
        name: "test client",
        version: "1.0",
      },
      {
        capabilities: {
          resources: {},
        },
      },
    );

    mcpServer.resource(
      "test",
      new ResourceTemplate("test://resource/{category}", {
        list: undefined,
        complete: {
          category: (test: string) =>
            ["books", "movies", "music"].filter((value) =>
              value.startsWith(test),
            ),
        },
      }),
      async () => ({
        contents: [
          {
            uri: "test://resource/test",
            text: "Test content",
          },
        ],
      }),
    );

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.server.connect(serverTransport),
    ]);

    const result = await client.request(
      {
        method: "completion/complete",
        params: {
          ref: {
            type: "ref/resource",
            uri: "test://resource/{category}",
          },
          argument: {
            name: "category",
            value: "m",
          },
        },
      },
      CompleteResultSchema,
    );

    expect(result.completion.values).toEqual(["movies", "music"]);
    expect(result.completion.total).toBe(2);
  });

  test("should pass requestId to resource callback via RequestHandlerExtra", async () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });

    const client = new Client(
      {
        name: "test client",
        version: "1.0",
      },
      {
        capabilities: {
          resources: {},
        },
      },
    );

    let receivedRequestId: string | number | undefined;
    mcpServer.resource("request-id-test", "test://resource", async (_uri, extra) => {
      receivedRequestId = extra.requestId;
      return {
        contents: [
          {
            uri: "test://resource",
            text: `Received request ID: ${extra.requestId}`,
          },
        ],
      };
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.server.connect(serverTransport),
    ]);

    const result = await client.request(
      {
        method: "resources/read",
        params: {
          uri: "test://resource",
        },
      },
      ReadResourceResultSchema,
    );

    expect(receivedRequestId).toBeDefined();
    expect(typeof receivedRequestId === 'string' || typeof receivedRequestId === 'number').toBe(true);
    expect(result.contents[0].text).toContain("Received request ID:");
  });
});

describe("prompt()", () => {
  test("should register zero-argument prompt", async () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });
    const client = new Client({
      name: "test client",
      version: "1.0",
    });

    mcpServer.prompt("test", async () => ({
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: "Test response",
          },
        },
      ],
    }));

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.server.connect(serverTransport),
    ]);

    const result = await client.request(
      {
        method: "prompts/list",
      },
      ListPromptsResultSchema,
    );

    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0].name).toBe("test");
    expect(result.prompts[0].arguments).toBeUndefined();
  });
  test("should update existing prompt", async () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });
    const notifications: Notification[] = [];
    const client = new Client({
      name: "test client",
      version: "1.0",
    });
    client.fallbackNotificationHandler = async (notification) => {
      notifications.push(notification);
    };

    // Register initial prompt
    const prompt = mcpServer.prompt("test", async () => ({
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: "Initial response",
          },
        },
      ],
    }));

    // Update the prompt
    prompt.update({
      callback: async () => ({
        messages: [
          {
            role: "assistant",
            content: {
              type: "text",
              text: "Updated response",
            },
          },
        ],
      })
    });

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.connect(serverTransport),
    ]);

    // Call the prompt and verify we get the updated response
    const result = await client.request(
      {
        method: "prompts/get",
        params: {
          name: "test",
        },
      },
      GetPromptResultSchema,
    );

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].content.text).toBe("Updated response");

    // Update happened before transport was connected, so no notifications should be expected
    expect(notifications).toHaveLength(0);
  });

  test("should update prompt with schema", async () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });
    const notifications: Notification[] = [];
    const client = new Client({
      name: "test client",
      version: "1.0",
    });
    client.fallbackNotificationHandler = async (notification) => {
      notifications.push(notification);
    };

    // Register initial prompt
    const prompt = mcpServer.prompt(
      "test",
      {
        name: z.string(),
      },
      async ({ name }) => ({
        messages: [
          {
            role: "assistant",
            content: {
              type: "text",
              text: `Initial: ${name}`,
            },
          },
        ],
      }),
    );

    // Update the prompt with a different schema
    prompt.update({
      argsSchema: {
        name: z.string(),
        value: z.string(),
      },
      callback: async ({name, value}) => ({
        messages: [
          {
            role: "assistant",
            content: {
              type: "text",
              text: `Updated: ${name}, ${value}`,
            },
          },
        ],
      })
    });

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.connect(serverTransport),
    ]);

    // Verify the schema was updated
    const listResult = await client.request(
      {
        method: "prompts/list",
      },
      ListPromptsResultSchema,
    );

    expect(listResult.prompts[0].arguments).toHaveLength(2);
    expect(listResult.prompts[0].arguments?.map(a => a.name).sort()).toEqual(["name", "value"]);

    // Call the prompt with the new schema
    const getResult = await client.request(
      {
        method: "prompts/get",
        params: {
          name: "test",
          arguments: {
            name: "test",
            value: "value",
          },
        },
      },
      GetPromptResultSchema,
    );

    expect(getResult.messages).toHaveLength(1);
    expect(getResult.messages[0].content.text).toBe("Updated: test, value");

    // Update happened before transport was connected, so no notifications should be expected
    expect(notifications).toHaveLength(0);
  });

  test("should send prompt list changed notification when connected", async () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });
    const notifications: Notification[] = [];
    const client = new Client({
      name: "test client",
      version: "1.0",
    });
    client.fallbackNotificationHandler = async (notification) => {
      notifications.push(notification);
    };

    // Register initial prompt
    const prompt = mcpServer.prompt("test", async () => ({
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: "Test response",
          },
        },
      ],
    }));

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.connect(serverTransport),
    ]);

    expect(notifications).toHaveLength(0);

    // Now update the prompt while connected
    prompt.update({
      callback: async () => ({
        messages: [
          {
            role: "assistant",
            content: {
              type: "text",
              text: "Updated response",
            },
          },
        ],
      })
    });

    // Yield event loop to let the notification fly
    await new Promise(process.nextTick);

    expect(notifications).toMatchObject([
      { method: "notifications/prompts/list_changed" }
    ]);
  });

  test("should remove prompt and send notification when connected", async () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });
    const notifications: Notification[] = [];
    const client = new Client({
      name: "test client",
      version: "1.0",
    });
    client.fallbackNotificationHandler = async (notification) => {
      notifications.push(notification);
    };

    // Register initial prompts
    const prompt1 = mcpServer.prompt("prompt1", async () => ({
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: "Prompt 1 response",
          },
        },
      ],
    }));

    mcpServer.prompt("prompt2", async () => ({
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: "Prompt 2 response",
          },
        },
      ],
    }));

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.connect(serverTransport),
    ]);

    // Verify both prompts are registered
    let result = await client.request(
      { method: "prompts/list" },
      ListPromptsResultSchema,
    );

    expect(result.prompts).toHaveLength(2);
    expect(result.prompts.map(p => p.name).sort()).toEqual(["prompt1", "prompt2"]);

    expect(notifications).toHaveLength(0);

    // Remove a prompt
    prompt1.remove()

    // Yield event loop to let the notification fly
    await new Promise(process.nextTick);

    // Should have sent notification
    expect(notifications).toMatchObject([
      { method: "notifications/prompts/list_changed" }
    ]);

    // Verify the prompt was removed
    result = await client.request(
      { method: "prompts/list" },
      ListPromptsResultSchema,
    );

    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0].name).toBe("prompt2");
  });

  test("should register prompt with args schema", async () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });
    const client = new Client({
      name: "test client",
      version: "1.0",
    });

    mcpServer.prompt(
      "test",
      {
        name: z.string(),
        value: z.string(),
      },
      async ({ name, value }) => ({
        messages: [
          {
            role: "assistant",
            content: {
              type: "text",
              text: `${name}: ${value}`,
            },
          },
        ],
      }),
    );

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.server.connect(serverTransport),
    ]);

    const result = await client.request(
      {
        method: "prompts/list",
      },
      ListPromptsResultSchema,
    );

    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0].name).toBe("test");
    expect(result.prompts[0].arguments).toEqual([
      { name: "name", required: true },
      { name: "value", required: true },
    ]);
  });

  test("should register prompt with description", async () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });
    const client = new Client({
      name: "test client",
      version: "1.0",
    });

    mcpServer.prompt("test", "Test description", async () => ({
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: "Test response",
          },
        },
      ],
    }));

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.server.connect(serverTransport),
    ]);

    const result = await client.request(
      {
        method: "prompts/list",
      },
      ListPromptsResultSchema,
    );

    expect(result.prompts).toHaveLength(1);
    expect(result.prompts[0].name).toBe("test");
    expect(result.prompts[0].description).toBe("Test description");
  });

  test("should validate prompt args", async () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });

    const client = new Client(
      {
        name: "test client",
        version: "1.0",
      },
      {
        capabilities: {
          prompts: {},
        },
      },
    );

    mcpServer.prompt(
      "test",
      {
        name: z.string(),
        value: z.string().min(3),
      },
      async ({ name, value }) => ({
        messages: [
          {
            role: "assistant",
            content: {
              type: "text",
              text: `${name}: ${value}`,
            },
          },
        ],
      }),
    );

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.server.connect(serverTransport),
    ]);

    await expect(
      client.request(
        {
          method: "prompts/get",
          params: {
            name: "test",
            arguments: {
              name: "test",
              value: "ab", // Too short
            },
          },
        },
        GetPromptResultSchema,
      ),
    ).rejects.toThrow(/Invalid arguments/);
  });

  test("should prevent duplicate prompt registration", () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });

    mcpServer.prompt("test", async () => ({
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: "Test response",
          },
        },
      ],
    }));

    expect(() => {
      mcpServer.prompt("test", async () => ({
        messages: [
          {
            role: "assistant",
            content: {
              type: "text",
              text: "Test response 2",
            },
          },
        ],
      }));
    }).toThrow(/already registered/);
  });

  test("should allow registering multiple prompts", () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });

    // This should succeed
    mcpServer.prompt("prompt1", async () => ({
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: "Test response 1",
          },
        },
      ],
    }));

    // This should also succeed and not throw about request handlers
    mcpServer.prompt("prompt2", async () => ({
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: "Test response 2",
          },
        },
      ],
    }));
  });

  test("should allow registering prompts with arguments", () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });

    // This should succeed
    mcpServer.prompt(
      "echo",
      { message: z.string() },
      ({ message }) => ({
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: `Please process this message: ${message}`
          }
        }]
      })
    );
  });

  test("should allow registering both resources and prompts with completion handlers", () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });

    // Register a resource with completion
    mcpServer.resource(
      "test",
      new ResourceTemplate("test://resource/{category}", {
        list: undefined,
        complete: {
          category: () => ["books", "movies", "music"],
        },
      }),
      async () => ({
        contents: [
          {
            uri: "test://resource/test",
            text: "Test content",
          },
        ],
      }),
    );

    // Register a prompt with completion
    mcpServer.prompt(
      "echo",
      { message: completable(z.string(), () => ["hello", "world"]) },
      ({ message }) => ({
        messages: [{
          role: "user",
          content: {
            type: "text",
            text: `Please process this message: ${message}`
          }
        }]
      })
    );
  });

  test("should throw McpError for invalid prompt name", async () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });

    const client = new Client(
      {
        name: "test client",
        version: "1.0",
      },
      {
        capabilities: {
          prompts: {},
        },
      },
    );

    mcpServer.prompt("test-prompt", async () => ({
      messages: [
        {
          role: "assistant",
          content: {
            type: "text",
            text: "Test response",
          },
        },
      ],
    }));

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.server.connect(serverTransport),
    ]);

    await expect(
      client.request(
        {
          method: "prompts/get",
          params: {
            name: "nonexistent-prompt",
          },
        },
        GetPromptResultSchema,
      ),
    ).rejects.toThrow(/Prompt nonexistent-prompt not found/);
  });

  test("should support completion of prompt arguments", async () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });

    const client = new Client(
      {
        name: "test client",
        version: "1.0",
      },
      {
        capabilities: {
          prompts: {},
        },
      },
    );

    mcpServer.prompt(
      "test-prompt",
      {
        name: completable(z.string(), () => ["Alice", "Bob", "Charlie"]),
      },
      async ({ name }) => ({
        messages: [
          {
            role: "assistant",
            content: {
              type: "text",
              text: `Hello ${name}`,
            },
          },
        ],
      }),
    );

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.server.connect(serverTransport),
    ]);

    const result = await client.request(
      {
        method: "completion/complete",
        params: {
          ref: {
            type: "ref/prompt",
            name: "test-prompt",
          },
          argument: {
            name: "name",
            value: "",
          },
        },
      },
      CompleteResultSchema,
    );

    expect(result.completion.values).toEqual(["Alice", "Bob", "Charlie"]);
    expect(result.completion.total).toBe(3);
  });

  test("should support filtered completion of prompt arguments", async () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });

    const client = new Client(
      {
        name: "test client",
        version: "1.0",
      },
      {
        capabilities: {
          prompts: {},
        },
      },
    );

    mcpServer.prompt(
      "test-prompt",
      {
        name: completable(z.string(), (test) =>
          ["Alice", "Bob", "Charlie"].filter((value) => value.startsWith(test)),
        ),
      },
      async ({ name }) => ({
        messages: [
          {
            role: "assistant",
            content: {
              type: "text",
              text: `Hello ${name}`,
            },
          },
        ],
      }),
    );

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.server.connect(serverTransport),
    ]);

    const result = await client.request(
      {
        method: "completion/complete",
        params: {
          ref: {
            type: "ref/prompt",
            name: "test-prompt",
          },
          argument: {
            name: "name",
            value: "A",
          },
        },
      },
      CompleteResultSchema,
    );

    expect(result.completion.values).toEqual(["Alice"]);
    expect(result.completion.total).toBe(1);
  });

  test("should pass requestId to prompt callback via RequestHandlerExtra", async () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });

    const client = new Client(
      {
        name: "test client",
        version: "1.0",
      },
      {
        capabilities: {
          prompts: {},
        },
      },
    );

    let receivedRequestId: string | number | undefined;
    mcpServer.prompt("request-id-test", async (extra) => {
      receivedRequestId = extra.requestId;
      return {
        messages: [
          {
            role: "assistant",
            content: {
              type: "text",
              text: `Received request ID: ${extra.requestId}`,
            },
          },
        ],
      };
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.server.connect(serverTransport),
    ]);

    const result = await client.request(
      {
        method: "prompts/get",
        params: {
          name: "request-id-test",
        },
      },
      GetPromptResultSchema,
    );

    expect(receivedRequestId).toBeDefined();
    expect(typeof receivedRequestId === 'string' || typeof receivedRequestId === 'number').toBe(true);
    expect(result.messages[0].content.text).toContain("Received request ID:");
  });
});
