import bcrypt from 'bcryptjs';

const SALT_ROUNDS = 10;

/**
 * Hash a PIN using bcrypt
 */
export async function hashPin(pin: string): Promise<string> {
  return bcrypt.hash(pin, SALT_ROUNDS);
}

/**
 * Verify a PIN against a bcrypt hash
 * Returns true if the PIN matches, false otherwise
 */
export async function verifyPin(pin: string, hashedPin: string): Promise<boolean> {
  try {
    return await bcrypt.compare(pin, hashedPin);
  } catch {
    // If comparison fails for any reason, return false
    return false;
  }
}

/**
 * Synchronous version of hashPin
 * Use async version when possible for better performance
 */
export function hashPinSync(pin: string): string {
  return bcrypt.hashSync(pin, SALT_ROUNDS);
}

/**
 * Synchronous version of verifyPin
 * Use async version when possible for better performance
 */
export function verifyPinSync(pin: string, hashedPin: string): boolean {
  try {
    return bcrypt.compareSync(pin, hashedPin);
  } catch {
    return false;
  }
}
