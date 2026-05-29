// Fixture: reads stdin but never responds (for timeout tests).
process.stdin.resume();
setInterval(() => {}, 60_000);
