First check if a mesh is already running by looking for `.claude-mesh.pid` in the project directory. If a PID file exists and the process is running, tell the user a mesh is already active and suggest `/mesh-status` or `/mesh-stop` first.

If no mesh is running, start a host:

```
claude-mesh host --label "$HOSTNAME"
```

Run this in the background so it doesn't block the conversation. After starting, show the join instructions (IP address and port) so other machines can connect.
