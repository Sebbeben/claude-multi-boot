First check if a swarm is running by looking for `.claude-swarm.pid` in the project directory. If no PID file exists or the process is not running, tell the user no swarm is active and suggest starting one with `/swarm-host` or `/swarm-join`.

If a swarm is running, execute a command on all connected peers:

Usage: /swarm-exec-all <command>

```
claude-swarm exec-all $ARGUMENTS
```

This runs the command on every peer in the swarm and shows results grouped by machine with clear headers.

Run this and show the output to the user. Do not run in the background — the user needs to see the command output.
