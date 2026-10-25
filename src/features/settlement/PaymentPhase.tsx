import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { CheckIcon, CloseIcon, PlusIcon } from '../../components/icons'
import { formatMoney } from '../../domain/money'
import type { EventRole } from '../../domain/types'
import type { ReceiverDetails } from '../payments/paymentRepository'
import type { PaymentState } from './settlementRepository'

export type PaymentTransferView = {
  id?: string
  payerId: string
  receiverId: string
  amountCents: number
  state?: PaymentState
}

export type PaymentPhaseProps = {
  transfers: PaymentTransferView[]
  currentUserId?: string
  role?: EventRole
  names?: Record<string, string>
  currency?: string
  busy?: boolean
  errorMessage?: string
  /** Rendered under "Add receiving details" when the receiver opens it. */
  detailsForm?: ReactNode
  /** Resolves null when the receiver has not added details yet. The result is kept in memory only. */
  onShowDetails?: (transferId: string) => Promise<ReceiverDetails | null>
  onMarkSent?: (transferId: string) => void
  onConfirmReceived?: (transferId: string) => void
  /** Resolve false when the action failed, so the typed reason is kept. */
  onOverride?: (transferId: string, reason: string) => void | boolean | Promise<void | boolean>
  /** Transfer ids whose receiver has not added details yet (known without showing details). */
  missingDetailsFor?: string[]
}

const MAX_REASON = 500

export function PaymentPhase({
  transfers,
  currentUserId,
  role,
  names = {},
  currency = 'MYR',
  busy = false,
  errorMessage,
  detailsForm,
  missingDetailsFor = [],
  onShowDetails,
  onMarkSent,
  onConfirmReceived,
  onOverride,
}: PaymentPhaseProps) {
  const { t } = useTranslation()
  const [formOpen, setFormOpen] = useState(false)
  const isReceiver = transfers.some(x => x.receiverId === currentUserId)
  const isManager = role === 'owner' || role === 'cohost'
  const nameOf = (id: string) => names[id] ?? t('settlement.formerMember')

  return (
    <main className="settlement">
      <h1>{t('payments.title')}</h1>
      {!isManager && <p className="muted payments__intro">{t('payments.onlyYours')}</p>}
      <div aria-live="assertive" className="settlement__notice">{errorMessage && <p className="form-error">{errorMessage}</p>}</div>

      {isReceiver && (
        <section>
          <button type="button" className="btn-block details-toggle" aria-expanded={formOpen} onClick={() => setFormOpen(open => !open)}>
            {formOpen ? <CloseIcon /> : <PlusIcon />}
            {t('payments.addDetails')}
          </button>
          {formOpen && detailsForm}
        </section>
      )}

      <div className="receipt">
      <ul className="plain-list transfer-list receipt__paper">
        {transfers.map((transfer, index) => (
          <TransferRow
            key={transfer.id ?? index}
            transfer={transfer}
            me={currentUserId}
            isManager={isManager}
            names={names}
            nameOf={nameOf}
            currency={currency}
            busy={busy}
            missingKnown={transfer.id !== undefined && missingDetailsFor.includes(transfer.id)}
            onShowDetails={onShowDetails}
            onMarkSent={onMarkSent}
            onConfirmReceived={onConfirmReceived}
            onOverride={onOverride}
          />
        ))}
      </ul>
      </div>
    </main>
  )
}

type RowProps = {
  transfer: PaymentTransferView
  me?: string
  isManager: boolean
  names: Record<string, string>
  nameOf: (id: string) => string
  currency: string
  busy: boolean
  missingKnown: boolean
} & Pick<PaymentPhaseProps, 'onShowDetails' | 'onMarkSent' | 'onConfirmReceived' | 'onOverride'>

function TransferRow({ transfer, me, isManager, nameOf, currency, busy, missingKnown, onShowDetails, onMarkSent, onConfirmReceived, onOverride }: RowProps) {
  const { t, i18n } = useTranslation()
  const { id, payerId, receiverId, amountCents } = transfer
  const state = transfer.state ?? 'pending'
  const amount = formatMoney(amountCents, currency, i18n.language)
  const isPayer = me === payerId
  const isReceiver = me === receiverId

  // In-memory only; dropped as soon as the transfer is received.
  const [details, setDetails] = useState<ReceiverDetails | 'missing' | null>(null)
  const [detailsFailed, setDetailsFailed] = useState(false)
  const [overriding, setOverriding] = useState(false)
  const [reason, setReason] = useState('')
  const [reasonError, setReasonError] = useState(false)
  const [warnSent, setWarnSent] = useState(false)
  const missing = details === 'missing' || (missingKnown && details === null)

  const sentence = isPayer
    ? t('payments.youPay', { amount, name: nameOf(receiverId) })
    : isReceiver
      ? t('payments.paysYou', { amount, name: nameOf(payerId) })
      : t('payments.pays', { amount, payer: nameOf(payerId), receiver: nameOf(receiverId) })

  const showDetails = async () => {
    if (!id || !onShowDetails) return
    setDetailsFailed(false)
    try {
      setDetails((await onShowDetails(id)) ?? 'missing')
    } catch {
      setDetailsFailed(true)
    }
  }
  const visibleDetails = state === 'confirmed' ? null : details

  const submitOverride = async () => {
    const trimmed = reason.trim()
    if (trimmed.length < 1 || trimmed.length > MAX_REASON) {
      setReasonError(true)
      return
    }
    setReasonError(false)
    if (!id) return
    // Keep the reason (and the form) until the action succeeds.
    if ((await onOverride?.(id, trimmed)) === false) return
    setOverriding(false)
    setReason('')
  }

  return (
    <li className="transfer">
      <p className="transfer__line">
        <span>{sentence}</span> <span className={`badge badge--${state}`}>{t(`payments.state.${state}`)}</span>
      </p>

      {detailsFailed && <p role="alert" className="form-error">{t('payments.detailsFailed')}</p>}
      {(missing && state !== 'confirmed') && <p className="note">{t('payments.waitingForDetails', { name: nameOf(receiverId) })}</p>}
      {visibleDetails && visibleDetails !== 'missing' && <DetailsView details={visibleDetails} />}

      <div className="transfer__actions">
        {isPayer && state === 'pending' && onMarkSent && id && (
          <button type="button" className="primary" onClick={() => (missing ? setWarnSent(true) : onMarkSent(id))} disabled={busy}><CheckIcon />{t('payments.markSent')}</button>
        )}
        {isReceiver && state === 'sent' && onConfirmReceived && id && (
          <button type="button" className="primary" onClick={() => onConfirmReceived(id)} disabled={busy}><CheckIcon />{t('payments.confirmReceived')}</button>
        )}
        {isPayer && state !== 'confirmed' && onShowDetails && (
          <button type="button" onClick={() => void showDetails()} disabled={busy || !id}>{t('payments.showDetails')}</button>
        )}
        {isManager && state !== 'confirmed' && onOverride && id && !overriding && (
          <button type="button" className="quiet" onClick={() => setOverriding(true)} disabled={busy}>{t('payments.override')}</button>
        )}
      </div>
      {overriding && (
        <div className="override">
          <div className="group">
            <label className="field">
              <span className="field__label">{t('payments.reason')}</span>
              <textarea value={reason} maxLength={MAX_REASON} onChange={event => setReason(event.target.value)} />
            </label>
          </div>
          {reasonError && <p role="alert" className="form-error">{t('payments.reasonRequired')}</p>}
          <div className="transfer__actions">
            <button type="button" className="quiet" onClick={() => setOverriding(false)}>{t('common.back')}</button>
            <button type="button" className="primary" onClick={() => void submitOverride()} disabled={busy}>{t('payments.overrideConfirm')}</button>
          </div>
        </div>
      )}
      {warnSent && id && (
        <ConfirmDialog
          title={t('payments.missingDetailsWarningTitle')}
          confirmLabel={t('payments.markSentAnyway')}
          onCancel={() => setWarnSent(false)}
          onConfirm={() => {
            setWarnSent(false)
            onMarkSent?.(id)
          }}
        >
          <p>{t('payments.missingDetailsWarning', { name: nameOf(receiverId) })}</p>
        </ConfirmDialog>
      )}
    </li>
  )
}

function DetailsView({ details }: { details: ReceiverDetails }) {
  const { t } = useTranslation()
  return (
    <dl className="payment-details">
      {details.qrUrl && <img src={details.qrUrl} alt={t('payments.qrAlt')} className="payment-details__qr" />}
      {details.bankName && (<><dt>{t('payments.bankName')}</dt><dd>{details.bankName}</dd></>)}
      {details.accountHolderName && (<><dt>{t('payments.accountHolder')}</dt><dd>{details.accountHolderName}</dd></>)}
      {details.accountNumber && (<><dt>{t('payments.accountNumber')}</dt><dd>{details.accountNumber}</dd></>)}
      {details.paymentReference && (<><dt>{t('payments.reference')}</dt><dd>{details.paymentReference}</dd></>)}
    </dl>
  )
}
