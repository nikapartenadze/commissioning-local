import type { RoadmapStep } from '@/lib/guided/roadmap-types'

interface Props {
  step: RoadmapStep | null
  currentIndex: number
  totalSteps: number
  isComplete: boolean
  passedCount: number
  failedCount: number
  skippedCount: number
  onPass: () => void
  onFail: () => void
  onSkip: () => void
  onEnd: () => void
}

export function RoadmapPlaybackBanner({ step, currentIndex, totalSteps, isComplete, passedCount, failedCount, skippedCount, onPass, onFail, onSkip, onEnd }: Props) {
  if (isComplete) {
    return (
      <div className="gm-roadmap-banner gm-roadmap-banner--complete">
        <div className="gm-roadmap-banner__title">Roadmap complete</div>
        <div className="gm-roadmap-banner__body">
          <strong>{passedCount}</strong> passed · <strong>{failedCount}</strong> failed · <strong>{skippedCount}</strong> skipped
        </div>
        <button className="gm-roadmap-banner__btn" onClick={onEnd}>Close</button>
      </div>
    )
  }
  if (!step) return null
  return (
    <div className="gm-roadmap-banner">
      <div className="gm-roadmap-banner__step">STEP {currentIndex + 1} OF {totalSteps}</div>
      <div className="gm-roadmap-banner__instr">▸ {step.instructionText}</div>
      {step.kind === 'io' && step.ioName && (
        <div className="gm-roadmap-banner__io">Targeting IO: <code>{step.ioName}</code></div>
      )}
      {step.transitText && (
        <div className="gm-roadmap-banner__transit">{step.transitText}</div>
      )}
      <div className="gm-roadmap-banner__buttons">
        <button className="gm-roadmap-banner__btn gm-roadmap-banner__btn--pass" onClick={onPass}>Pass</button>
        <button className="gm-roadmap-banner__btn gm-roadmap-banner__btn--fail" onClick={onFail}>Fail</button>
        <button className="gm-roadmap-banner__btn" onClick={onSkip}>Skip</button>
        <button className="gm-roadmap-banner__btn gm-roadmap-banner__btn--end" onClick={onEnd}>End</button>
      </div>
    </div>
  )
}
