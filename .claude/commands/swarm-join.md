First check if a swarm is already running by looking for `.claude-swarm.pid` in the project directory. If a PID file exists and the process is running, tell the user a swarm session is already active and suggest `/swarm-status` or `/swarm-stop` first.

If no swarm is running, join an existing one. If an address is provided use it, otherwise try auto-discovery.

Usage: /swarm-join [address] [--port PORT] [--label NAME]

```
claude-swarm join $ARGUMENTS
```

Run this in the background so it doesn't block the conversation. After joining, confirm which room and peers are connected.
