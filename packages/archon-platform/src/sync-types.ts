/** Fields required for cloud sync (see proposed-architecture ADR-005/006). */
export interface SyncDocument {
  id: string;
  updatedAt: number;
  deleted: boolean;
  version: number;
}

export interface SyncPushResponse {
  accepted: string[];
  conflicts: SyncDocument[];
}

export interface SyncPullResponse {
  documents: SyncDocument[];
  lastSync: number;
}
