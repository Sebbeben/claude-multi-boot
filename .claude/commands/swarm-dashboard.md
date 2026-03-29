First check if a swarm is running by looking for `.claude-swarm.pid` in the project directory. If no PID file exists or the process is not running, tell the user no swarm is active and suggest starting one with `/swarm-host` or `/swarm-join`.

If a swarm is running, open the live dashboard:

```
claude-swarm dashboard
```

Run this in the background so it doesn't block the conversation.
