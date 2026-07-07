/**
 * Live task claims — multi-user coordination for Guided Mode on one MCM.
 *
 * Without claims, the pool is deterministic: two testers entering guided mode
 * on the same subsystem are handed the SAME next task and walk to the same
 * device. A claim marks "client X is working task T right now" so that:
 *
 *   - other clients' pools skip T when picking nextTaskId (and show who has it)
 *   - other clients' swap detectors ignore T's device/IOs — a colleague
 *     actuating THEIR device must not fire a false wrong-wiring banner
 *
 * Claims are ephemeral server-side state (in-memory, TTL'd) — NOT results.
 * They coordinate browsers that talk to the SAME server (central/multi-MCM
 * server, or several tabs on one tablet). Separate tablets running their own
 * servers can't see each other's claims; there the banner stays dismissible
 * best-effort. A dead tablet's claim simply expires after CLAIM_TTL_MS.
 *
 * One claim per client per subsystem: claiming a new task implicitly releases
 * the previous one (the operator can only be at one device at a time).
 */

import type { ActiveClaimInfo, Task, TaskPool } from './types'
import { pickNextTask } from './priority'

export const CLAIM_TTL_MS = 45_000

export interface TaskClaim {
  taskId: string
  clientId: string
  user?: string | null
  deviceName?: string | null
  watchIoIds?: number[]
  expiresAt: number
}

/** subsystemId → clientId → claim (one live claim per client). */
const store = new Map<number, Map<string, TaskClaim>>()

function bucket(subsystemId: number): Map<string, TaskClaim> {
  let b = store.get(subsystemId)
  if (!b) {
    b = new Map()
    store.set(subsystemId, b)
  }
  return b
}

function prune(b: Map<string, TaskClaim>, now: number): void {
  for (const [cid, c] of b) if (c.expiresAt <= now) b.delete(cid)
}

export interface ClaimResult {
  ok: boolean
  /** Display label of the live holder when the task is already claimed. */
  heldBy?: string
}

export function claimLabel(c: TaskClaim): string {
  return c.user?.trim() || `Tester ${c.clientId.slice(0, 4).toUpperCase()}`
}

/**
 * Claim (or heartbeat-renew) a task for a client. Fails only when a DIFFERENT
 * live client already holds that task. Claiming a new task releases the
 * client's previous claim.
 */
export function claimTask(
  subsystemId: number,
  claim: Omit<TaskClaim, 'expiresAt'>,
  now: number = Date.now(),
): ClaimResult {
  const b = bucket(subsystemId)
  prune(b, now)
  for (const [cid, c] of b) {
    if (cid !== claim.clientId && c.taskId === claim.taskId) {
      return { ok: false, heldBy: claimLabel(c) }
    }
  }
  // Renew preserves fields a sparse heartbeat omitted (user, device, ids).
  const prev = b.get(claim.clientId)
  const merged = prev && prev.taskId === claim.taskId ? { ...prev, ...stripUndefined(claim) } : claim
  b.set(claim.clientId, { ...merged, expiresAt: now + CLAIM_TTL_MS })
  return { ok: true }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null)) as Partial<T>
}

export function releaseClaim(subsystemId: number, clientId: string): void {
  store.get(subsystemId)?.delete(clientId)
}

/** Live claims for a subsystem, pruned of expired entries. */
export function getActiveClaims(subsystemId: number, now: number = Date.now()): TaskClaim[] {
  const b = store.get(subsystemId)
  if (!b) return []
  prune(b, now)
  return [...b.values()]
}

/** Test hook — wipe all claims. */
export function _resetClaims(): void {
  store.clear()
}

/**
 * Pure: stamp other clients' claims onto a freshly built pool and re-pick
 * nextTaskId so it never points at a task someone else is working.
 * The caller's own claim is invisible to them (their task stays selectable).
 */
export function applyClaims(pool: TaskPool, claims: TaskClaim[], clientId?: string | null): TaskPool {
  const others = claims.filter((c) => c.clientId !== clientId)
  if (others.length === 0) return pool
  const byTask = new Map(others.map((c) => [c.taskId, c]))
  const tasks: Task[] = pool.tasks.map((t) => {
    const c = byTask.get(t.id)
    return c ? { ...t, claimedBy: claimLabel(c) } : t
  })
  const nextTaskId = pickNextTask(tasks.filter((t) => !t.claimedBy))?.id ?? null
  const claimInfos: ActiveClaimInfo[] = others.map((c) => ({
    taskId: c.taskId,
    user: claimLabel(c),
    deviceName: c.deviceName ?? null,
    watchIoIds: c.watchIoIds ?? [],
  }))
  return { ...pool, tasks, nextTaskId, claims: claimInfos }
}
