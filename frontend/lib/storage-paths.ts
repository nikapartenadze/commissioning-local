import path from 'path'

function stripFilePrefix(dbUrl: string): string {
  return dbUrl.replace(/^file:/, '')
}

export function resolveDatabasePath(): string {
  const configured = process.env.DATABASE_URL || 'file:./database.db'
  const relativeOrAbsolute = stripFilePrefix(configured)
  if (path.isAbsolute(relativeOrAbsolute)) {
    return relativeOrAbsolute
  }
  return path.resolve(process.cwd(), relativeOrAbsolute)
}

export function resolveStorageRootPath(): string {
  return path.dirname(resolveDatabasePath())
}

export function resolveConfigFilePath(): string {
  if (process.env.CONFIG_PATH) {
    return path.resolve(process.env.CONFIG_PATH)
  }
  return path.join(resolveStorageRootPath(), 'config.json')
}

export function resolveBackupsDirPath(): string {
  return path.join(resolveStorageRootPath(), 'backups')
}

export function resolveLogsDirPath(): string {
  return path.join(resolveStorageRootPath(), 'logs')
}

export function resolveUpdateStatePath(): string {
  return path.join(resolveStorageRootPath(), 'update-status.json')
}
