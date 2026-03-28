export { SyncServer } from "./server/index.js";
export { SyncClient } from "./client/sync-client.js";
export type { ActivityEvent } from "./client/sync-client.js";
export { getMachineIdentity, formatMachineId, generateMachineContext } from "./shared/machine-identity.js";
export type { MachineIdentity } from "./shared/machine-identity.js";
export { MachineColorMap } from "./shared/colors.js";
export type {
  SyncMessage,
  RoomConfig,
  PeerInfo,
  MemoryUpdatePayload,
  ClaudeMdUpdatePayload,
  SessionEventPayload,
  FileChangePayload,
  ChatMessagePayload,
  ActivityPayload,
} from "./shared/types.js";
