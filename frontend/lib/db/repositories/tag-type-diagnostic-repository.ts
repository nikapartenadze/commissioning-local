import { prisma, TagTypeDiagnostic } from '../index';

export interface CreateDiagnosticParams {
  tagType: string;
  failureMode: string;
  diagnosticSteps: string;
}

export interface UpdateDiagnosticParams {
  diagnosticSteps?: string;
}

/**
 * Repository for TagTypeDiagnostic operations
 */
export const tagTypeDiagnosticRepository = {
  /**
   * Create a new diagnostic entry
   */
  async create(params: CreateDiagnosticParams): Promise<TagTypeDiagnostic> {
    return prisma.tagTypeDiagnostic.create({
      data: {
        tagType: params.tagType,
        failureMode: params.failureMode,
        diagnosticSteps: params.diagnosticSteps,
        createdAt: new Date(),
      },
    });
  },

  /**
   * Get diagnostic by composite key (tagType + failureMode)
   */
  async getByKey(tagType: string, failureMode: string): Promise<TagTypeDiagnostic | null> {
    return prisma.tagTypeDiagnostic.findUnique({
      where: {
        tagType_failureMode: { tagType, failureMode },
      },
    });
  },

  /**
   * Get all diagnostics for a tag type
   */
  async getByTagType(tagType: string): Promise<TagTypeDiagnostic[]> {
    return prisma.tagTypeDiagnostic.findMany({
      where: { tagType },
      orderBy: { failureMode: 'asc' },
    });
  },

  /**
   * Get all diagnostics for a failure mode
   */
  async getByFailureMode(failureMode: string): Promise<TagTypeDiagnostic[]> {
    return prisma.tagTypeDiagnostic.findMany({
      where: { failureMode },
      orderBy: { tagType: 'asc' },
    });
  },

  /**
   * Get all diagnostics
   */
  async getAll(): Promise<TagTypeDiagnostic[]> {
    return prisma.tagTypeDiagnostic.findMany({
      orderBy: [{ tagType: 'asc' }, { failureMode: 'asc' }],
    });
  },

  /**
   * Update diagnostic steps
   */
  async update(
    tagType: string,
    failureMode: string,
    params: UpdateDiagnosticParams
  ): Promise<TagTypeDiagnostic> {
    return prisma.tagTypeDiagnostic.update({
      where: {
        tagType_failureMode: { tagType, failureMode },
      },
      data: {
        diagnosticSteps: params.diagnosticSteps,
        updatedAt: new Date(),
      },
    });
  },

  /**
   * Create or update diagnostic (upsert)
   */
  async upsert(params: CreateDiagnosticParams): Promise<TagTypeDiagnostic> {
    return prisma.tagTypeDiagnostic.upsert({
      where: {
        tagType_failureMode: {
          tagType: params.tagType,
          failureMode: params.failureMode,
        },
      },
      create: {
        tagType: params.tagType,
        failureMode: params.failureMode,
        diagnosticSteps: params.diagnosticSteps,
        createdAt: new Date(),
      },
      update: {
        diagnosticSteps: params.diagnosticSteps,
        updatedAt: new Date(),
      },
    });
  },

  /**
   * Delete diagnostic by composite key
   */
  async delete(tagType: string, failureMode: string): Promise<void> {
    await prisma.tagTypeDiagnostic.delete({
      where: {
        tagType_failureMode: { tagType, failureMode },
      },
    });
  },

  /**
   * Delete all diagnostics for a tag type
   */
  async deleteByTagType(tagType: string): Promise<number> {
    const result = await prisma.tagTypeDiagnostic.deleteMany({
      where: { tagType },
    });
    return result.count;
  },

  /**
   * Delete all diagnostics
   */
  async deleteAll(): Promise<number> {
    const result = await prisma.tagTypeDiagnostic.deleteMany();
    return result.count;
  },

  /**
   * Get distinct tag types
   */
  async getDistinctTagTypes(): Promise<string[]> {
    const result = await prisma.tagTypeDiagnostic.findMany({
      select: { tagType: true },
      distinct: ['tagType'],
      orderBy: { tagType: 'asc' },
    });
    return result.map((r) => r.tagType);
  },

  /**
   * Get distinct failure modes
   */
  async getDistinctFailureModes(): Promise<string[]> {
    const result = await prisma.tagTypeDiagnostic.findMany({
      select: { failureMode: true },
      distinct: ['failureMode'],
      orderBy: { failureMode: 'asc' },
    });
    return result.map((r) => r.failureMode);
  },

  /**
   * Search diagnostics by text
   */
  async search(query: string): Promise<TagTypeDiagnostic[]> {
    return prisma.tagTypeDiagnostic.findMany({
      where: {
        OR: [
          { tagType: { contains: query } },
          { failureMode: { contains: query } },
          { diagnosticSteps: { contains: query } },
        ],
      },
      orderBy: [{ tagType: 'asc' }, { failureMode: 'asc' }],
    });
  },

  /**
   * Get count of diagnostics
   */
  async count(): Promise<number> {
    return prisma.tagTypeDiagnostic.count();
  },

  /**
   * Check if diagnostic exists
   */
  async exists(tagType: string, failureMode: string): Promise<boolean> {
    const count = await prisma.tagTypeDiagnostic.count({
      where: {
        tagType,
        failureMode,
      },
    });
    return count > 0;
  },

  /**
   * Bulk create or update diagnostics (uses individual upserts since SQLite doesn't support skipDuplicates with composite keys)
   */
  async bulkUpsert(diagnostics: CreateDiagnosticParams[]): Promise<number> {
    let count = 0;
    for (const d of diagnostics) {
      await prisma.tagTypeDiagnostic.upsert({
        where: {
          tagType_failureMode: {
            tagType: d.tagType,
            failureMode: d.failureMode,
          },
        },
        create: {
          tagType: d.tagType,
          failureMode: d.failureMode,
          diagnosticSteps: d.diagnosticSteps,
          createdAt: new Date(),
        },
        update: {
          diagnosticSteps: d.diagnosticSteps,
          updatedAt: new Date(),
        },
      });
      count++;
    }
    return count;
  },
};

export default tagTypeDiagnosticRepository;
