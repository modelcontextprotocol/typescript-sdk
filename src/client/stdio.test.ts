import { JSONRPCMessage } from "../types.js";
import { StdioClientTransport, StdioServerParameters, DEFAULT_INHERITED_ENV_VARS, getDefaultEnvironment } from "./stdio.js";

const serverParameters: StdioServerParameters = {
  command: "/usr/bin/tee",
};


let spawnEnv: Record<string, string> | undefined;

jest.mock('cross-spawn', () => {
  const originalSpawn = jest.requireActual('cross-spawn');
  return jest.fn((command, args, options) => {
    spawnEnv = options.env;
    return originalSpawn(command, args, options);
  });
});

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

test("should properly set default environment variables in spawned process", async () => {
  const client = new StdioClientTransport(serverParameters);

  await client.start();
  await client.close();

  // Get the default environment variables
  const defaultEnv = getDefaultEnvironment();

  // Verify that all default environment variables are present
  for (const key of DEFAULT_INHERITED_ENV_VARS) {
    if (process.env[key] && !process.env[key].startsWith("()")) {
      expect(spawnEnv).toHaveProperty(key);
      expect(spawnEnv![key]).toBe(process.env[key]);
      expect(spawnEnv![key]).toBe(defaultEnv[key]);
    }
  }
});

test("should override default environment variables with custom ones", async () => {
  const customEnv = {
    HOME: "/custom/home",
    PATH: "/custom/path",
    USER: "custom_user"
  };

  const client = new StdioClientTransport({
    ...serverParameters,
    env: customEnv
  });

  await client.start();
  await client.close();

  // Verify that custom environment variables override default ones
  for (const [key, value] of Object.entries(customEnv)) {
    expect(spawnEnv).toHaveProperty(key);
    expect(spawnEnv![key]).toBe(value);
  }

  // Verify that other default environment variables are still present
  for (const key of DEFAULT_INHERITED_ENV_VARS) {
    if (!(key in customEnv) && process.env[key] && !process.env[key].startsWith("()")) {
      expect(spawnEnv).toHaveProperty(key);
      expect(spawnEnv![key]).toBe(process.env[key]);
    }
  }
}); 
