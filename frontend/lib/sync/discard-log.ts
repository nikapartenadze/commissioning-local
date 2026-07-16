import fs from 'fs'
import path from 'path'
import { resolveBackupsDirPath } from '@/lib/storage-paths'
import type { QueueItem } from './queue-inspector'

/**
 * Write a human-readable record of the queue rows a Sync Center discard removed.
 *
 * A discard deletes only the OUTBOUND sync copy — the underlying value stays on
 * the device — but an operator clearing stuck rows still wants a paper trail:
 * "what exactly did I just drop, in case it mattered?". The full-DB .db backup
 * (taken for bulk discards) is the recovery artifact; THIS file is the readable
 * one you can open and eyeball. Written to the same backups/ folder, one .txt
 * per discard, with a plain summary line per row plus a machine-readable JSONL
 * tail. Best-effort: never throws into the caller (a logging hiccup must not
 * block the discard).
 */
export function writeDiscardLog(
  items: QueueItem[],
  meta: { action: string; scope: string },
): { filename: string; path: string; count: number } | null {
  if (!items || items.length === 0) return null
  try {
    const dir = resolveBackupsDirPath()
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const now = new Date()
    const stamp = now.toISOString().replace(/[:.]/g, '-')
    const filename = `sync-discard-${stamp}.txt`
    const full = path.join(dir, filename)

    const header = [
      'Sync Center — discarded queue rows',
      `When:   ${now.toISOString()}`,
      `Action: ${meta.action}`,
      `Scope:  ${meta.scope}`,
      `Count:  ${items.length}`,
      '',
      'IMPORTANT: only the outbound cloud-sync COPY of each row was removed.',
      'The underlying value (IO result / L2 cell / device blocker) is UNCHANGED',
      'and still saved on this device. This file is just a record of what was',
      'cleared from the upload queue, in case it needs review.',
      '',
      '── Rows ──',
    ]
    const summary = items.map(
      (it) =>
        `[${it.mcm ?? 'Unassigned'}] ${it.kind}#${it.id} "${it.title}"` +
        `${it.subtitle ? ' · ' + it.subtitle : ''} = ${it.value ?? '—'} ` +
        `| ${it.status}/${it.classification} | age ${it.ageMinutes ?? '—'}m ` +
        `| err: ${it.lastError ?? '—'}`,
    )
    const jsonl = ['', '── machine-readable (JSONL) ──', ...items.map((it) => JSON.stringify(it))]

    fs.writeFileSync(full, [...header, ...summary, ...jsonl].join('\n'), 'utf8')
    return { filename, path: full, count: items.length }
  } catch (err) {
    console.warn('[SyncCenter] failed to write discard log (proceeding):', err instanceof Error ? err.message : err)
    return null
  }
}
