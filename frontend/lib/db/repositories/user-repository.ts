import { db } from '@/lib/db-sqlite'
import type { User } from '@/lib/db-sqlite'

// Note: bcrypt is typically a Node.js-only package
// For Next.js, you may need to use bcryptjs or handle this in API routes only
let bcrypt: typeof import('bcryptjs') | null = null

// Dynamic import for bcrypt (server-side only)
async function getBcrypt() {
  if (!bcrypt) {
    try {
      bcrypt = await import('bcryptjs')
    } catch {
      // Fallback - bcrypt operations will fail gracefully
      console.warn('bcryptjs not available - PIN validation will not work')
    }
  }
  return bcrypt
}

const BCRYPT_WORK_FACTOR = 11

export interface CreateUserParams {
  fullName: string
  pin: string
  isAdmin?: boolean
}

export interface UpdateUserParams {
  fullName?: string
  pin?: string
  isAdmin?: boolean
  isActive?: boolean
}

export interface AuthResult {
  success: boolean
  user?: User
  error?: string
}

/**
 * Repository for User authentication and management (better-sqlite3)
 */
export const userRepository = {
  /**
   * Authenticate user by PIN
   */
  async authenticateByPin(pin: string): Promise<AuthResult> {
    const bcryptLib = await getBcrypt()
    if (!bcryptLib) {
      return { success: false, error: 'Authentication not available' }
    }

    // Get all active users and check PIN against each
    const users = db.prepare('SELECT * FROM Users WHERE IsActive = 1').all() as User[]

    for (const user of users) {
      const isMatch = await bcryptLib.compare(pin, user.Pin)
      if (isMatch) {
        // Update last used timestamp
        db.prepare('UPDATE Users SET LastUsedAt = ? WHERE id = ?').run(new Date().toISOString(), user.id)
        return { success: true, user }
      }
    }

    return { success: false, error: 'Invalid PIN' }
  },

  /**
   * Authenticate user by full name and PIN
   */
  async authenticate(fullName: string, pin: string): Promise<AuthResult> {
    const bcryptLib = await getBcrypt()
    if (!bcryptLib) {
      return { success: false, error: 'Authentication not available' }
    }

    const user = db.prepare('SELECT * FROM Users WHERE FullName = ?').get(fullName) as User | undefined

    if (!user) {
      return { success: false, error: 'User not found' }
    }

    if (!user.IsActive) {
      return { success: false, error: 'User is inactive' }
    }

    const isMatch = await bcryptLib.compare(pin, user.Pin)
    if (!isMatch) {
      return { success: false, error: 'Invalid PIN' }
    }

    // Update last used timestamp
    db.prepare('UPDATE Users SET LastUsedAt = ? WHERE id = ?').run(new Date().toISOString(), user.id)

    return { success: true, user }
  },

  /**
   * Create a new user
   */
  async create(params: CreateUserParams): Promise<User> {
    const bcryptLib = await getBcrypt()
    if (!bcryptLib) {
      throw new Error('Cannot create user - bcrypt not available')
    }

    const hashedPin = await bcryptLib.hash(params.pin, BCRYPT_WORK_FACTOR)

    const result = db.prepare(
      'INSERT INTO Users (FullName, Pin, IsAdmin, IsActive, CreatedAt) VALUES (?, ?, ?, 1, ?)'
    ).run(
      params.fullName,
      hashedPin,
      params.isAdmin ? 1 : 0,
      new Date().toISOString(),
    )

    return db.prepare('SELECT * FROM Users WHERE id = ?').get(result.lastInsertRowid) as User
  },

  /**
   * Get user by ID
   */
  getById(id: number): User | null {
    return (db.prepare('SELECT * FROM Users WHERE id = ?').get(id) as User | undefined) ?? null
  },

  /**
   * Get user by full name
   */
  getByFullName(fullName: string): User | null {
    return (db.prepare('SELECT * FROM Users WHERE FullName = ?').get(fullName) as User | undefined) ?? null
  },

  /**
   * Get all users
   */
  getAll(includeInactive = false): User[] {
    if (includeInactive) {
      return db.prepare('SELECT * FROM Users ORDER BY FullName ASC').all() as User[]
    }
    return db.prepare('SELECT * FROM Users WHERE IsActive = 1 ORDER BY FullName ASC').all() as User[]
  },

  /**
   * Get all admin users
   */
  getAdmins(): User[] {
    return db.prepare('SELECT * FROM Users WHERE IsAdmin = 1 AND IsActive = 1 ORDER BY FullName ASC').all() as User[]
  },

  /**
   * Update user
   */
  async update(id: number, params: UpdateUserParams): Promise<User> {
    const setClauses: string[] = []
    const values: any[] = []

    if (params.fullName !== undefined) {
      setClauses.push('FullName = ?')
      values.push(params.fullName)
    }

    if (params.pin !== undefined) {
      const bcryptLib = await getBcrypt()
      if (!bcryptLib) {
        throw new Error('Cannot update PIN - bcrypt not available')
      }
      setClauses.push('Pin = ?')
      values.push(await bcryptLib.hash(params.pin, BCRYPT_WORK_FACTOR))
    }

    if (params.isAdmin !== undefined) {
      setClauses.push('IsAdmin = ?')
      values.push(params.isAdmin ? 1 : 0)
    }

    if (params.isActive !== undefined) {
      setClauses.push('IsActive = ?')
      values.push(params.isActive ? 1 : 0)
    }

    if (setClauses.length > 0) {
      values.push(id)
      db.prepare(`UPDATE Users SET ${setClauses.join(', ')} WHERE id = ?`).run(...values)
    }

    return db.prepare('SELECT * FROM Users WHERE id = ?').get(id) as User
  },

  /**
   * Update user's PIN
   */
  async updatePin(id: number, newPin: string): Promise<User> {
    return this.update(id, { pin: newPin })
  },

  /**
   * Deactivate user (soft delete)
   */
  deactivate(id: number): User {
    db.prepare('UPDATE Users SET IsActive = 0 WHERE id = ?').run(id)
    return db.prepare('SELECT * FROM Users WHERE id = ?').get(id) as User
  },

  /**
   * Reactivate user
   */
  reactivate(id: number): User {
    db.prepare('UPDATE Users SET IsActive = 1 WHERE id = ?').run(id)
    return db.prepare('SELECT * FROM Users WHERE id = ?').get(id) as User
  },

  /**
   * Delete user permanently
   */
  delete(id: number): void {
    db.prepare('DELETE FROM Users WHERE id = ?').run(id)
  },

  /**
   * Check if user exists by full name
   */
  exists(fullName: string): boolean {
    return (db.prepare('SELECT COUNT(*) as count FROM Users WHERE FullName = ?').get(fullName) as any).count > 0
  },

  /**
   * Get user count
   */
  count(activeOnly = true): number {
    if (activeOnly) {
      return (db.prepare('SELECT COUNT(*) as count FROM Users WHERE IsActive = 1').get() as any).count
    }
    return (db.prepare('SELECT COUNT(*) as count FROM Users').get() as any).count
  },

  /**
   * Validate PIN format (6 digits)
   */
  validatePinFormat(pin: string): boolean {
    return /^\d{6}$/.test(pin)
  },

  /**
   * Clear the must-change-PIN flag for a user (called after they set a new PIN).
   */
  clearMustChangePin(id: number): void {
    try {
      db.prepare('UPDATE Users SET MustChangePin = 0 WHERE id = ?').run(id)
    } catch {
      // Column may not exist on a very old DB that hasn't migrated yet — ignore.
    }
  },

  /**
   * Create default admin user if no users exist.
   *
   * The seeded admin is flagged MustChangePin=1 so the UI forces a new PIN on
   * first admin login under enforced auth. The flag write is best-effort: a DB
   * that predates the column migration simply keeps the column absent (treated
   * as 0), which is backward-safe.
   */
  async ensureDefaultAdmin(): Promise<void> {
    const count = (db.prepare('SELECT COUNT(*) as count FROM Users').get() as any).count
    if (count === 0) {
      const user = await this.create({
        fullName: 'Admin',
        pin: '111111',
        isAdmin: true,
      })
      try {
        db.prepare('UPDATE Users SET MustChangePin = 1 WHERE id = ?').run(user.id)
      } catch {
        // Column missing on a not-yet-migrated DB — ignore (defaults to 0).
      }
    }
  },
}

export default userRepository
