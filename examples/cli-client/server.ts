/**
 * Runner shim: the cli-client story's server is the sibling examples/todos-server package.
 * The example runner spawns `<story>/server.ts` for http legs, so this file just executes
 * the real entry (argv passes through untouched).
 */
import '../todos-server/server';
