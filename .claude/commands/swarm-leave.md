First check if a swarm is running by looking for `.claude-swarm.pid` in the project directory. If no PID file exists, tell the user no swarm is running — there's nothing to leave.

If a swarm is running, leave it by stopping the sync client:

```
claude-swarm stop
```

Confirm whether the process was stopped successfully.
