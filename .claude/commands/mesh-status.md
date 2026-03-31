First check if a mesh is configured by looking for `.claude-mesh.json` in the project directory. If it doesn't exist, tell the user no mesh is configured and suggest `/mesh-host` or `/mesh-join`.

Also check `.claude-mesh.pid` to determine if the mesh process is actually running or just configured but stopped.

If configured, show the status:

```
claude-mesh status
```

Report whether the mesh process is running or stopped based on the PID file.
