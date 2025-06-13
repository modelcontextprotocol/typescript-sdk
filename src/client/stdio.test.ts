import { JSONRPCMessage } from "../types.js";
import { StdioClientTransport, StdioServerParameters } from "./stdio.js";
import { ChildProcess } from "node:child_process";

const serverParameters: StdioServerParameters = {
  command: "/usr/bin/tee",
};

test("should start then close cleanly", async () => {
  const client = new StdioClientTransport(serverParameters);
  client.onerror = (error) => {
    throw error;
  };

  let didClose = false;
  client.onclose = () => {
    didClose = true;
  };

  await client.start();
  expect(didClose).toBeFalsy();
  await client.close();
  expect(didClose).toBeTruthy();
});

test("should gracefully terminate the process", async () => {
  const killSpy = jest.spyOn(ChildProcess.prototype, "kill");

  jest.spyOn(global, "setTimeout").mockImplementationOnce((callback) => {
    if (typeof callback === "function") {
      callback();
    }
    return 1 as unknown as NodeJS.Timeout;
  });

  const client = new StdioClientTransport(serverParameters);

  const mockProcess = {
    kill: jest.fn(),
    exitCode: null,
    once: jest.fn().mockImplementation((event, handler) => {
      if (
        mockProcess.kill.mock.calls.length === 2 &&
        (event === "exit" || event === "close")
      ) {
        setTimeout(() => handler(), 0);
      }
      return mockProcess;
    }),
  };

  // @ts-expect-error accessing private property for testing
  client._process = mockProcess;

  await client.close();

  expect(mockProcess.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
  expect(mockProcess.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
  expect(mockProcess.kill).toHaveBeenCalledTimes(2);

  killSpy.mockRestore();
});

test("should exit cleanly if SIGTERM works", async () => {
  const client = new StdioClientTransport(serverParameters);

  const callbacks: Record<string, Function> = {};

  const mockProcess = {
    kill: jest.fn(),
    exitCode: null,
    once: jest.fn((event, callback) => {
      callbacks[event] = callback;
      return mockProcess;
    }),
  } as unknown as ChildProcess;

  // @ts-expect-error accessing private property for testing
  client._process = mockProcess;

  // @ts-expect-error accessing private property for testing
  client._abortController = { abort: jest.fn() };

  const closePromise = client.close();

  expect(mockProcess.kill).toHaveBeenCalledWith("SIGTERM");
  expect(mockProcess.once).toHaveBeenCalledWith("exit", expect.any(Function));

  callbacks.exit && callbacks.exit();

  await closePromise;

  expect(mockProcess.kill).toHaveBeenCalledWith("SIGTERM");
  expect(mockProcess.kill).toHaveBeenCalledTimes(1);
});

test("should read messages", async () => {
  const client = new StdioClientTransport(serverParameters);
  client.onerror = (error) => {
    throw error;
  };

  const messages: JSONRPCMessage[] = [
    {
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
    },
    {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    },
  ];

  const readMessages: JSONRPCMessage[] = [];
  const finished = new Promise<void>((resolve) => {
    client.onmessage = (message) => {
      readMessages.push(message);

      if (JSON.stringify(message) === JSON.stringify(messages[1])) {
        resolve();
      }
    };
  });

  await client.start();
  await client.send(messages[0]);
  await client.send(messages[1]);
  await finished;
  expect(readMessages).toEqual(messages);

  await client.close();
});
