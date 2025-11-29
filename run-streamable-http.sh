#!/usr/bin/env bash
# Runs the simpleStreamableHttp server with OAuth enabled
#
# Environment variables for testing delays:
#   MCP_DELAY_LIST_TOOLS_MS - Delay tools/list requests
#   MCP_DELAY_CALL_TOOL_MS  - Delay tools/call requests
#   MCP_DELAY_DCR_MS        - Delay Dynamic Client Registration
#
# Usage:
#   ./run-streamable-http.sh
#   MCP_DELAY_LIST_TOOLS_MS=2000 ./run-streamable-http.sh

cd "$(dirname "$0")"

npx tsx src/examples/server/simpleStreamableHttp.ts --oauth "$@"
