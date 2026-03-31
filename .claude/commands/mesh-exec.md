First check if a mesh is running by looking for `.claude-mesh.pid` in the project directory. If no PID file exists or the process is not running, tell the user no mesh is active and suggest starting one with `/mesh-host` or `/mesh-join`.

If a mesh is running, execute a command on a remote peer:

Usage: /mesh-exec <target-label> <command>

```
claude-mesh exec $ARGUMENTS
```

The `<target-label>` is the label or hostname of the peer. Use `/mesh-status` to see connected peers.

Run this and show the output to the user. Do not run in the background — the user needs to see the command output.
