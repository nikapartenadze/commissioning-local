import { useEffect, useRef, useState } from 'react'
import { HardHat } from 'lucide-react'
import { Button } from '@/components/ui/button'

interface Props {
  /** Called once the mechanic submits a non-empty name. The parent
   *  is responsible for persisting it. */
  onSubmit: (name: string) => void
}

/**
 * One-time modal shown the first time a mechanic visits the page.
 * Captures their name to stamp on Belt Tracked writes (`updatedBy`).
 * Uses shadcn theme tokens so it follows the global theme.
 */
export function MechanicNamePrompt({ onSubmit }: Props) {
  const [name, setName] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (trimmed.length === 0) return
    onSubmit(trimmed.slice(0, 40))
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-background/80 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bt-prompt-title"
    >
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-sm rounded-lg border bg-card text-card-foreground shadow-xl p-6 flex flex-col items-center gap-3"
      >
        <div className="w-14 h-14 rounded-md bg-primary text-primary-foreground flex items-center justify-center mb-1">
          <HardHat size={26} />
        </div>
        <h1 id="bt-prompt-title" className="text-xl font-bold tracking-tight">
          Belt Tracking
        </h1>
        <p className="text-sm text-muted-foreground text-center leading-relaxed">
          Let your team know who marked which belts. Type your name once —
          we'll remember it on this device.
        </p>
        <input
          ref={inputRef}
          className="w-full h-11 px-3 mt-2 text-base text-center rounded-md border bg-background focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary"
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="Your name"
          maxLength={40}
          autoComplete="off"
          spellCheck={false}
        />
        <Button
          type="submit"
          className="w-full h-11 mt-1 text-sm font-semibold"
          disabled={name.trim().length === 0}
        >
          Continue
        </Button>
      </form>
    </div>
  )
}
