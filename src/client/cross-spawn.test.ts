import { StdioClientTransport } from "./stdio.js";
import spawn from "cross-spawn";
import { JSONRPCMessage } from "../types.js";
import { ChildProcess } from "node:child_process";

// mock cross-spawn
jest.mock("cross-spawn");
const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;

describe("StdioClientTransport using cross-spawn", () => {
  beforeEach(() => {
    // mock cross-spawn's return value
    mockSpawn.mockImplementation(() => {
      const mockProcess: {
        on: jest.Mock;
        stdin?: { on: jest.Mock; write: jest.Mock };
        stdout?: { on: jest.Mock };
        stderr?: null;
      } = {
        on: jest.fn((event: string, callback: () => void) => {
          if (event === "spawn") {
            callback();
          }
          return mockProcess;
        }),
        stdin: {
          on: jest.fn(),
          write: jest.fn().mockReturnValue(true)
        },
        stdout: {
          on: jest.fn()
        },
        stderr: null
      };
      return mockProcess as unknown as ChildProcess;
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test("should call cross-spawn correctly", async () => {
    const transport = new StdioClientTransport({
      command: "test-command",
      args: ["arg1", "arg2"]
    });

    await transport.start();

    // verify spawn is called correctly
    expect(mockSpawn).toHaveBeenCalledWith(
      "test-command",
      ["arg1", "arg2"],
      expect.objectContaining({
        shell: false
      })
    );
  });

  test("should pass environment variables correctly", async () => {
    const customEnv = { TEST_VAR: "test-value" };
    const transport = new StdioClientTransport({
      command: "test-command",
      env: customEnv
    });

    await transport.start();

    // verify environment variables are passed correctly
    expect(mockSpawn).toHaveBeenCalledWith(
      "test-command",
      [],
      expect.objectContaining({
        env: expect.objectContaining(customEnv)
      })
    );
  });

  test("should merge default and custom environment variables", async () => {
    const customEnv = { CUSTOM_VAR: "custom-value" };
    const transport = new StdioClientTransport({
      command: "test-command",
      env: customEnv
    });

    await transport.start();

    // verify environment variables are merged correctly
    expect(mockSpawn).toHaveBeenCalledWith(
      "test-command",
      [],
      expect.objectContaining({
        env: expect.objectContaining(customEnv)
      })
    );
  });

  test("should send messages correctly", async () => {
    const transport = new StdioClientTransport({
      command: "test-command"
    });

    // get the mock process object
    const mockProcess: {
      on: jest.Mock;
      stdin: {
        on: jest.Mock;
        write: jest.Mock;
        once: jest.Mock;
      };
      stdout: {
        on: jest.Mock;
      };
      stderr: null;
    } = {
      on: jest.fn((event: string, callback: () => void) => {
        if (event === "spawn") {
          callback();
        }
        return mockProcess;
      }),
      stdin: {
        on: jest.fn(),
        write: jest.fn().mockReturnValue(true),
        once: jest.fn()
      },
      stdout: {
        on: jest.fn()
      },
      stderr: null
    };

    mockSpawn.mockReturnValue(mockProcess as unknown as ChildProcess);

    await transport.start();

    // 关键修复：确保 jsonrpc 是字面量 "2.0"
    const message: JSONRPCMessage = {
      jsonrpc: "2.0",
      id: "test-id",
      method: "test-method"
    };

    await transport.send(message);

    // verify message is sent correctly
    expect(mockProcess.stdin.write).toHaveBeenCalled();
  });
});