First check if a mesh is running by looking for `.claude-mesh.pid` in the project directory. If no PID file exists, tell the user no mesh is running.

If a mesh is running, stop it:

```
claude-mesh stop
```

Confirm whether the process was stopped successfully.
