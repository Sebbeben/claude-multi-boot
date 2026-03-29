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
  | "file-delta"
  | "peer-list"
  | "heartbeat"
  | "request-sync"
  | "chat-message"
  | "activity"
  | "history";

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

export interface FileDeltaPayload {
  relativePath: string;
  baseHash: string;
  resultHash: string;
  ops: Array<{ op: "keep" | "add" | "remove"; value: string | number }>;
}

export interface PeerListPayload {
  peers: PeerInfo[];
}

export interface RoomConfig {
  roomId: string;
  serverUrl: string;
  projectPath: string;
  syncPaths: string[];
  token?: string;
  syncFilter?: SyncFilter;
  /** When true, the server may redirect this client to an existing room if the requested room doesn't exist. */
  autoJoinRoom?: boolean;
}

export interface SyncFilter {
  /** Glob patterns of paths to receive. Empty = receive all. */
  include?: string[];
  /** Glob patterns of paths to exclude from receiving. */
  exclude?: string[];
  /** Message types to receive. Empty = receive all. */
  messageTypes?: MessageType[];
}

export const DEFAULT_PORT = 24680;
export const HEARTBEAT_INTERVAL = 15000;
export const PEER_TIMEOUT = 45000;
export const MAX_FILE_SIZE = 1024 * 1024; // 1 MB
export const MAX_MESSAGE_SIZE = 2 * 1024 * 1024; // 2 MB (file + overhead)
