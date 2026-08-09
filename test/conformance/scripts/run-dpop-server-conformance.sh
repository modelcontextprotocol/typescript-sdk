#!/bin/bash
# Runs the auth/dpop-server-validation conformance scenario (SEP-1932 / RFC 9449) against
# dpopTestServer.ts: generates an ES256 issuer keypair, hands the public half to the fixture
# server and the private half to the referee (which mints the DPoP-bound access tokens it
# probes with), starts the fixture, runs the scenario, then stops the server.
#
# NOTE: `auth/dpop-server-validation` is not yet in the @modelcontextprotocol/conformance release
# pinned in package.json (conformance#395 is still open) — this script is for local verification
# against a linked checkout of that PR's branch until it ships; see test/conformance/README.md's
# "Running Tests Against Local Conformance Repo" section. It is not yet wired into CI for that
# reason.
#
# Set DPOP_REQUIRE_NONCE=1 before invoking this script to additionally exercise the optional
# server-provided nonce flow (RFC 9449 §9); the fixture reads it directly.

set -e

PORT="${PORT:-3010}"
SERVER_URL="http://127.0.0.1:${PORT}/mcp"
ISSUER="${DPOP_ISSUER:-https://conformance-dpop-issuer.example.com}"

# Navigate to the repo root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

if (: > "/dev/tcp/localhost/${PORT}") 2>/dev/null; then
    echo "Error: port ${PORT} is already in use."
    echo "Stop the stale process first (lsof -ti:${PORT} -sTCP:LISTEN | xargs kill) or set PORT to a free port."
    exit 1
fi

# One ES256 keypair, shared as two halves: the fixture server (this script) validates access
# tokens against the public JWK; the referee (invoked below) signs them with the private JWK.
# Written to a temp file rather than threaded through the shell directly, so neither JWK is ever
# shell-escaped or exposed in a process listing.
KEYS_FILE="$(mktemp)"
node -e '
(async () => {
    const { publicKey, privateKey } = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const pub = await crypto.subtle.exportKey("jwk", publicKey);
    const priv = await crypto.subtle.exportKey("jwk", privateKey);
    pub.alg = "ES256";
    priv.alg = "ES256";
    require("fs").writeFileSync(process.argv[1], JSON.stringify({ pub, priv }));
})();
' "$KEYS_FILE"
DPOP_ISSUER_JWK="$(node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).pub))' "$KEYS_FILE")"
DPOP_ISSUER_PRIVATE_JWK="$(node -e 'console.log(JSON.stringify(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).priv))' "$KEYS_FILE")"

# Start the fixture in the background. `node --import tsx` (not `npx tsx`) so SERVER_PID is the
# server process itself — killing an npx/tsx wrapper leaves the actual server squatting the port.
echo "Starting DPoP test server on port ${PORT}..."
PORT="${PORT}" DPOP_ISSUER_JWK="${DPOP_ISSUER_JWK}" DPOP_ISSUER="${ISSUER}" DPOP_AUDIENCE="${SERVER_URL}" \
    node --import tsx ./src/dpopTestServer.ts &
SERVER_PID=$!

cleanup() {
    echo "Stopping server (PID: ${SERVER_PID})..."
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
    rm -f "$KEYS_FILE"
}
trap cleanup EXIT

echo "Waiting for server to be ready..."
MAX_RETRIES=30
RETRY_COUNT=0
while ! curl -s --max-time 2 "${SERVER_URL}" > /dev/null 2>&1; do
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
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

echo "Server is ready. Running the auth/dpop-server-validation scenario..."

DPOP_ISSUER_PRIVATE_JWK="${DPOP_ISSUER_PRIVATE_JWK}" DPOP_ISSUER="${ISSUER}" \
    npx @modelcontextprotocol/conformance server --url "${SERVER_URL}" --scenario auth/dpop-server-validation "$@"

echo "Conformance tests completed."
