First check if a mesh is running by looking for `.claude-mesh.pid` in the project directory. If no PID file exists or the process is not running, tell the user no mesh is active and suggest starting one with `/mesh-host` or `/mesh-join`.

If a mesh is running, open the live dashboard:

```
claude-mesh dashboard
```

Run this in the background so it doesn't block the conversation.
