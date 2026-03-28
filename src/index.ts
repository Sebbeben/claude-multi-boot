export { SyncServer } from "./server/index.js";
export { SyncClient } from "./client/sync-client.js";
export { getMachineIdentity, formatMachineId, generateMachineContext } from "./shared/machine-identity.js";
export type { MachineIdentity } from "./shared/machine-identity.js";
export type {
  SyncMessage,
  RoomConfig,
  PeerInfo,
  MemoryUpdatePayload,
  ClaudeMdUpdatePayload,
  SessionEventPayload,
  FileChangePayload,
} from "./shared/types.js";
