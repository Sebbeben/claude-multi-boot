First check if a swarm is already running by looking for `.claude-swarm.pid` in the project directory. If a PID file exists and the process is running, tell the user a swarm is already active and suggest `/swarm-status` or `/swarm-stop` first.

If no swarm is running, start a host:

```
claude-swarm host --label "$HOSTNAME"
```

Run this in the background so it doesn't block the conversation. After starting, show the join instructions (IP address and port) so other machines can connect.
