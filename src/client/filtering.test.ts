import { Client } from "./index.js";
import { MockTransport } from "./mockTransport.js";
import {
  Group,
  Tag,
  Tool,
  ToolsFilter,
} from "../types.js";

describe("Client filtering capabilities", () => {
  let client: Client;
  let transport: MockTransport;

  beforeEach(() => {
    transport = new MockTransport();
    client = new Client({ name: "test-client", version: "1.0.0" });
    client.connect(transport);

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

    // Client is already connected and ready to use
  });

  describe("listGroups", () => {
    test("should request groups from the server", async () => {
      // Mock server response
      const mockGroups: Group[] = [
        {
          name: "user",
          title: "User Management Tools",
          description: "Tools used for managing user accounts within the system."
        },
        {
          name: "mapping",
          title: "Geospatial Mapping Tools",
          description: "Tools used for map rendering, geocoding, and spatial analysis."
        }
      ];

      transport.mockResponse(
        { method: "groups/list" },
        { groups: mockGroups }
      );

      // Call the method
      const result = await client.listGroups();

      // Verify the request was made correctly
      expect(transport.lastRequest).toEqual({
        jsonrpc: "2.0",
        method: "groups/list",
        params: {},
        id: expect.anything()
      });

      // Verify the response was parsed correctly
      expect(result).toEqual({ groups: mockGroups });
    });

    test("should throw an error if filtering capability is not available", async () => {
      // Create a new client without filtering capability
      const newTransport = new MockTransport();
      const newClient = new Client({ name: "test-client", version: "1.0.0" });
      newClient.connect(newTransport);

      // Mock server capabilities without filtering
      newTransport.mockServerCapabilities({});

      // Expect the method to throw an error
      await expect(newClient.listGroups()).rejects.toThrow(
        "Server does not support method: groups/list"
      );
    }, 10000); // Increase timeout to 10 seconds
  });

  describe("listTags", () => {
    test("should request tags from the server", async () => {
      // Mock server response
      const mockTags: Tag[] = [
        {
          name: "beta",
          description: "Experimental or in-testing tools"
        },
        {
          name: "stable",
          description: "Production-ready tools."
        }
      ];

      transport.mockResponse(
        { method: "tags/list" },
        { tags: mockTags }
      );

      // Call the method
      const result = await client.listTags();

      // Verify the request was made correctly
      expect(transport.lastRequest).toEqual({
        jsonrpc: "2.0",
        method: "tags/list",
        params: {},
        id: expect.anything()
      });

      // Verify the response was parsed correctly
      expect(result).toEqual({ tags: mockTags });
    });

    test("should throw an error if filtering capability is not available", async () => {
      // Create a new client without filtering capability
      const newTransport = new MockTransport();
      const newClient = new Client({ name: "test-client", version: "1.0.0" });
      newClient.connect(newTransport);

      // Mock server capabilities without filtering
      newTransport.mockServerCapabilities({});

      // Expect the method to throw an error
      await expect(newClient.listTags()).rejects.toThrow(
        "Server does not support method: tags/list"
      );
    }, 10000); // Increase timeout to 10 seconds
  });

  describe("listTools with filtering", () => {
    test("should request tools with group filter", async () => {
      // Mock tools
      const mockTools: Tool[] = [
        {
          name: "user_create",
          title: "Create User",
          description: "Creates a new user account",
          inputSchema: { type: "object", properties: {} },
          groups: ["user"]
        }
      ];

      // Set up the mock response
      transport.mockResponse(
        { method: "tools/list" },
        { tools: mockTools }
      );

      // Create filter
      const filter: ToolsFilter = {
        groups: ["user"]
      };

      // Call the method with filter
      const result = await client.listTools({ filter });

      // Verify the request was made correctly
      expect(transport.lastRequest).toEqual({
        jsonrpc: "2.0",
        method: "tools/list",
        params: { filter },
        id: expect.anything()
      });

      // Verify the response was parsed correctly
      expect(result).toEqual({ tools: mockTools });
    });

    test("should request tools with tag filter", async () => {
      // Mock tools
      const mockTools: Tool[] = [
        {
          name: "map_render",
          title: "Render Map",
          description: "Renders a map with the given parameters",
          inputSchema: { type: "object", properties: {} },
          tags: ["stable"]
        }
      ];

      // Set up the mock response
      transport.mockResponse(
        { method: "tools/list" },
        { tools: mockTools }
      );

      // Create filter
      const filter: ToolsFilter = {
        tags: ["stable"]
      };

      // Call the method with filter
      const result = await client.listTools({ filter });

      // Verify the request was made correctly
      expect(transport.lastRequest).toEqual({
        jsonrpc: "2.0",
        method: "tools/list",
        params: { filter },
        id: expect.anything()
      });

      // Verify the response was parsed correctly
      expect(result).toEqual({ tools: mockTools });
    });

    test("should request tools with both group and tag filters", async () => {
      // Mock tools
      const mockTools: Tool[] = [
        {
          name: "user_delete",
          title: "Delete User",
          description: "Deletes a user account",
          inputSchema: { type: "object", properties: {} },
          groups: ["user"],
          tags: ["destructive"]
        }
      ];

      // Set up the mock response
      transport.mockResponse(
        { method: "tools/list" },
        { tools: mockTools }
      );

      // Create filter
      const filter: ToolsFilter = {
        groups: ["user"],
        tags: ["destructive"]
      };

      // Call the method with filter
      const result = await client.listTools({ filter });

      // Verify the request was made correctly
      expect(transport.lastRequest).toEqual({
        jsonrpc: "2.0",
        method: "tools/list",
        params: { filter },
        id: expect.anything()
      });

      // Verify the response was parsed correctly
      expect(result).toEqual({ tools: mockTools });
    });
  });
});
