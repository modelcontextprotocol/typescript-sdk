#!/bin/bash
# Script to run server conformance tests
# Starts the conformance server, runs conformance tests, then stops the server

set -e

PORT="${PORT:-3000}"
SERVER_URL="http://localhost:${PORT}/mcp"

# Navigate to the repo root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

# Start the server in the background
echo "Starting conformance test server on port ${PORT}..."
npx tsx ./src/everythingServer.ts &
SERVER_PID=$!

# Function to cleanup on exit
cleanup() {
    echo "Stopping server (PID: ${SERVER_PID})..."
    kill $SERVER_PID 2>/dev/null || true
    wait $SERVER_PID 2>/dev/null || true
}
trap cleanup EXIT

# Wait for server to be ready
echo "Waiting for server to be ready..."
MAX_RETRIES=30
RETRY_COUNT=0
while ! curl -s "${SERVER_URL}" > /dev/null 2>&1; do
    RETRY_COUNT=$((RETRY_COUNT + 1))
    if [ $RETRY_COUNT -ge $MAX_RETRIES ]; then
        echo "Server failed to start after ${MAX_RETRIES} attempts"
        exit 1
    fi
    sleep 0.5
done

echo "Server is ready. Running conformance tests..."

# Run conformance tests - pass through all arguments
npx @modelcontextprotocol/conformance server --url "${SERVER_URL}" "$@"

echo "Conformance tests completed."
