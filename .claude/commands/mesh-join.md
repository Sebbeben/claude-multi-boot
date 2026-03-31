First check if a mesh is already running by looking for `.claude-mesh.pid` in the project directory. If a PID file exists and the process is running, tell the user a mesh session is already active and suggest `/mesh-status` or `/mesh-stop` first.

If no mesh is running, join an existing one. If an address is provided use it, otherwise try auto-discovery.

Usage: /mesh-join [address] [--port PORT] [--label NAME]

```
claude-mesh join $ARGUMENTS
```

Run this in the background so it doesn't block the conversation. After joining, confirm which room and peers are connected.
