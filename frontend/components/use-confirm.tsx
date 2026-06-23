import { useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * In-app replacement for window.confirm() — a themed modal that returns a
 * Promise<boolean>. Usage:
 *   const { confirm, confirmModal } = useConfirm()
 *   if (!(await confirm({ title, message, danger: true }))) return
 *   ...
 *   return (<>{confirmModal}{rest of UI}</>)
 */
export interface ConfirmOpts {
  title?: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}

export function useConfirm() {
  const [state, setState] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null)

  const confirm = useCallback(
    (opts: ConfirmOpts) => new Promise<boolean>((resolve) => setState({ ...opts, resolve })),
    [],
  )

  const close = (v: boolean) => { state?.resolve(v); setState(null) }

  const confirmModal = state
    ? createPortal(
        <div
          className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 pointer-events-auto"
          onClick={() => close(false)}
          onKeyDown={(e) => { if (e.key === 'Escape') close(false) }}
        >
          <div
            className="w-full max-w-md rounded-lg border border-border bg-card p-5 shadow-xl shadow-black/40"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3">
              <div className={cn('grid place-items-center h-9 w-9 rounded-full shrink-0', state.danger ? 'bg-warning/15 text-warning' : 'bg-primary/15 text-primary')}>
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                {state.title && <h3 className="font-bold text-foreground">{state.title}</h3>}
                <p className="text-sm text-muted-foreground whitespace-pre-line mt-0.5">{state.message}</p>
              </div>
            </div>
            <div className="flex justify-end gap-2 mt-5">
              <button
                onClick={() => close(false)}
                className="rounded-md border border-input px-4 py-2 text-sm font-medium text-foreground hover:bg-muted transition-colors"
              >
                {state.cancelLabel || 'Cancel'}
              </button>
              <button
                onClick={() => close(true)}
                autoFocus
                className={cn('rounded-md px-4 py-2 text-sm font-semibold transition-colors', state.danger ? 'bg-warning text-warning-foreground hover:bg-warning/90' : 'bg-primary text-primary-foreground hover:bg-primary/90')}
              >
                {state.confirmLabel || 'Confirm'}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )
    : null

  return { confirm, confirmModal }
}
