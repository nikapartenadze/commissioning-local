import { prisma, Io, enrichIo, IoWithComputed, TestConstants } from '../index';

export interface UpdateResultParams {
  id: number;
  result: string;
  comments?: string | null;
  timestamp?: string;
}

export interface CreateIoParams {
  subsystemId: number;
  name: string;
  description?: string | null;
  order?: number | null;
  tagType?: string | null;
  networkDeviceName?: string | null;
}

export interface IoFilters {
  subsystemId?: number;
  result?: string | null;
  hasResult?: boolean;
  tagType?: string;
  search?: string;
}

/**
 * Repository for Io CRUD operations
 */
export const ioRepository = {
  /**
   * Get all IOs with optional filtering
   */
  async getAll(filters?: IoFilters): Promise<IoWithComputed[]> {
    const where: NonNullable<Parameters<typeof prisma.io.findMany>[0]>['where'] = {};

    if (filters?.subsystemId) {
      where.subsystemId = filters.subsystemId;
    }

    if (filters?.result !== undefined) {
      where.result = filters.result;
    }

    if (filters?.hasResult !== undefined) {
      where.result = filters.hasResult ? { not: null } : null;
    }

    if (filters?.tagType) {
      where.tagType = filters.tagType;
    }

    if (filters?.search) {
      where.OR = [
        { name: { contains: filters.search } },
        { description: { contains: filters.search } },
      ];
    }

    const ios = await prisma.io.findMany({
      where,
      orderBy: [{ order: 'asc' }, { id: 'asc' }],
    });

    return ios.map(enrichIo);
  },

  /**
   * Get IO by ID
   */
  async getById(id: number): Promise<IoWithComputed | null> {
    const io = await prisma.io.findUnique({ where: { id } });
    return io ? enrichIo(io) : null;
  },

  /**
   * Get IO by ID with test history
   */
  async getByIdWithHistory(id: number) {
    const io = await prisma.io.findUnique({
      where: { id },
      include: { testHistories: { orderBy: { timestamp: 'desc' } } },
    });
    if (!io) return null;
    return { ...enrichIo(io), testHistories: io.testHistories };
  },

  /**
   * Get IOs by subsystem ID
   */
  async getBySubsystemId(subsystemId: number): Promise<IoWithComputed[]> {
    return this.getAll({ subsystemId });
  },

  /**
   * Get untested IOs
   */
  async getUntested(subsystemId?: number): Promise<IoWithComputed[]> {
    return this.getAll({ subsystemId, result: null });
  },

  /**
   * Get passed IOs
   */
  async getPassed(subsystemId?: number): Promise<IoWithComputed[]> {
    return this.getAll({ subsystemId, result: TestConstants.RESULT_PASSED });
  },

  /**
   * Get failed IOs
   */
  async getFailed(subsystemId?: number): Promise<IoWithComputed[]> {
    return this.getAll({ subsystemId, result: TestConstants.RESULT_FAILED });
  },

  /**
   * Update IO test result
   */
  async updateResult(params: UpdateResultParams): Promise<IoWithComputed> {
    const { id, result, comments, timestamp = new Date().toISOString() } = params;

    const io = await prisma.io.update({
      where: { id },
      data: {
        result,
        comments,
        timestamp,
        version: { increment: 1 },
      },
    });

    return enrichIo(io);
  },

  /**
   * Clear test result for an IO
   */
  async clearResult(id: number): Promise<IoWithComputed> {
    const io = await prisma.io.update({
      where: { id },
      data: {
        result: null,
        comments: null,
        timestamp: null,
        version: { increment: 1 },
      },
    });

    return enrichIo(io);
  },

  /**
   * Update IO tag type
   */
  async updateTagType(id: number, tagType: string | null): Promise<IoWithComputed> {
    const io = await prisma.io.update({
      where: { id },
      data: { tagType },
    });

    return enrichIo(io);
  },

  /**
   * Update cloud sync timestamp
   */
  async updateCloudSyncedAt(id: number, syncedAt: Date = new Date()): Promise<Io> {
    return prisma.io.update({
      where: { id },
      data: { cloudSyncedAt: syncedAt },
    });
  },

  /**
   * Bulk update cloud sync timestamps
   */
  async bulkUpdateCloudSyncedAt(ids: number[], syncedAt: Date = new Date()): Promise<void> {
    await prisma.io.updateMany({
      where: { id: { in: ids } },
      data: { cloudSyncedAt: syncedAt },
    });
  },

  /**
   * Get IOs that need syncing (updated after last cloud sync)
   */
  async getUnsynced(): Promise<IoWithComputed[]> {
    const ios = await prisma.io.findMany({
      where: {
        result: { not: null },
        OR: [
          { cloudSyncedAt: null },
          // For IOs where timestamp > cloudSyncedAt, we need raw query or app-level filtering
        ],
      },
      orderBy: { timestamp: 'asc' },
    });

    return ios.map(enrichIo);
  },

  /**
   * Create a new IO
   */
  async create(params: CreateIoParams): Promise<IoWithComputed> {
    const io = await prisma.io.create({
      data: {
        subsystemId: params.subsystemId,
        name: params.name,
        description: params.description,
        order: params.order,
        tagType: params.tagType,
        networkDeviceName: params.networkDeviceName,
        version: BigInt(0),
      },
    });

    return enrichIo(io);
  },

  /**
   * Bulk create IOs
   */
  async bulkCreate(ios: CreateIoParams[]): Promise<number> {
    const result = await prisma.io.createMany({
      data: ios.map((io) => ({
        subsystemId: io.subsystemId,
        name: io.name,
        description: io.description,
        order: io.order,
        tagType: io.tagType,
        networkDeviceName: io.networkDeviceName,
        version: BigInt(0),
      })),
    });

    return result.count;
  },

  /**
   * Delete IO by ID
   */
  async delete(id: number): Promise<void> {
    await prisma.io.delete({ where: { id } });
  },

  /**
   * Delete all IOs for a subsystem
   */
  async deleteBySubsystemId(subsystemId: number): Promise<number> {
    const result = await prisma.io.deleteMany({ where: { subsystemId } });
    return result.count;
  },

  /**
   * Delete all IOs
   */
  async deleteAll(): Promise<number> {
    const result = await prisma.io.deleteMany();
    return result.count;
  },

  /**
   * Get distinct tag types
   */
  async getDistinctTagTypes(): Promise<string[]> {
    const result = await prisma.io.findMany({
      where: { tagType: { not: null } },
      select: { tagType: true },
      distinct: ['tagType'],
    });

    return result.map((r) => r.tagType).filter((t): t is string => t !== null);
  },

  /**
   * Get distinct network device names
   */
  async getDistinctNetworkDevices(): Promise<string[]> {
    const result = await prisma.io.findMany({
      where: { networkDeviceName: { not: null } },
      select: { networkDeviceName: true },
      distinct: ['networkDeviceName'],
    });

    return result.map((r) => r.networkDeviceName).filter((n): n is string => n !== null);
  },

  /**
   * Get IO count
   */
  async count(filters?: IoFilters): Promise<number> {
    const where: NonNullable<Parameters<typeof prisma.io.count>[0]>['where'] = {};

    if (filters?.subsystemId) {
      where.subsystemId = filters.subsystemId;
    }

    if (filters?.result !== undefined) {
      where.result = filters.result;
    }

    if (filters?.hasResult !== undefined) {
      where.result = filters.hasResult ? { not: null } : null;
    }

    return prisma.io.count({ where });
  },
};

export default ioRepository;
