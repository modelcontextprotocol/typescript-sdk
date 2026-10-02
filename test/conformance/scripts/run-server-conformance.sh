#!/bin/bash
# Script to run server conformance tests
# Starts the conformance server, runs conformance tests, then stops the server

set -e

PORT="${PORT:-3000}"
SERVER_URL="http://localhost:${PORT}/mcp"

# Navigate to the repo root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

# Refuse to start if something is already listening on the port. The readiness
# check below cannot tell our server apart from a stale one, so a leftover
# listener would mean silently running conformance against old code — or
# hanging forever if the listener never responds.
if (: > "/dev/tcp/localhost/${PORT}") 2>/dev/null; then
    echo "Error: port ${PORT} is already in use."
    echo "Stop the stale process first (lsof -ti:${PORT} -sTCP:LISTEN | xargs kill) or set PORT to a free port."
    exit 1
fi

# Start the server in the background. Use `node --import tsx` rather than
# `npx tsx` so SERVER_PID is the server process itself — killing an npx/tsx
# wrapper leaves the actual server running and squatting the port.
echo "Starting conformance test server on port ${PORT}..."
node --import tsx ./src/everythingServer.ts &
SERVER_PID=$!

# Function to cleanup on exit
cleanup() {
    echo "Stopping server (PID: ${SERVER_PID})..."
    kill $SERVER_PID 2>/dev/null || true
    wait $SERVER_PID 2>/dev/null || true
}
trap cleanup EXIT

# Wait for server to be ready. --max-time keeps a hung listener from wedging
# the loop forever, and a dead server process fails fast instead of retrying.
echo "Waiting for server to be ready..."
MAX_RETRIES=30
RETRY_COUNT=0
while ! curl -s --max-time 2 "${SERVER_URL}" > /dev/null 2>&1; do
    if ! kill -0 $SERVER_PID 2>/dev/null; then
        echo "Server process exited unexpectedly"
        exit 1
    fi
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
