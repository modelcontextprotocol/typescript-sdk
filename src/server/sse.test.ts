import { SSEServerTransport } from "./sse.js";

test("should initialize with provided sessionId", async () => {
  /* eslint-disable  @typescript-eslint/no-explicit-any */
  const res: any = null; // mocking HTTP res as it's irrelevant to the test
  const server = new SSEServerTransport("/sse", res, "test-sessionId-123");
  expect(server.sessionId).toBe("test-sessionId-123");
});