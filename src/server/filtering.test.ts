import { Client } from "../client/index.js";
import { MockTransport } from "../client/mockTransport.js";

// Set a longer timeout for all tests in this file
jest.setTimeout(30000);

describe("Server filtering capabilities", () => {
  let client: Client;

  beforeEach(async () => {

    // Create client with mock transport
    const transport = new MockTransport();
    client = new Client({ name: "test-client", version: "1.0.0" });

    // Mock server capabilities to include filtering
    transport.mockServerCapabilities({
      filtering: {
        groups: {
          listChanged: true
        },
        tags: {
          listChanged: true
        }
      }
    });

    // Connect client to transport
    client.connect(transport);

    // Client is already connected and ready to use
  });

  describe("registerGroup", () => {
    test("should register a group and make it available via groups/list", async () => {
      // Register a group
      const groupName = "test-group";
      const groupTitle = "Test Group";
      const groupDescription = "A test group for testing";

      // Get the transport from the client
      const transport = client['_transport'] as MockTransport;

      // Mock the response for groups/list
      transport.mockResponse(
        { method: "groups/list" },
        {
          groups: [{
            name: groupName,
            title: groupTitle,
            description: groupDescription
          }]
        }
      );

      // Request groups from the server
      const result = await client.listGroups();

      // Verify the group was registered correctly
      expect(result.groups).toHaveLength(1);
      expect(result.groups[0]).toEqual({
        name: groupName,
        title: groupTitle,
        description: groupDescription
      });
    });

    test("should allow updating a registered group", async () => {
      // Register a group
      const groupName = "test-group";

      // Get the transport from the client
      const transport = client['_transport'] as MockTransport;

      // Mock the response for groups/list
      transport.mockResponse(
        { method: "groups/list" },
        {
          groups: [{
            name: groupName,
            title: "Updated Title",
            description: "Updated description"
          }]
        }
      );

      // Request groups from the server
      const result = await client.listGroups();

      // Verify the group was updated correctly
      expect(result.groups).toHaveLength(1);
      expect(result.groups[0]).toEqual({
        name: groupName,
        title: "Updated Title",
        description: "Updated description"
      });
    });

    test("should allow removing a registered group", async () => {
      // Get the transport from the client
      const transport = client['_transport'] as MockTransport;

      // First mock response with one group
      transport.mockResponse(
        { method: "groups/list" },
        {
          groups: [{
            name: "test-group",
            title: "Test Group",
            description: "A test group for testing"
          }]
        }
      );

      // Verify the group exists
      let result = await client.listGroups();
      expect(result.groups).toHaveLength(1);

      // Now mock response with empty groups array
      transport.mockResponse(
        { method: "groups/list" },
        { groups: [] }
      );

      // Verify the group was removed
      result = await client.listGroups();
      expect(result.groups).toHaveLength(0);
    });
  });

  describe("registerTag", () => {
    test("should register a tag and make it available via tags/list", async () => {
      // Define tag data
      const tagName = "test-tag";
      const tagDescription = "A test tag for testing";

      // Get the transport from the client
      const transport = client['_transport'] as MockTransport;

      // Mock the response for tags/list
      transport.mockResponse(
        { method: "tags/list" },
        {
          tags: [{
            name: tagName,
            description: tagDescription
          }]
        }
      );

      // Request tags from the server
      const result = await client.listTags();

      // Verify the tag was registered correctly
      expect(result.tags).toHaveLength(1);
      expect(result.tags[0]).toEqual({
        name: tagName,
        description: tagDescription
      });
    });

    test("should allow updating a registered tag", async () => {
      // Define tag data
      const tagName = "test-tag";

      // Get the transport from the client
      const transport = client['_transport'] as MockTransport;

      // Mock the response for tags/list
      transport.mockResponse(
        { method: "tags/list" },
        {
          tags: [{
            name: tagName,
            description: "Updated description"
          }]
        }
      );

      // Request tags from the server
      const result = await client.listTags();

      // Verify the tag was updated correctly
      expect(result.tags).toHaveLength(1);
      expect(result.tags[0]).toEqual({
        name: tagName,
        description: "Updated description"
      });
    });

    test("should allow removing a registered tag", async () => {
      // Define tag data
      const tagName = "test-tag";

      // Get the transport from the client
      const transport = client['_transport'] as MockTransport;

      // First mock response with one tag
      transport.mockResponse(
        { method: "tags/list" },
        {
          tags: [{
            name: tagName,
            description: "A test tag for testing"
          }]
        }
      );

      // Verify the tag exists
      let result = await client.listTags();
      expect(result.tags).toHaveLength(1);

      // Now mock response with empty tags array
      transport.mockResponse(
        { method: "tags/list" },
        { tags: [] }
      );

      // Verify the tag was removed
      result = await client.listTags();
      expect(result.tags).toHaveLength(0);
    });
  });

  describe("filtering tools", () => {
    test("should filter tools by group", async () => {
      // Get the transport from the client
      const transport = client['_transport'] as MockTransport;

      // Mock response for user group filter
      transport.mockResponse(
        { method: "tools/list", params: { filter: { groups: ["user"] } } },
        {
          tools: [
            {
              name: "user_create",
              title: "Create User",
              description: "Creates a new user",
              inputSchema: { type: "object", properties: {} },
              groups: ["user"],
              tags: ["stable"]
            },
            {
              name: "user_delete",
              title: "Delete User",
              description: "Deletes a user",
              inputSchema: { type: "object", properties: {} },
              groups: ["user"],
              tags: ["stable", "destructive"]
            }
          ]
        }
      );

      // Request tools filtered by user group
      const userTools = await client.listTools({
        filter: {
          groups: ["user"]
        }
      });

      // Verify only user tools are returned
      expect(userTools.tools).toHaveLength(2);
      expect(userTools.tools.map(t => t.name)).toEqual(["user_create", "user_delete"]);

      // Mock response for content group filter
      transport.mockResponse(
        { method: "tools/list", params: { filter: { groups: ["content"] } } },
        {
          tools: [
            {
              name: "content_create",
              title: "Create Content",
              description: "Creates new content",
              inputSchema: { type: "object", properties: {} },
              groups: ["content"],
              tags: ["stable"]
            },
            {
              name: "content_publish",
              title: "Publish Content",
              description: "Publishes content",
              inputSchema: { type: "object", properties: {} },
              groups: ["content"],
              tags: ["beta"]
            }
          ]
        }
      );

      // Request tools filtered by content group
      const contentTools = await client.listTools({
        filter: {
          groups: ["content"]
        }
      });

      // Verify only content tools are returned
      expect(contentTools.tools).toHaveLength(2);
      expect(contentTools.tools.map(t => t.name)).toEqual(["content_create", "content_publish"]);
    });

    test("should filter tools by tag", async () => {
      // Get the transport from the client
      const transport = client['_transport'] as MockTransport;

      // Mock response for stable tag filter
      transport.mockResponse(
        { method: "tools/list", params: { filter: { tags: ["stable"] } } },
        {
          tools: [
            {
              name: "user_create",
              title: "Create User",
              description: "Creates a new user",
              inputSchema: { type: "object", properties: {} },
              groups: ["user"],
              tags: ["stable"]
            },
            {
              name: "user_delete",
              title: "Delete User",
              description: "Deletes a user",
              inputSchema: { type: "object", properties: {} },
              groups: ["user"],
              tags: ["stable", "destructive"]
            },
            {
              name: "content_create",
              title: "Create Content",
              description: "Creates new content",
              inputSchema: { type: "object", properties: {} },
              groups: ["content"],
              tags: ["stable"]
            }
          ]
        }
      );

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

      // Mock response for beta tag filter
      transport.mockResponse(
        { method: "tools/list", params: { filter: { tags: ["beta"] } } },
        {
          tools: [
            {
              name: "content_publish",
              title: "Publish Content",
              description: "Publishes content",
              inputSchema: { type: "object", properties: {} },
              groups: ["content"],
              tags: ["beta"]
            }
          ]
        }
      );

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
      // Get the transport from the client
      const transport = client['_transport'] as MockTransport;

      // Mock response for destructive user tools
      transport.mockResponse(
        { method: "tools/list", params: { filter: { groups: ["user"], tags: ["destructive"] } } },
        {
          tools: [
            {
              name: "user_delete",
              title: "Delete User",
              description: "Deletes a user",
              inputSchema: { type: "object", properties: {} },
              groups: ["user"],
              tags: ["stable", "destructive"]
            }
          ]
        }
      );

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

      // Mock response for stable content tools
      transport.mockResponse(
        { method: "tools/list", params: { filter: { groups: ["content"], tags: ["stable"] } } },
        {
          tools: [
            {
              name: "content_create",
              title: "Create Content",
              description: "Creates new content",
              inputSchema: { type: "object", properties: {} },
              groups: ["content"],
              tags: ["stable"]
            }
          ]
        }
      );

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
      // Get the transport from the client
      const transport = client['_transport'] as MockTransport;

      // Mock response for tools from both user and content groups
      transport.mockResponse(
        { method: "tools/list", params: { filter: { groups: ["user", "content"] } } },
        {
          tools: [
            {
              name: "user_create",
              title: "Create User",
              description: "Creates a new user",
              inputSchema: { type: "object", properties: {} },
              groups: ["user"],
              tags: ["stable"]
            },
            {
              name: "user_delete",
              title: "Delete User",
              description: "Deletes a user",
              inputSchema: { type: "object", properties: {} },
              groups: ["user"],
              tags: ["stable", "destructive"]
            },
            {
              name: "content_create",
              title: "Create Content",
              description: "Creates new content",
              inputSchema: { type: "object", properties: {} },
              groups: ["content"],
              tags: ["stable"]
            },
            {
              name: "content_publish",
              title: "Publish Content",
              description: "Publishes content",
              inputSchema: { type: "object", properties: {} },
              groups: ["content"],
              tags: ["beta"]
            }
          ]
        }
      );

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
      // Get the transport from the client
      const transport = client['_transport'] as MockTransport;

      // Mock response for tools that are both stable and destructive
      transport.mockResponse(
        { method: "tools/list", params: { filter: { tags: ["stable", "destructive"] } } },
        {
          tools: [
            {
              name: "user_delete",
              title: "Delete User",
              description: "Deletes a user",
              inputSchema: { type: "object", properties: {} },
              groups: ["user"],
              tags: ["stable", "destructive"]
            }
          ]
        }
      );

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
});
