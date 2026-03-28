# claude-multi-boot

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

Each machine gets a persistent identity stored in `~/.claude-multi-boot/identity.json`:
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

- **Node.js** >= 18.0.0
- **npm** >= 9.0.0
- **Claude Code CLI** installed on each machine ([install guide](https://docs.anthropic.com/en/docs/claude-code))

## Installation

### Option A: Install from GitHub (recommended)

Run this on **every machine** you want to sync:

```bash
# Clone the repo
git clone https://github.com/sebbeben/claude-multi-boot.git
cd claude-multi-boot

# Install dependencies
npm install

# Build from source
npm run build

# Link globally so "claude-multi-boot" works from anywhere
npm link
```

After linking, the `claude-multi-boot` command is available system-wide.

### Option B: Install from npm (once published)

```bash
npm install -g claude-multi-boot
```

### Option C: Use without global install

If you don't want to install globally, you can run commands directly:

```bash
cd /path/to/claude-multi-boot
node dist/cli.js serve
node dist/cli.js init --server ws://your-server:24680
node dist/cli.js sync
```

### Verify installation

```bash
claude-multi-boot --version
# 0.1.0

claude-multi-boot --help
```

## Quick Start

### 1. Start the relay server

Pick **one machine** that's reachable by all your dev machines (can be a VPS, cloud VM, or any machine on your network):

```bash
claude-multi-boot serve --port 24680
```

Leave this running. It's the central hub all machines connect to.

### 2. Initialize on Machine A

```bash
cd /your/project
claude-multi-boot init --server ws://your-server-ip:24680 --label "work-laptop"
```

This creates `.claude-multi-boot.json` and outputs a room ID. **Copy the room ID** — you'll need it for every other machine.

### 3. Initialize on Machine B (and C, D, ...)

Use the **same room ID** from Machine A:

```bash
cd /your/project
claude-multi-boot init --server ws://your-server-ip:24680 --room <room-id> --label "home-desktop"
```

Repeat for as many machines as you want — there's no limit.

### 4. Start syncing on all machines

Run this on **each machine**:

```bash
claude-multi-boot sync
```

You'll see the colored activity feed showing all connected machines. Type messages to chat between machines.

### 5. (Optional) Install Claude Code hooks

For automatic session event broadcasting when Claude edits files or runs commands:

```bash
claude-multi-boot install-hooks
```

This writes hook config to `.claude/settings.local.json` in your project.

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
| `claude-multi-boot serve` | Start the relay server |
| `claude-multi-boot init` | Initialize sync for a project |
| `claude-multi-boot sync` | Start syncing with the room |
| `claude-multi-boot status` | Show current sync config |
| `claude-multi-boot install-hooks` | Install Claude Code hooks |

## Configuration

### `.claude-multi-boot.json` (per project)

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

### `~/.claude-multi-boot/identity.json` (per machine)

Persistent machine identity. Auto-generated on first run, or set with `--label`.

## Security Notes

- The relay server has **no authentication** by default — run it on a trusted network or behind a VPN
- All communication is **unencrypted WebSocket** — use `wss://` with a reverse proxy (nginx, caddy) for production
- File contents are transmitted in full — don't sync sensitive files

## Architecture

- **Server** (`src/server/`) — WebSocket relay that manages rooms and broadcasts messages
- **Client** (`src/client/`) — Connects to relay, watches local files, applies remote changes
- **Hooks** (`src/hooks/`) — Claude Code hook scripts for SessionStart and PostToolUse
- **Shared** (`src/shared/`) — Types, utilities, and machine identity management
- **CLI** (`src/cli.ts`) — Command-line interface tying everything together

## License

MIT
