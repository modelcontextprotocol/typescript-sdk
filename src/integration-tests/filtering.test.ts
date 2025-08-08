import { McpServer } from "../server/mcp.js";
import { Client } from "../client/index.js";
import { z } from "zod";
import { StreamableHTTPClientTransport } from "../client/streamableHttp.js";
import { StreamableHTTPServerTransport } from "../server/streamableHttp.js";
import { createServer, Server as HttpServer } from "http";
import { AddressInfo } from "net";
import { randomUUID } from "crypto";

describe("Filtering integration tests", () => {
  let httpServer: HttpServer;
  let serverTransport: StreamableHTTPServerTransport;
  let clientTransport: StreamableHTTPClientTransport;
  let server: McpServer;
  let client: Client;
  let port: number;

  beforeAll(async () => {
    // Create HTTP server
    httpServer = createServer();
    httpServer.listen(0);
    port = (httpServer.address() as AddressInfo).port;

    // Create server
    server = new McpServer({ name: "test-server", version: "1.0.0" });

    // Set up groups
    server.registerGroup("user", {
      title: "User Management",
      description: "Tools for managing users"
    });

    server.registerGroup("content", {
      title: "Content Management",
      description: "Tools for managing content"
    });

    // Set up tags
    server.registerTag("stable", {
      description: "Stable tools"
    });

    server.registerTag("beta", {
      description: "Beta tools"
    });

    server.registerTag("destructive", {
      description: "Destructive operations"
    });

    // Register tools with different groups and tags
    server.registerTool("user_create", {
      title: "Create User",
      description: "Creates a new user",
      inputSchema: {
        username: z.string(),
        email: z.string().email()
      },
      groups: ["user"],
      tags: ["stable"]
    }, () => ({ content: [{ type: 'text', text: 'User created' }] }));

    server.registerTool("user_delete", {
      title: "Delete User",
      description: "Deletes a user",
      inputSchema: {
        userId: z.string()
      },
      groups: ["user"],
      tags: ["stable", "destructive"]
    }, () => ({ content: [{ type: 'text', text: 'User deleted' }] }));

    server.registerTool("content_create", {
      title: "Create Content",
      description: "Creates new content",
      inputSchema: {
        title: z.string(),
        body: z.string()
      },
      groups: ["content"],
      tags: ["stable"]
    }, () => ({ content: [{ type: 'text', text: 'Content created' }] }));

    server.registerTool("content_publish", {
      title: "Publish Content",
      description: "Publishes content",
      inputSchema: {
        contentId: z.string()
      },
      groups: ["content"],
      tags: ["beta"]
    }, () => ({ content: [{ type: 'text', text: 'Content published' }] }));

    // Create server transport
    serverTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID()
    });

    // Set up request handler
    httpServer.on('request', async (req, res) => {
      await serverTransport.handleRequest(req, res);
    });

    // Connect server to transport
    server.connect(serverTransport);

    // Create client
    client = new Client({ name: "test-client", version: "1.0.0" });

    // Create client transport
    const baseUrl = new URL(`http://localhost:${port}/mcp`);
    clientTransport = new StreamableHTTPClientTransport(baseUrl);

    // Connect client to transport
    await client.connect(clientTransport);
  });

  beforeEach(() => {
    // No setup needed for each test
  });

  afterEach(() => {
    // No cleanup needed for each test
  });

  afterAll(async () => {
    // Close server
    httpServer.close();
  });

  test("should list all groups", async () => {
    // Request groups from the server
    const result = await client.listGroups();

    // Verify groups are returned correctly
    expect(result.groups).toHaveLength(2);
    expect(result.groups.map(g => g.name)).toContain("user");
    expect(result.groups.map(g => g.name)).toContain("content");
  });

  test("should list all tags", async () => {
    // Request tags from the server
    const result = await client.listTags();

    // Verify tags are returned correctly
    expect(result.tags).toHaveLength(3);
    expect(result.tags.map(t => t.name)).toContain("stable");
    expect(result.tags.map(t => t.name)).toContain("beta");
    expect(result.tags.map(t => t.name)).toContain("destructive");
  });

  test("should filter tools by group", async () => {
    // Request tools filtered by user group
    const userTools = await client.listTools({
      filter: {
        groups: ["user"]
      }
    });

    // Verify only user tools are returned
    expect(userTools.tools).toHaveLength(2);
    expect(userTools.tools.map(t => t.name)).toContain("user_create");
    expect(userTools.tools.map(t => t.name)).toContain("user_delete");

    // Request tools filtered by content group
    const contentTools = await client.listTools({
      filter: {
        groups: ["content"]
      }
    });

    // Verify only content tools are returned
    expect(contentTools.tools).toHaveLength(2);
    expect(contentTools.tools.map(t => t.name)).toContain("content_create");
    expect(contentTools.tools.map(t => t.name)).toContain("content_publish");
  });

  test("should filter tools by tag", async () => {
    // Request tools filtered by stable tag
    const stableTools = await client.listTools({
      filter: {
        tags: ["stable"]
      }
    });

    // Verify only stable tools are returned
    expect(stableTools.tools).toHaveLength(3);
    expect(stableTools.tools.map(t => t.name)).toContain("user_create");
    expect(stableTools.tools.map(t => t.name)).toContain("user_delete");
    expect(stableTools.tools.map(t => t.name)).toContain("content_create");

    // Request tools filtered by beta tag
    const betaTools = await client.listTools({
      filter: {
        tags: ["beta"]
      }
    });

    // Verify only beta tools are returned
    expect(betaTools.tools).toHaveLength(1);
    expect(betaTools.tools[0].name).toBe("content_publish");
  });

  test("should filter tools by both group and tag", async () => {
    // Request user tools that are destructive
    const destructiveUserTools = await client.listTools({
      filter: {
        groups: ["user"],
        tags: ["destructive"]
      }
    });

    // Verify only destructive user tools are returned
    expect(destructiveUserTools.tools).toHaveLength(1);
    expect(destructiveUserTools.tools[0].name).toBe("user_delete");

    // Request content tools that are stable
    const stableContentTools = await client.listTools({
      filter: {
        groups: ["content"],
        tags: ["stable"]
      }
    });

    // Verify only stable content tools are returned
    expect(stableContentTools.tools).toHaveLength(1);
    expect(stableContentTools.tools[0].name).toBe("content_create");
  });

  test("should return tools that match any of the specified groups", async () => {
    // Request tools from both user and content groups
    const allTools = await client.listTools({
      filter: {
        groups: ["user", "content"]
      }
    });

    // Verify all tools are returned
    expect(allTools.tools).toHaveLength(4);
  });

  test("should return tools that match all of the specified tags", async () => {
    // Request tools that are both stable and destructive
    const stableDestructiveTools = await client.listTools({
      filter: {
        tags: ["stable", "destructive"]
      }
    });

    // Verify only tools with both tags are returned
    expect(stableDestructiveTools.tools).toHaveLength(1);
    expect(stableDestructiveTools.tools[0].name).toBe("user_delete");
  });
});
