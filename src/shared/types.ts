export interface SyncMessage {
  type: MessageType;
  roomId: string;
  peerId: string;
  timestamp: number;
  payload: unknown;
}

export type MessageType =
  | "join"
  | "leave"
  | "memory-update"
  | "claude-md-update"
  | "session-event"
  | "file-change"
  | "peer-list"
  | "heartbeat"
  | "request-sync"
  | "chat-message"
  | "activity";

export interface MemoryUpdatePayload {
  filePath: string;
  content: string;
  hash: string;
}

export interface ClaudeMdUpdatePayload {
  content: string;
  hash: string;
  projectPath: string;
}

export interface SessionEventPayload {
  event: string;
  sessionId: string;
  data: Record<string, unknown>;
}

export interface FileChangePayload {
  relativePath: string;
  content: string;
  action: "create" | "update" | "delete";
}

export interface PeerInfo {
  id: string;
  hostname: string;
  label: string;
  ip: string;
  platform: string;
  arch: string;
  joinedAt: number;
  lastSeen: number;
}

export interface ChatMessagePayload {
  text: string;
  machineLabel: string;
  machineIp: string;
}

export interface ActivityPayload {
  action: string;
  detail: string;
  machineLabel: string;
  machineIp: string;
}

export interface PeerListPayload {
  peers: PeerInfo[];
}

export interface RoomConfig {
  roomId: string;
  serverUrl: string;
  projectPath: string;
  syncPaths: string[];
}

export const DEFAULT_PORT = 24680;
export const HEARTBEAT_INTERVAL = 15000;
export const PEER_TIMEOUT = 45000;
