import { prisma, User } from '../index';

// Note: bcrypt is typically a Node.js-only package
// For Next.js, you may need to use bcryptjs or handle this in API routes only
let bcrypt: typeof import('bcryptjs') | null = null;

// Dynamic import for bcrypt (server-side only)
async function getBcrypt() {
  if (!bcrypt) {
    try {
      bcrypt = await import('bcryptjs');
    } catch {
      // Fallback - bcrypt operations will fail gracefully
      console.warn('bcryptjs not available - PIN validation will not work');
    }
  }
  return bcrypt;
}

const BCRYPT_WORK_FACTOR = 11;

export interface CreateUserParams {
  fullName: string;
  pin: string;
  isAdmin?: boolean;
}

export interface UpdateUserParams {
  fullName?: string;
  pin?: string;
  isAdmin?: boolean;
  isActive?: boolean;
}

export interface AuthResult {
  success: boolean;
  user?: User;
  error?: string;
}

/**
 * Repository for User authentication and management
 */
export const userRepository = {
  /**
   * Authenticate user by PIN
   */
  async authenticateByPin(pin: string): Promise<AuthResult> {
    const bcryptLib = await getBcrypt();
    if (!bcryptLib) {
      return { success: false, error: 'Authentication not available' };
    }

    // Get all active users and check PIN against each
    const users = await prisma.user.findMany({
      where: { isActive: true },
    });

    for (const user of users) {
      const isMatch = await bcryptLib.compare(pin, user.pin);
      if (isMatch) {
        // Update last used timestamp
        await prisma.user.update({
          where: { id: user.id },
          data: { lastUsedAt: new Date().toISOString() },
        });

        return { success: true, user };
      }
    }

    return { success: false, error: 'Invalid PIN' };
  },

  /**
   * Authenticate user by full name and PIN
   */
  async authenticate(fullName: string, pin: string): Promise<AuthResult> {
    const bcryptLib = await getBcrypt();
    if (!bcryptLib) {
      return { success: false, error: 'Authentication not available' };
    }

    const user = await prisma.user.findUnique({
      where: { fullName },
    });

    if (!user) {
      return { success: false, error: 'User not found' };
    }

    if (!user.isActive) {
      return { success: false, error: 'User is inactive' };
    }

    const isMatch = await bcryptLib.compare(pin, user.pin);
    if (!isMatch) {
      return { success: false, error: 'Invalid PIN' };
    }

    // Update last used timestamp
    await prisma.user.update({
      where: { id: user.id },
      data: { lastUsedAt: new Date().toISOString() },
    });

    return { success: true, user };
  },

  /**
   * Create a new user
   */
  async create(params: CreateUserParams): Promise<User> {
    const bcryptLib = await getBcrypt();
    if (!bcryptLib) {
      throw new Error('Cannot create user - bcrypt not available');
    }

    const hashedPin = await bcryptLib.hash(params.pin, BCRYPT_WORK_FACTOR);

    return prisma.user.create({
      data: {
        fullName: params.fullName,
        pin: hashedPin,
        isAdmin: params.isAdmin ?? false,
        isActive: true,
        createdAt: new Date().toISOString(),
      },
    });
  },

  /**
   * Get user by ID
   */
  async getById(id: number): Promise<User | null> {
    return prisma.user.findUnique({ where: { id } });
  },

  /**
   * Get user by full name
   */
  async getByFullName(fullName: string): Promise<User | null> {
    return prisma.user.findUnique({ where: { fullName } });
  },

  /**
   * Get all users
   */
  async getAll(includeInactive = false): Promise<User[]> {
    const where = includeInactive ? {} : { isActive: true };
    return prisma.user.findMany({
      where,
      orderBy: { fullName: 'asc' },
    });
  },

  /**
   * Get all admin users
   */
  async getAdmins(): Promise<User[]> {
    return prisma.user.findMany({
      where: { isAdmin: true, isActive: true },
      orderBy: { fullName: 'asc' },
    });
  },

  /**
   * Update user
   */
  async update(id: number, params: UpdateUserParams): Promise<User> {
    const data: Parameters<typeof prisma.user.update>[0]['data'] = {};

    if (params.fullName !== undefined) {
      data.fullName = params.fullName;
    }

    if (params.pin !== undefined) {
      const bcryptLib = await getBcrypt();
      if (!bcryptLib) {
        throw new Error('Cannot update PIN - bcrypt not available');
      }
      data.pin = await bcryptLib.hash(params.pin, BCRYPT_WORK_FACTOR);
    }

    if (params.isAdmin !== undefined) {
      data.isAdmin = params.isAdmin;
    }

    if (params.isActive !== undefined) {
      data.isActive = params.isActive;
    }

    return prisma.user.update({
      where: { id },
      data,
    });
  },

  /**
   * Update user's PIN
   */
  async updatePin(id: number, newPin: string): Promise<User> {
    return this.update(id, { pin: newPin });
  },

  /**
   * Deactivate user (soft delete)
   */
  async deactivate(id: number): Promise<User> {
    return prisma.user.update({
      where: { id },
      data: { isActive: false },
    });
  },

  /**
   * Reactivate user
   */
  async reactivate(id: number): Promise<User> {
    return prisma.user.update({
      where: { id },
      data: { isActive: true },
    });
  },

  /**
   * Delete user permanently
   */
  async delete(id: number): Promise<void> {
    await prisma.user.delete({ where: { id } });
  },

  /**
   * Check if user exists by full name
   */
  async exists(fullName: string): Promise<boolean> {
    const count = await prisma.user.count({ where: { fullName } });
    return count > 0;
  },

  /**
   * Get user count
   */
  async count(activeOnly = true): Promise<number> {
    const where = activeOnly ? { isActive: true } : {};
    return prisma.user.count({ where });
  },

  /**
   * Validate PIN format (6 digits)
   */
  validatePinFormat(pin: string): boolean {
    return /^\d{6}$/.test(pin);
  },

  /**
   * Create default admin user if no users exist
   */
  async ensureDefaultAdmin(): Promise<void> {
    const count = await prisma.user.count();
    if (count === 0) {
      await this.create({
        fullName: 'Admin',
        pin: '852963',
        isAdmin: true,
      });
    }
  },
};

export default userRepository;
