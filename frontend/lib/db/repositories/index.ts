// Export all repositories for convenient imports
export { ioRepository } from './io-repository';
export { testHistoryRepository } from './test-history-repository';
export { userRepository } from './user-repository';
export { pendingSyncRepository } from './pending-sync-repository';
export { tagTypeDiagnosticRepository } from './tag-type-diagnostic-repository';

// Re-export types
export type { UpdateResultParams, CreateIoParams, IoFilters } from './io-repository';
export type { CreateTestHistoryParams, TestHistoryFilters } from './test-history-repository';
export type { CreateUserParams, UpdateUserParams, AuthResult } from './user-repository';
export type { CreatePendingSyncParams } from './pending-sync-repository';
export type { CreateDiagnosticParams, UpdateDiagnosticParams } from './tag-type-diagnostic-repository';
