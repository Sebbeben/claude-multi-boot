First check if a swarm is running by looking for `.claude-swarm.pid` in the project directory. If no PID file exists, tell the user no swarm is running.

If a swarm is running, stop it:

```
claude-swarm stop
```

Confirm whether the process was stopped successfully.
