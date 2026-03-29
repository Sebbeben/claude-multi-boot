First check if a swarm is configured by looking for `.claude-swarm.json` in the project directory. If it doesn't exist, tell the user no swarm is configured and suggest `/swarm-host` or `/swarm-join`.

Also check `.claude-swarm.pid` to determine if the swarm process is actually running or just configured but stopped.

If configured, show the status:

```
claude-swarm status
```

Report whether the swarm process is running or stopped based on the PID file.
