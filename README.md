# claude-mesh

Sync Claude Code sessions across multiple machines in real-time. Run one Claude conversation and keep context, memory, and session events synchronized across all your development machines.

## How It Works

```
┌─────────────┐                   ┌───────────────┐                   ┌─────────────┐
│  Machine A  │◄──── WebSocket ──►│  Relay Server │◄──── WebSocket ──►│  Machine B  │
│  Claude CLI │                   │  (central hub)│                   │  Claude CLI │
│  + hooks    │                   └───────┬───────┘                   │  + hooks    │
└─────────────┘                           │                           └─────────────┘
                                          │ WebSocket
                                ┌─────────┴─────────┐
                                │    Machine C ...   │
                                │    Claude CLI      │
                                │    + hooks         │
                                └────────────────────┘
```

Supports **unlimited machines** in a single room — not just 2!

1. A lightweight **relay server** runs on any reachable machine (or cloud VM)
2. Each machine runs a **sync client** that watches for file changes
3. **Claude Code hooks** automatically broadcast session events
4. Each machine's **CLAUDE.md** is updated with connected peer info so Claude knows which machine is which

## Machine Identity

Each machine gets a persistent identity stored in `~/.claude-mesh/identity.json`:
- **Label** — human-readable name (e.g., "work-laptop", "home-desktop")
- **Hostname** — OS hostname
- **IP** — local network IP address
- **Platform/Arch** — OS and architecture info

Claude sees this in CLAUDE.md and will never confuse machines:
```markdown
**This machine:** work-laptop (192.168.1.10, linux/x64)
**Total machines in room:** 3
**Connected peers:**
- home-desktop (192.168.1.20, darwin/arm64)
- cloud-vm (10.0.0.5, linux/x64)
```

## Colored Activity Feed

Every message in the sync terminal is prefixed with the machine's hostname in a unique color:

```
12:34:56 + (work-laptop) [192.168.1.10] joined the room      <- cyan
12:34:57 + (home-desktop) [192.168.1.20] joined the room     <- magenta
12:34:58 + (cloud-vm) [10.0.0.5] joined the room             <- yellow
12:35:01 > (work-laptop) [192.168.1.10] starting frontend work
12:35:12 ~ (home-desktop) [192.168.1.20] updated src/api.ts
12:35:20 * (cloud-vm) [10.0.0.5] Ran: npm test
12:35:25 > (home-desktop) [192.168.1.20] API refactor done!
```

Each machine gets a **persistent unique color** from a 12-color palette (cyan, magenta, yellow, green, blue, red, orange, teal, purple, gold, sky-blue, coral). Colors cycle for 13+ machines.

You can also **type messages directly** in the sync terminal to chat between machines.

## Prerequisites

- **Node.js** >= 20.12.0
- **npm** >= 9.0.0
- **Claude Code CLI** installed on each machine ([install guide](https://docs.anthropic.com/en/docs/claude-code))

## Installation

### Option A: Install from GitHub (recommended)

Run this on **every machine** you want to sync:

```bash
# Clone the repo
git clone https://github.com/sebbeben/claude-mesh.git
cd claude-mesh

# Install dependencies
npm install

# Build from source
npm run build

# Link globally so "claude-mesh" works from anywhere
npm link
```

After linking, the `claude-mesh` command is available system-wide.

### Option B: Install from npm (once published)

```bash
npm install -g claude-mesh
```

### Option C: Use without global install

If you don't want to install globally, you can run commands directly:

```bash
cd /path/to/claude-mesh
node dist/cli.js host                         # Machine A
node dist/cli.js join 192.168.1.10            # Machine B
```

### Verify installation

```bash
claude-mesh --version
# 0.2.0

claude-mesh --help
```

## Quick Start

### Machine A — start a mesh

```bash
cd /your/project
claude-mesh host
```

That's it. This starts the relay server, connects you, and prints:

```
  Mesh started! Relay running on port 24680
  Machine:  work-laptop (192.168.1.10, linux/x64)

  Others can join with:

    claude-mesh join 192.168.1.10
```

### Machine B — join the mesh

```bash
cd /your/project
claude-mesh join 192.168.1.10
```

Done. You're synced. Repeat on as many machines as you want.

### That's it. Two commands.

You'll see the colored activity feed showing all connected machines. Type messages to chat between machines.

### Stopping the mesh

```bash
# Stop from any context (terminal, Claude Code, SSH)
claude-mesh stop
```

This finds the running mesh process via its PID file and gracefully shuts it down. Works for both hosts and joined clients.

### Options

```bash
# Custom port
claude-mesh host --port 3000
claude-mesh join 192.168.1.10 --port 3000

# Custom machine label
claude-mesh host --label "work-laptop"
claude-mesh join 192.168.1.10 --label "home-desktop"

# Token authentication
claude-mesh host --token
claude-mesh join 192.168.1.10 --token <token>
```

### (Optional) Install Claude Code hooks

For automatic session event broadcasting when Claude edits files or runs commands:

```bash
claude-mesh install-hooks
```

This writes hook config to `.claude/settings.local.json` in your project.

## Claude Code Slash Commands

When working in a project with claude-mesh installed, these slash commands are available in the Claude Code chat:

| Command | Description |
|---------|-------------|
| `/mesh-host` | Start hosting a mesh |
| `/mesh-join [address]` | Join an existing mesh |
| `/mesh-stop` | Stop the running mesh |
| `/mesh-leave` | Leave a mesh (alias for stop) |
| `/mesh-status` | Show sync status |
| `/mesh-dashboard` | Open live dashboard |

## What Gets Synced

| Content | Direction | Trigger |
|---------|-----------|---------|
| `CLAUDE.md` | Bidirectional | File change |
| `.claude/settings.json` | Bidirectional | File change |
| Auto-memory files | Bidirectional | File change |
| Session events (edits, commands) | Broadcast | Claude Code hooks |
| Machine identity/peer list | Automatic | On connect |

## CLI Commands

| Command | Description |
|---------|-------------|
| `claude-mesh host` | Start a mesh (server + sync in one command) |
| `claude-mesh join <ip>` | Join a mesh by IP, hostname, or auto-discovery |
| `claude-mesh stop` | Stop the running mesh process |
| `claude-mesh status` | Show current sync config |
| `claude-mesh dashboard` | Live status dashboard with peers and activity |
| `claude-mesh install-hooks` | Install Claude Code hooks |

**Advanced** (manual control):

| Command | Description |
|---------|-------------|
| `claude-mesh serve` | Start only the relay server |
| `claude-mesh init` | Initialize config manually |
| `claude-mesh sync` | Sync with existing config |

## Multi-Network Support

Machines can join from different networks (e.g., LAN + VPN) connecting to the same host via different IPs. The server automatically redirects joiners to the active room when the client-computed room hash doesn't match due to different IP addresses.

```text
Home LAN (192.168.1.x)          VPN (172.16.x.x)
┌──────────┐                    ┌──────────┐
│ orangepi │─── 192.168.1.11 ──│          │
└──────────┘                    │  Host PC │
                                │          │
┌──────────┐                    │          │
│  conbat  │─── 172.16.255.11 ─│          │
└──────────┘                    └──────────┘
```

## Configuration

### `.claude-mesh.json` (per project)

```json
{
  "roomId": "a1b2c3d4e5f6",
  "serverUrl": "ws://your-server:24680",
  "projectPath": "/path/to/project",
  "syncPaths": [
    "CLAUDE.md",
    ".claude/settings.json",
    ".claude/settings.local.json"
  ],
  "machine": {
    "peerId": "hostname-abcd1234",
    "label": "work-laptop",
    "hostname": "work-laptop",
    "ip": "192.168.1.10",
    "platform": "linux",
    "arch": "x64"
  }
}
```

### `~/.claude-mesh/identity.json` (per machine)

Persistent machine identity. Auto-generated on first run, or set with `--label`.

### `.claude-mesh.pid` (per project)

PID file for the running mesh process. Used by `claude-mesh stop` to find and kill the process. Automatically created on start and removed on exit.

## Security Notes

- The relay server has **no authentication** by default — use `--token` or run on a trusted network / behind a VPN
- All communication is **unencrypted WebSocket** — use `wss://` with a reverse proxy (nginx, caddy) for production
- File contents are transmitted in full — don't sync sensitive files

## Architecture

- **Server** (`src/server/`) — WebSocket relay that manages rooms and broadcasts messages
- **Client** (`src/client/`) — Connects to relay, watches local files, applies remote changes
- **Hooks** (`src/hooks/`) — Claude Code hook scripts for SessionStart and PostToolUse
- **Shared** (`src/shared/`) — Types, utilities, and machine identity management
- **CLI** (`src/cli.ts`) — Command-line interface tying everything together
- **Commands** (`.claude/commands/`) — Claude Code slash commands for in-chat usage

## License

MIT
