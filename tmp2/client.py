#!/usr/bin/env uv run
# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "mcp",
# ]
# ///
import datetime
from mcp import ClientSession, StdioServerParameters, types
from mcp.client.stdio import stdio_client

# Create server parameters for stdio connection
server_params = StdioServerParameters(
    command="uvx",  # Executable
    args=[
        "--quiet",
        "--refresh",
        "git+https://github.com/emsi/slow-mcp",
        "--transport",
        "stdio",
    ],
    env=None,  # Optional environment variables
)


# Optional: create a sampling callback
async def handle_sampling_message(
    message: types.CreateMessageRequestParams,
) -> types.CreateMessageResult:
    return types.CreateMessageResult(
        role="assistant",
        content=types.TextContent(
            type="text",
            text="Hello, world! from model",
        ),
        model="gpt-3.5-turbo",
        stopReason="endTurn",
    )


async def run():
    async with stdio_client(server_params) as (read, write):
        async with ClientSession(
            read, write, #sampling_callback=handle_sampling_message
            read_timeout_seconds=datetime.timedelta(seconds=60),
        ) as session:
            # Initialize the connection
            await session.initialize()

            resources = await session.list_resources()

            # List available tools
            tools = await session.list_tools()

            print(f"Tools: {tools}")

            # Call a tool
            result = await session.call_tool("run_command")

            print(f"Result: {result}")


if __name__ == "__main__":
    import asyncio

    asyncio.run(run())
