import { prisma, PendingSync } from '../index';

export interface CreatePendingSyncParams {
  ioId: number;
  inspectorName?: string | null;
  testResult?: string | null;
  comments?: string | null;
  state?: string | null;
  timestamp?: Date | null;
}

/**
 * Repository for PendingSync (offline queue) operations
 */
export const pendingSyncRepository = {
  /**
   * Create a new pending sync entry
   */
  async create(params: CreatePendingSyncParams): Promise<PendingSync> {
    return prisma.pendingSync.create({
      data: {
        ioId: params.ioId,
        inspectorName: params.inspectorName,
        testResult: params.testResult,
        comments: params.comments,
        state: params.state,
        timestamp: params.timestamp,
        createdAt: new Date(),
        retryCount: 0,
        version: BigInt(0),
      },
    });
  },

  /**
   * Get all pending syncs ordered by creation date
   */
  async getAll(): Promise<PendingSync[]> {
    return prisma.pendingSync.findMany({
      orderBy: { createdAt: 'asc' },
    });
  },

  /**
   * Get pending syncs for a specific IO
   */
  async getByIoId(ioId: number): Promise<PendingSync[]> {
    return prisma.pendingSync.findMany({
      where: { ioId },
      orderBy: { createdAt: 'asc' },
    });
  },

  /**
   * Get next batch of pending syncs to process
   */
  async getNextBatch(batchSize: number): Promise<PendingSync[]> {
    return prisma.pendingSync.findMany({
      orderBy: { createdAt: 'asc' },
      take: batchSize,
    });
  },

  /**
   * Get pending syncs that have failed (retryCount > 0)
   */
  async getFailed(): Promise<PendingSync[]> {
    return prisma.pendingSync.findMany({
      where: { retryCount: { gt: 0 } },
      orderBy: { createdAt: 'asc' },
    });
  },

  /**
   * Increment retry count and set last error
   */
  async recordFailure(id: number, error: string): Promise<PendingSync> {
    return prisma.pendingSync.update({
      where: { id },
      data: {
        retryCount: { increment: 1 },
        lastError: error,
      },
    });
  },

  /**
   * Delete a pending sync (after successful sync)
   */
  async delete(id: number): Promise<void> {
    await prisma.pendingSync.delete({ where: { id } });
  },

  /**
   * Delete multiple pending syncs by IDs
   */
  async deleteMany(ids: number[]): Promise<number> {
    const result = await prisma.pendingSync.deleteMany({
      where: { id: { in: ids } },
    });
    return result.count;
  },

  /**
   * Delete all pending syncs for an IO
   */
  async deleteByIoId(ioId: number): Promise<number> {
    const result = await prisma.pendingSync.deleteMany({
      where: { ioId },
    });
    return result.count;
  },

  /**
   * Delete all pending syncs
   */
  async deleteAll(): Promise<number> {
    const result = await prisma.pendingSync.deleteMany();
    return result.count;
  },

  /**
   * Get count of pending syncs
   */
  async count(): Promise<number> {
    return prisma.pendingSync.count();
  },

  /**
   * Check if there are any pending syncs
   */
  async hasPending(): Promise<boolean> {
    const count = await prisma.pendingSync.count();
    return count > 0;
  },

  /**
   * Get oldest pending sync
   */
  async getOldest(): Promise<PendingSync | null> {
    return prisma.pendingSync.findFirst({
      orderBy: { createdAt: 'asc' },
    });
  },

  /**
   * Get pending syncs with high retry count (potential permanent failures)
   */
  async getHighRetryCount(threshold: number = 5): Promise<PendingSync[]> {
    return prisma.pendingSync.findMany({
      where: { retryCount: { gte: threshold } },
      orderBy: { retryCount: 'desc' },
    });
  },

  /**
   * Reset retry count for a pending sync
   */
  async resetRetryCount(id: number): Promise<PendingSync> {
    return prisma.pendingSync.update({
      where: { id },
      data: {
        retryCount: 0,
        lastError: null,
      },
    });
  },

  /**
   * Get statistics about pending syncs
   */
  async getStats(): Promise<{
    total: number;
    failed: number;
    maxRetries: number;
    oldestTimestamp: Date | null;
  }> {
    const [total, failed, oldest, maxRetryRecord] = await Promise.all([
      prisma.pendingSync.count(),
      prisma.pendingSync.count({ where: { retryCount: { gt: 0 } } }),
      prisma.pendingSync.findFirst({ orderBy: { createdAt: 'asc' } }),
      prisma.pendingSync.findFirst({ orderBy: { retryCount: 'desc' } }),
    ]);

    return {
      total,
      failed,
      maxRetries: maxRetryRecord?.retryCount ?? 0,
      oldestTimestamp: oldest?.createdAt ?? null,
    };
  },
};

export default pendingSyncRepository;
