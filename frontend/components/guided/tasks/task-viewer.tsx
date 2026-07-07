import { useMemo } from 'react'
import type { Segment, Task, TaskPool, TaskState } from '@/lib/guided/task-pool/types'

/**
 * Task Viewer — the "screen that displays all tasks for the entire project,
 * able to view which tasks have been completed, pending, skipped, failed, etc."
 * (Guided Mode spec). Grouped by Segment, in commissioning-flow order.
 */

const SEGMENT_ORDER: Segment[] = [
  'Firmware Compliance',
  'Network Verification',
  'VFD Commissioning',
  'Safety Device I/O Check',
  'Safety Verification',
  'Non-Safety Device I/O Check',
  'Functional Validation',
]

const STATE_LABEL: Record<TaskState, string> = {
  available: 'Pending',
  in_progress: 'In Progress',
  completed: 'Completed',
  blocked: 'Blocked',
  skipped: 'Skipped',
}

export function TaskViewer({
  pool,
  onPick,
  onClose,
  onUnskip,
}: {
  pool: TaskPool
  onPick: (task: Task) => void
  onClose: () => void
  onUnskip?: (task: Task) => void
}) {
  const grouped = useMemo(() => {
    const map = new Map<Segment, Task[]>()
    for (const seg of SEGMENT_ORDER) map.set(seg, [])
    for (const t of pool.tasks) {
      if (!map.has(t.segment)) map.set(t.segment, [])
      map.get(t.segment)!.push(t)
    }
    return map
  }, [pool])

  const s = pool.summary

  return (
    <div className="gt-viewer-overlay" role="dialog" aria-label="Task Viewer">
      <div className="gt-viewer">
        <div className="gt-viewer-head">
          <h2>Task Viewer</h2>
          <button className="gt-btn gt-btn-ghost" onClick={onClose} aria-label="Close task viewer">
            ✕
          </button>
        </div>

        <div className="gt-viewer-summary">
          <Stat label="Total" value={s.total} />
          <Stat label="Completed" value={s.completed} tone="completed" />
          <Stat label="In Progress" value={s.inProgress} tone="in_progress" />
          <Stat label="Pending" value={s.available} tone="available" />
          <Stat label="Blocked" value={s.blocked} tone="blocked" />
          <Stat label="Skipped" value={s.skipped} tone="skipped" />
        </div>

        <div className="gt-viewer-body">
          {/* Known segments in flow order, then any segment the engine emitted
              that this list doesn't know yet — never silently hide tasks. */}
          {[...SEGMENT_ORDER, ...[...grouped.keys()].filter((s) => !SEGMENT_ORDER.includes(s))]
            .filter((seg) => (grouped.get(seg)?.length ?? 0) > 0)
            .map((seg) => {
            const tasks = grouped.get(seg)!
            return (
              <section key={seg} className="gt-viewer-segment">
                <h3>{seg}</h3>
                <ul>
                  {tasks.map((t) => (
                    <li key={t.id} className={`gt-viewer-row gt-state-${t.state}`}>
                      <span className={`gt-badge gt-badge-${t.state}`}>{STATE_LABEL[t.state]}</span>
                      <span className="gt-viewer-title">{t.title}</span>
                      {t.progress > 0 && t.state !== 'completed' && (
                        <span className="gt-viewer-progress">{Math.round(t.progress * 100)}%</span>
                      )}
                      {t.claimedBy && (
                        <span className="gt-viewer-reason" title={`Currently being tested by ${t.claimedBy}`}>
                          👤 {t.claimedBy}
                        </span>
                      )}
                      {t.state === 'skipped' && t.skipReason && (
                        <span className="gt-viewer-reason" title={t.skipReason}>
                          “{t.skipReason}”
                        </span>
                      )}
                      {t.state === 'blocked' && t.unmetDependencies.length > 0 && (
                        <span className="gt-viewer-reason" title={t.unmetDependencies.join('; ')}>
                          {t.unmetDependencies[0]}
                          {t.unmetDependencies.length > 1 ? ` (+${t.unmetDependencies.length - 1})` : ''}
                        </span>
                      )}
                      <span className="gt-viewer-actions">
                        {(t.state === 'available' || t.state === 'in_progress') && !t.claimedBy && (
                          <button className="gt-btn gt-btn-sm" onClick={() => onPick(t)}>
                            Go
                          </button>
                        )}
                        {t.state === 'skipped' && onUnskip && (
                          <button className="gt-btn gt-btn-sm gt-btn-ghost" onClick={() => onUnskip(t)}>
                            Un-skip
                          </button>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: TaskState }) {
  return (
    <div className={`gt-stat${tone ? ` gt-stat-${tone}` : ''}`}>
      <div className="gt-stat-value">{value}</div>
      <div className="gt-stat-label">{label}</div>
    </div>
  )
}
