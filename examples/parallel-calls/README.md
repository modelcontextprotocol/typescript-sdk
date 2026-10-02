# parallel-calls

Multiple clients connecting to one endpoint in parallel, and one client making parallel `callTool()` calls — with per-call logging notifications attributed back to their caller.

Over HTTP every client connects to the one running endpoint; over stdio each client spawns its own server process (so the "one client / parallel calls" leg is the per-call attribution test on either transport).
