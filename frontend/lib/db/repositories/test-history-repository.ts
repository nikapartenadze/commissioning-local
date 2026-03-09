import { prisma, TestHistory, enrichTestHistory, TestHistoryWithComputed, TestConstants } from '../index';

export interface CreateTestHistoryParams {
  ioId: number;
  result: string;
  state?: string | null;
  comments?: string | null;
  testedBy?: string | null;
  failureMode?: string | null;
  timestamp?: string;
}

export interface TestHistoryFilters {
  ioId?: number;
  result?: string;
  testedBy?: string;
  failureMode?: string;
  fromDate?: Date;
  toDate?: Date;
}

/**
 * Repository for TestHistory CRUD operations
 */
export const testHistoryRepository = {
  /**
   * Create a test history record
   */
  async create(params: CreateTestHistoryParams): Promise<TestHistoryWithComputed> {
    const history = await prisma.testHistory.create({
      data: {
        ioId: params.ioId,
        result: params.result,
        state: params.state,
        comments: params.comments,
        testedBy: params.testedBy,
        failureMode: params.failureMode,
        timestamp: params.timestamp ?? new Date().toISOString(),
      },
    });

    return enrichTestHistory(history);
  },

  /**
   * Get test history by ID
   */
  async getById(id: number): Promise<TestHistoryWithComputed | null> {
    const history = await prisma.testHistory.findUnique({ where: { id } });
    return history ? enrichTestHistory(history) : null;
  },

  /**
   * Get all history for an IO
   */
  async getByIoId(ioId: number): Promise<TestHistoryWithComputed[]> {
    const histories = await prisma.testHistory.findMany({
      where: { ioId },
      orderBy: { timestamp: 'desc' },
    });

    return histories.map(enrichTestHistory);
  },

  /**
   * Get latest history entry for an IO
   */
  async getLatestForIo(ioId: number): Promise<TestHistoryWithComputed | null> {
    const history = await prisma.testHistory.findFirst({
      where: { ioId },
      orderBy: { timestamp: 'desc' },
    });

    return history ? enrichTestHistory(history) : null;
  },

  /**
   * Get all test history with optional filtering
   */
  async getAll(filters?: TestHistoryFilters, limit?: number): Promise<TestHistoryWithComputed[]> {
    const where: NonNullable<Parameters<typeof prisma.testHistory.findMany>[0]>['where'] = {};

    if (filters?.ioId) {
      where.ioId = filters.ioId;
    }

    if (filters?.result) {
      where.result = filters.result;
    }

    if (filters?.testedBy) {
      where.testedBy = { contains: filters.testedBy };
    }

    if (filters?.failureMode) {
      where.failureMode = filters.failureMode;
    }

    // Date filtering requires string comparison for SQLite
    if (filters?.fromDate || filters?.toDate) {
      const timestampFilters: { gte?: string; lte?: string } = {};
      if (filters.fromDate) {
        timestampFilters.gte = filters.fromDate.toISOString();
      }
      if (filters.toDate) {
        timestampFilters.lte = filters.toDate.toISOString();
      }
      where.timestamp = timestampFilters;
    }

    const histories = await prisma.testHistory.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      take: limit,
    });

    return histories.map(enrichTestHistory);
  },

  /**
   * Get history with IO details
   */
  async getWithIo(id: number) {
    const history = await prisma.testHistory.findUnique({
      where: { id },
      include: { io: true },
    });

    if (!history) return null;

    return {
      ...enrichTestHistory(history),
      io: history.io,
    };
  },

  /**
   * Get recent test history
   */
  async getRecent(limit: number = 50): Promise<TestHistoryWithComputed[]> {
    const histories = await prisma.testHistory.findMany({
      orderBy: { timestamp: 'desc' },
      take: limit,
    });

    return histories.map(enrichTestHistory);
  },

  /**
   * Get test history grouped by tester
   */
  async getCountByTester(): Promise<{ testedBy: string; count: number }[]> {
    const result = await prisma.testHistory.groupBy({
      by: ['testedBy'],
      _count: { id: true },
      where: { testedBy: { not: null } },
    });

    return result.map((r) => ({
      testedBy: r.testedBy ?? 'Unknown',
      count: r._count.id,
    }));
  },

  /**
   * Get test history counts by result
   */
  async getCountByResult(): Promise<{ result: string; count: number }[]> {
    const result = await prisma.testHistory.groupBy({
      by: ['result'],
      _count: { id: true },
    });

    return result.map((r) => ({
      result: r.result ?? 'Unknown',
      count: r._count.id,
    }));
  },

  /**
   * Get failure modes distribution
   */
  async getFailureModeDistribution(): Promise<{ failureMode: string; count: number }[]> {
    const result = await prisma.testHistory.groupBy({
      by: ['failureMode'],
      _count: { id: true },
      where: {
        failureMode: { not: null },
        result: TestConstants.RESULT_FAILED,
      },
    });

    return result.map((r) => ({
      failureMode: r.failureMode ?? 'Unknown',
      count: r._count.id,
    }));
  },

  /**
   * Delete history by ID
   */
  async delete(id: number): Promise<void> {
    await prisma.testHistory.delete({ where: { id } });
  },

  /**
   * Delete all history for an IO
   */
  async deleteByIoId(ioId: number): Promise<number> {
    const result = await prisma.testHistory.deleteMany({ where: { ioId } });
    return result.count;
  },

  /**
   * Delete all test history
   */
  async deleteAll(): Promise<number> {
    const result = await prisma.testHistory.deleteMany();
    return result.count;
  },

  /**
   * Get total count
   */
  async count(filters?: TestHistoryFilters): Promise<number> {
    const where: NonNullable<Parameters<typeof prisma.testHistory.count>[0]>['where'] = {};

    if (filters?.ioId) {
      where.ioId = filters.ioId;
    }

    if (filters?.result) {
      where.result = filters.result;
    }

    return prisma.testHistory.count({ where });
  },

  /**
   * Check if IO has any test history
   */
  async hasHistory(ioId: number): Promise<boolean> {
    const count = await prisma.testHistory.count({ where: { ioId } });
    return count > 0;
  },
};

export default testHistoryRepository;
