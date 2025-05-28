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
  TextContent,
} from "../types.js";
import { ResourceTemplate } from "./mcp.js";
import { completable } from "./completable.js";
import { UriTemplate } from "../shared/uriTemplate.js";

describe("McpServer", () => {
  /***
   * Test: Basic Server Instance
   */
  test("should expose underlying Server instance", () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });

    expect(mcpServer.server).toBeDefined();
  });

  /***
   * Test: Notification Sending via Server
   */
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

  /***
   * Test: Progress Notification with Message Field
   */
  test("should send progress notifications with message field", async () => {
    const mcpServer = new McpServer(
      {
        name: "test server",
        version: "1.0",
      }
    );

    // Create a tool that sends progress updates
    mcpServer.tool(
      "long-operation",
      "A long running operation with progress updates",
      {
        steps: z.number().min(1).describe("Number of steps to perform"),
      },
      async ({ steps }, { sendNotification, _meta }) => {
        const progressToken = _meta?.progressToken;

        if (progressToken) {
          // Send progress notification for each step
          for (let i = 1; i <= steps; i++) {
            await sendNotification({
              method: "notifications/progress",
              params: {
                progressToken,
                progress: i,
                total: steps,
                message: `Completed step ${i} of ${steps}`,
              },
            });
          }
        }

        return { content: [{ type: "text" as const, text: `Operation completed with ${steps} steps` }] };
      }
    );

    const progressUpdates: Array<{ progress: number, total?: number, message?: string }> = [];

    const client = new Client({
      name: "test client",
      version: "1.0",
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.server.connect(serverTransport),
    ]);

    // Call the tool with progress tracking
    await client.request(
      {
        method: "tools/call",
        params: {
          name: "long-operation",
          arguments: { steps: 3 },
          _meta: {
            progressToken: "progress-test-1"
          }
        }
      },
      CallToolResultSchema,
      {
        onprogress: (progress) => {
          progressUpdates.push(progress);
        }
      }
    );

    // Verify progress notifications were received with message field
    expect(progressUpdates).toHaveLength(3);
    expect(progressUpdates[0]).toMatchObject({
      progress: 1,
      total: 3,
      message: "Completed step 1 of 3",
    });
    expect(progressUpdates[1]).toMatchObject({
      progress: 2,
      total: 3,
      message: "Completed step 2 of 3",
    });
    expect(progressUpdates[2]).toMatchObject({
      progress: 3,
      total: 3,
      message: "Completed step 3 of 3",
    });
  });
});

describe("ResourceTemplate", () => {
  /***
   * Test: ResourceTemplate Creation with String Pattern
   */
  test("should create ResourceTemplate with string pattern", () => {
    const template = new ResourceTemplate("test://{category}/{id}", {
      list: undefined,
    });
    expect(template.uriTemplate.toString()).toBe("test://{category}/{id}");
    expect(template.listCallback).toBeUndefined();
  });

  /***
   * Test: ResourceTemplate Creation with UriTemplate Instance
   */
  test("should create ResourceTemplate with UriTemplate", () => {
    const uriTemplate = new UriTemplate("test://{category}/{id}");
    const template = new ResourceTemplate(uriTemplate, { list: undefined });
    expect(template.uriTemplate).toBe(uriTemplate);
    expect(template.listCallback).toBeUndefined();
  });

  /***
   * Test: ResourceTemplate with List Callback
   */
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
  /***
   * Test: Zero-Argument Tool Registration
   */
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

  /***
   * Test: Updating Existing Tool
   */
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

  /***
   * Test: Updating Tool with Schema
   */
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
      callback: async ({ name, value }) => ({
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

  /***
   * Test: Tool List Changed Notifications
   */
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

  /***
   * Test: Tool Registration with Parameters
   */
  test("should register tool with params", async () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });
    const client = new Client({
      name: "test client",
      version: "1.0",
    });

    // old api
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

    // new api
    mcpServer.registerTool(
      "test (new api)",
      {
        inputSchema: { name: z.string(), value: z.number() },
      },
      async ({ name, value }) => ({
        content: [{ type: "text", text: `${name}: ${value}` }],
      })
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

    expect(result.tools).toHaveLength(2);
    expect(result.tools[0].name).toBe("test");
    expect(result.tools[0].inputSchema).toMatchObject({
      type: "object",
      properties: {
        name: { type: "string" },
        value: { type: "number" },
      },
    });
    expect(result.tools[1].name).toBe("test (new api)");
    expect(result.tools[1].inputSchema).toEqual(result.tools[0].inputSchema);
  });

  /***
   * Test: Tool Registration with Description
   */
  test("should register tool with description", async () => {
    const mcpServer = new McpServer({
      name: "test server",
      version: "1.0",
    });
    const client = new Client({
      name: "test client",
      version: "1.0",
    });

    // old api
    mcpServer.tool("test", "Test description", async () => ({
      content: [
        {
          type: "text",
          text: "Test response",
        },
      ],
    }));

    // new api
    mcpServer.registerTool(
      "test (new api)",
      {
        description: "Test description",
      },
      async () => ({
        content: [
          {
            type: "text" as const,
            text: "Test response",
          },
        ],
      })
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

    expect(result.tools).toHaveLength(2);
    expect(result.tools[0].name).toBe("test");
    expect(result.tools[0].description).toBe("Test description");
    expect(result.tools[1].name).toBe("test (new api)");
    expect(result.tools[1].description).toBe("Test description");
  });

  /***
   * Test: Tool Registration with Annotations
   */
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

    mcpServer.registerTool(
      "test (new api)",
      {
        annotations: { title: "Test Tool", readOnlyHint: true },
      },
      async () => ({
        content: [
          {
            type: "text" as const,
            text: "Test response",
          },
        ],
      })
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

    expect(result.tools).toHaveLength(2);
    expect(result.tools[0].name).toBe("test");
    expect(result.tools[0].annotations).toEqual({ title: "Test Tool", readOnlyHint: true });
    expect(result.tools[1].name).toBe("test (new api)");
    expect(result.tools[1].annotations).toEqual({ title: "Test Tool", readOnlyHint: true });
  });

  /***
   * Test: Tool Registration with Parameters and Annotations
   */
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

    mcpServer.registerTool(
      "test (new api)",
      {
        inputSchema: { name: z.string() },
        annotations: { title: "Test Tool", readOnlyHint: true },
      },
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

    expect(result.tools).toHaveLength(2);
    expect(result.tools[0].name).toBe("test");
    expect(result.tools[0].inputSchema).toMatchObject({
      type: "object",
      properties: { name: { type: "string" } }
    });
    expect(result.tools[0].annotations).toEqual({ title: "Test Tool", readOnlyHint: true });
    expect(result.tools[1].name).toBe("test (new api)");
    expect(result.tools[1].inputSchema).toEqual(result.tools[0].inputSchema);
    expect(result.tools[1].annotations).toEqual(result.tools[0].annotations);
  });

  /***
   * Test: Tool Registration with Description, Parameters, and Annotations
   */
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

    mcpServer.registerTool(
      "test (new api)",
      {
        description: "A tool with everything",
        inputSchema: { name: z.string() },
        annotations: { title: "Complete Test Tool", readOnlyHint: true, openWorldHint: false },
      },
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

    expect(result.tools).toHaveLength(2);
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
    expect(result.tools[1].name).toBe("test (new api)");
    expect(result.tools[1].description).toBe("A tool with everything");
    expect(result.tools[1].inputSchema).toEqual(result.tools[0].inputSchema);
    expect(result.tools[1].annotations).toEqual(result.tools[0].annotations);
  });

  /***
   * Test: Tool Registration with Description, Empty Parameters, and Annotations
   */
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

    mcpServer.registerTool(
      "test (new api)",
      {
        description: "A tool with everything but empty params",
        inputSchema: {},
        annotations: { title: "Complete Test Tool with empty params", readOnlyHint: true, openWorldHint: false },
      },
      async () => ({
        content: [{ type: "text" as const, text: "Test response" }]
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

    expect(result.tools).toHaveLength(2);
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
    expect(result.tools[1].name).toBe("test (new api)");
    expect(result.tools[1].description).toBe("A tool with everything but empty params");
    expect(result.tools[1].inputSchema).toEqual(result.tools[0].inputSchema);
    expect(result.tools[1].annotations).toEqual(result.tools[0].annotations);
  });

  /***
   * Test: Tool Argument Validation
   */
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

    mcpServer.registerTool(
      "test (new api)",
      {
        inputSchema: {
          name: z.string(),
          value: z.number(),
        },
      },
      async ({ name, value }) => ({
        content: [
          {
            type: "text",
            text: `${name}: ${value}`,
          },
        ],
      })
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

    await expect(
      client.request(
        {
          method: "tools/call",
          params: {
            name: "test (new api)",
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

  /***
   * Test: Preventing Duplicate Tool Registration
   */
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

  /***
   * Test: Multiple Tool Registration
   */
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

  /***
   * Test: Tool with Output Schema and Structured Content
   */
  test("should support tool with outputSchema and structuredContent", async () => {
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

    // Register a tool with outputSchema
    mcpServer.registerTool(
      "test",
      {
        description: "Test tool with structured output",
        inputSchema: {
          input: z.string(),
        },
        outputSchema: {
          processedInput: z.string(),
          resultType: z.string(),
          timestamp: z.string()
        },
      },
      async ({ input }) => ({
        structuredContent: {
          processedInput: input,
          resultType: "structured",
          timestamp: "2023-01-01T00:00:00Z"
        },
        content: [
          {
            type: "text",
            text: JSON.stringify({
              processedInput: input,
              resultType: "structured",
              timestamp: "2023-01-01T00:00:00Z"
            }),
          },
        ]
      })
    );

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.server.connect(serverTransport),
    ]);

    // Verify the tool registration includes outputSchema
    const listResult = await client.request(
      {
        method: "tools/list",
      },
      ListToolsResultSchema,
    );

    expect(listResult.tools).toHaveLength(1);
    expect(listResult.tools[0].outputSchema).toMatchObject({
      type: "object",
      properties: {
        processedInput: { type: "string" },
        resultType: { type: "string" },
        timestamp: { type: "string" }
      },
      required: ["processedInput", "resultType", "timestamp"]
    });

    // Call the tool and verify it returns valid structuredContent
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

    expect(result.structuredContent).toBeDefined();
    const structuredContent = result.structuredContent as {
      processedInput: string;
      resultType: string;
      timestamp: string;
    };
    expect(structuredContent.processedInput).toBe("hello");
    expect(structuredContent.resultType).toBe("structured");
    expect(structuredContent.timestamp).toBe("2023-01-01T00:00:00Z");

    // For backward compatibility, content is auto-generated from structuredContent
    expect(result.content).toBeDefined();
    expect(result.content!).toHaveLength(1);
    expect(result.content![0]).toMatchObject({ type: "text" });
    const textContent = result.content![0] as TextContent;
    expect(JSON.parse(textContent.text)).toEqual(result.structuredContent);
  });

  /***
   * Test: Tool with Output Schema Must Provide Structured Content
   */
  test("should throw error when tool with outputSchema returns no structuredContent", async () => {
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

    // Register a tool with outputSchema that returns only content without structuredContent
    mcpServer.registerTool(
      "test",
      {
        description: "Test tool with output schema but missing structured content",
        inputSchema: {
          input: z.string(),
        },
        outputSchema: {
          processedInput: z.string(),
          resultType: z.string(),
        },
      },
      async ({ input }) => ({
        // Only return content without structuredContent
        content: [
          {
            type: "text",
            text: `Processed: ${input}`,
          },
        ],
      })
    );

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.server.connect(serverTransport),
    ]);

    // Call the tool and expect it to throw an error
    await expect(
      client.callTool({
        name: "test",
        arguments: {
          input: "hello",
        },
      }),
    ).rejects.toThrow(/Tool test has an output schema but no structured content was provided/);
  });

  /***
   * Test: Schema Validation Failure for Invalid Structured Content
   */
  test("should fail schema validation when tool returns invalid structuredContent", async () => {
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

    // Register a tool with outputSchema that returns invalid data
    mcpServer.registerTool(
      "test",
      {
        description: "Test tool with invalid structured output",
        inputSchema: {
          input: z.string(),
        },
        outputSchema: {
          processedInput: z.string(),
          resultType: z.string(),
          timestamp: z.string()
        },
      },
      async ({ input }) => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              processedInput: input,
              resultType: "structured",
              // Missing required 'timestamp' field
              someExtraField: "unexpected" // Extra field not in schema
            }),
          },
        ],
        structuredContent: {
          processedInput: input,
          resultType: "structured",
          // Missing required 'timestamp' field
          someExtraField: "unexpected" // Extra field not in schema
        },
      })
    );

    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    await Promise.all([
      client.connect(clientTransport),
      mcpServer.server.connect(serverTransport),
    ]);

    // Call the tool and expect it to throw a server-side validation error
    await expect(
      client.callTool({
        name: "test",
        arguments: {
          input: "hello",
        },
      }),
    ).rejects.toThrow(/Invalid structured content for tool test/);
  });

  /***
   * Test: Pass Session ID to Tool Callback
   */
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

  /***
   * Test: Pass Request ID to Tool Callback
   */
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
    expect(result.content && result.content[0].text).toContain("Received request ID:");
  });

  /***
   * Test: Send Notification within Tool Call
   */
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

  /***
   * Test: Client to Server Tool Call
   */
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

  /***
   * Test: Graceful Tool Error Handling
   */
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

  /***
   * Test: McpError for Invalid Tool Name
   */
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
  /***
   * Test: Resource Registration with URI and Read Callback
   */
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

  /***
   * Test: Update Resource with URI
   */
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

  /***
   * Test: Update Resource Template
   */
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

  /***
   * Test: Resource List Changed Notification
   */
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

  /***
   * Test: Remove Resource and Send Notification
   */
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

  /***
   * Test: Remove Resource Template and Send Notification
   */
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

  /***
   * Test: Resource Registration with Metadata
   */
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

  /***
   * Test: Resource Template Registration
   */
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

  /***
   * Test: Resource Template with List Callback
   */
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

  /***
   * Test: Template Variables to Read Callback
   */
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

  /***
   * Test: Preventing Duplicate Resource Registration
   */
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

  /***
   * Test: Multiple Resource Registration
   */
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

  /***
   * Test: Preventing Duplicate Resource Template Registration
   */
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

  /***
   * Test: Graceful Resource Read Error Handling
   */
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

  /***
   * Test: McpError for Invalid Resource URI
   */
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

  /***
   * Test: Resource Template Parameter Completion
   */
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

  /***
   * Test: Filtered Resource Template Parameter Completion
   */
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

  /***
   * Test: Pass Request ID to Resource Callback
   */
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
  /***
   * Test: Zero-Argument Prompt Registration
   */
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
  /***
   * Test: Updating Existing Prompt
   */
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

  /***
   * Test: Updating Prompt with Schema
   */
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
      callback: async ({ name, value }) => ({
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

  /***
   * Test: Prompt List Changed Notification
   */
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

  /***
   * Test: Remove Prompt and Send Notification
   */
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

  /***
   * Test: Prompt Registration with Arguments Schema
   */
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

  /***
   * Test: Prompt Registration with Description
   */
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

  /***
   * Test: Prompt Argument Validation
   */
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

  /***
   * Test: Preventing Duplicate Prompt Registration
   */
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

  /***
   * Test: Multiple Prompt Registration
   */
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

  /***
   * Test: Prompt Registration with Arguments
   */
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

  /***
   * Test: Resources and Prompts with Completion Handlers
   */
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

  /***
   * Test: McpError for Invalid Prompt Name
   */
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

  /***
   * Test: Prompt Argument Completion
   */
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

  /***
   * Test: Filtered Prompt Argument Completion
   */
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

  /***
   * Test: Pass Request ID to Prompt Callback
   */
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
