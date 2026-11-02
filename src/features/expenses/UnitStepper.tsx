import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { MinusIcon, PlusIcon } from '../../components/icons'

type Props = {
  /** Accessible name of the whole control, e.g. "Units Ali had for Teh Ais". */
  label: string
  value: number
  /** Highest value allowed now (what is left of the item plus this person's own units). */
  max: number
  /** Offline / read-only: the buttons are disabled. */
  disabled?: boolean
  /** A save is in flight: the buttons keep focus but ignore taps. */
  pending?: boolean
  onChange: (value: number) => void
  /** Shown after the count (this person's share), announced politely. */
  children?: ReactNode
}

/**
 * "− 2 +" for how many units of an item someone had. 48px targets; at the ends the button stays focusable
 * (aria-disabled) so keyboard focus is never lost.
 */
export function UnitStepper({ label, value, max, disabled = false, pending = false, onChange, children }: Props) {
  const { t } = useTranslation()
  const step = (delta: number) => {
    const next = value + delta
    if (pending || next < 0 || next > max) return
    onChange(next)
  }
  return (
    <div className="stepper" role="group" aria-label={label}>
      <button
        type="button"
        className="stepper__button"
        aria-label={t('claim.less')}
        disabled={disabled}
        aria-disabled={pending || value <= 0 || undefined}
        onClick={() => step(-1)}
      >
        <MinusIcon />
      </button>
      <output className="stepper__value">{value}</output>
      <button
        type="button"
        className="stepper__button"
        aria-label={t('claim.more')}
        disabled={disabled}
        aria-disabled={pending || value >= max || undefined}
        onClick={() => step(1)}
      >
        <PlusIcon />
      </button>
      {children !== undefined && (
        <span className="stepper__share amount" aria-live="polite">
          {children}
        </span>
      )}
    </div>
  )
}
