First check if a mesh is running by looking for `.claude-mesh.pid` in the project directory. If no PID file exists or the process is not running, tell the user no mesh is active and suggest starting one with `/mesh-host` or `/mesh-join`.

If a mesh is running, execute a command on all connected peers:

Usage: /mesh-exec-all <command>

```
claude-mesh exec-all $ARGUMENTS
```

This runs the command on every peer in the mesh and shows results grouped by machine with clear headers.

Run this and show the output to the user. Do not run in the background — the user needs to see the command output.
