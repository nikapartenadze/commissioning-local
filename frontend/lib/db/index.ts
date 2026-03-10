import { PrismaClient, Io, TestHistory, User, PendingSync, TagTypeDiagnostic } from '@prisma/client';

// Prisma client singleton
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

// Re-export types for convenience
export type { Io, TestHistory, User, PendingSync, TagTypeDiagnostic };

export const TestConstants = {
  RESULT_PASSED: 'Passed',
  RESULT_FAILED: 'Failed',
} as const;

// Helper type for IO with computed properties
export interface IoWithComputed extends Io {
  isOutput: boolean;
  hasResult: boolean;
  isPassed: boolean;
  isFailed: boolean;
}

// Add computed properties to IO
export function enrichIo(io: Io): IoWithComputed {
  const name = io.name ?? '';
  return {
    ...io,
    isOutput:
      name.includes(':O.') ||
      name.includes(':SO.') ||
      name.includes('.O.') ||
      name.includes(':O:') ||
      name.includes('.Outputs.') ||
      name.endsWith('.DO'),
    hasResult: !!io.result,
    isPassed: io.result === TestConstants.RESULT_PASSED,
    isFailed: io.result === TestConstants.RESULT_FAILED,
  };
}

// Helper type for TestHistory with computed properties
export interface TestHistoryWithComputed extends TestHistory {
  timestampAsDate: Date | null;
  isPassed: boolean;
  isFailed: boolean;
}

// Add computed properties to TestHistory
export function enrichTestHistory(history: TestHistory): TestHistoryWithComputed {
  const date = history.timestamp ? new Date(history.timestamp) : null;
  return {
    ...history,
    timestampAsDate: date && !isNaN(date.getTime()) ? date : null,
    isPassed: history.result === TestConstants.RESULT_PASSED,
    isFailed: history.result === TestConstants.RESULT_FAILED,
  };
}

// Common query helpers

/**
 * Get count of IOs grouped by result status
 */
export async function getIoStatusCounts(subsystemId?: number) {
  const whereClause = subsystemId ? { subsystemId } : {};

  const [total, passed, failed, untested] = await Promise.all([
    prisma.io.count({ where: whereClause }),
    prisma.io.count({ where: { ...whereClause, result: TestConstants.RESULT_PASSED } }),
    prisma.io.count({ where: { ...whereClause, result: TestConstants.RESULT_FAILED } }),
    prisma.io.count({ where: { ...whereClause, result: null } }),
  ]);

  return { total, passed, failed, untested };
}

/**
 * Get pending sync count
 */
export async function getPendingSyncCount(): Promise<number> {
  return prisma.pendingSync.count();
}

/**
 * Check if database connection is healthy
 */
export async function checkDatabaseHealth(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

/**
 * Disconnect Prisma client (useful for cleanup)
 */
export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}
