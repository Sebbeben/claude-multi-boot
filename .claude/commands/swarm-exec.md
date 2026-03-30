First check if a swarm is running by looking for `.claude-swarm.pid` in the project directory. If no PID file exists or the process is not running, tell the user no swarm is active and suggest starting one with `/swarm-host` or `/swarm-join`.

If a swarm is running, execute a command on a remote peer:

Usage: /swarm-exec <target-label> <command>

```
claude-swarm exec $ARGUMENTS
```

The `<target-label>` is the label or hostname of the peer. Use `/swarm-status` to see connected peers.

Run this and show the output to the user. Do not run in the background — the user needs to see the command output.
