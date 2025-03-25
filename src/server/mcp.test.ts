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

    const client = new Client({
      name: "test client",
      version: "1.0",
    });

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
    const client = new Client({
      name: "test client",
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
    expect(result.tools[0].inputSchema).toEqual({
      type: "object",
    });
  });

  test("should register tool with args schema", async () => {
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
      z.object({
        name: z.string(),
        value: z.number(),
      }),
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
      z.object({
        name: z.string(),
        value: z.number(),
      }),
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
      z.object({
        input: z.string(),
      }),
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
      z.object({
        name: z.string(),
        value: z.string(),
      }),
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
      z.object({
        name: z.string(),
        value: z.string().min(3),
      }),
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
      z.object({ message: z.string() }),
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
      z.object({ message: completable(z.string(), () => ["hello", "world"]) }),
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
      z.object({
        name: completable(z.string(), () => ["Alice", "Bob", "Charlie"]),
      }),
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
      z.object({
        name: completable(z.string(), (test) =>
          ["Alice", "Bob", "Charlie"].filter((value) => value.startsWith(test)),
        ),
      }),
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
});
