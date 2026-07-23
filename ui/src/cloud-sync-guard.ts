export interface CloudSyncAttemptToken {
  generation: number;
  userId: string | null;
}

export interface LatestCloudSyncGuard {
  setIdentity: (userId: string | null) => boolean;
  begin: (userId: string | null) => CloudSyncAttemptToken;
  isCurrent: (attempt: CloudSyncAttemptToken) => boolean;
}

/**
 * EN: Creates a latest-wins guard for renderer cloud sync state updates.
 * 中文: 创建“最新请求优先”的 renderer 云同步状态保护器。
 * @returns identity-aware generation guard for async sync attempts.
 */
export function createLatestCloudSyncGuard(): LatestCloudSyncGuard {
  let generation = 0;
  let currentUserId: string | null = null;

  return {
    setIdentity: (userId) => {
      if (currentUserId === userId) {
        return false;
      }
      currentUserId = userId;
      generation += 1;
      return true;
    },
    begin: (userId) => {
      if (currentUserId !== userId) {
        return { generation: -1, userId };
      }
      generation += 1;
      return { generation, userId };
    },
    isCurrent: (attempt) =>
      attempt.generation === generation && attempt.userId === currentUserId,
  };
}
