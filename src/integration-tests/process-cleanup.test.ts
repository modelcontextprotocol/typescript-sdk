import { execSync } from "node:child_process";
import { Server } from "../server/index.js";
import { StdioServerTransport } from "../server/stdio.js";
import { Client } from "../client/index.js";
import { StdioClientTransport } from "../client/stdio.js";

describe("Process cleanup", () => {
  jest.setTimeout(10 * 1000); // 10 second timeout

  it("server should exit cleanly after closing transport", async () => {
    const server = new Server(
      {
        name: "test-server",
        version: "1.0.0",
      },
      {
        capabilities: {},
      }
    );

    const transport = new StdioServerTransport();
    await server.connect(transport);

    // Close the transport
    await transport.close();

    // If we reach here without hanging, the test passes
    // The test runner will fail if the process hangs
    expect(true).toBe(true);
  });

  it("client should exit cleanly after closing transport", async () => {  
    const isProcessRunning = (pid: number) => {
      try {
        execSync(`ps -p ${pid}`, { stdio: 'ignore' });
        return true;

      /* eslint-disable @typescript-eslint/no-unused-vars */
      } catch (error) {
        return false;
      }
    }
    
    const client = new Client({
      name: "test-client",
      version: "1.0.0",
    });

    const transport = new StdioClientTransport({
      command: "node",
      args: ["server-that-hangs.js"],
      cwd: __dirname
    });

    await client.connect(transport);
    const pid = transport.pid;

    await client.close();
    await new Promise(resolve => setTimeout(resolve, 5000));

    expect(isProcessRunning(pid!)).toBe(false);
  });
});
