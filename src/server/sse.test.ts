import { SSEServerTransport } from "./sse.js";

test("should initialize with provided sessionId", async () => {
  const res: any = null;
  const server = new SSEServerTransport("/sse", res, "test-sessionId-123");
  expect(server.sessionId).toBe("test-sessionId-123");
});