import { useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { ConfirmDialog } from '../../components/ConfirmDialog'
import { CameraIcon } from '../../components/icons'
import { SettlementError } from '../settlement/settlementRepository'
import { paymentDetailsSchema, QR_TYPES, type PaymentDetailsValues } from './paymentDetailsSchema'
import { paymentPrefs } from './paymentPrefs'
import { createPaymentRepository } from './paymentRepository'

type Props = {
  eventId: string
  /** Anonymous user id; the key of the remembered copy on this device. */
  userId: string
  /** True when one of the user's incoming transfers is already marked sent (spec: warn before changing). */
  warnBeforeSave?: boolean
  onSaved?: () => void
}

export function PaymentDetailsForm({ eventId, userId, warnBeforeSave = false, onSaved }: Props) {
  const { t, i18n } = useTranslation()
  const [bankName, setBankName] = useState('')
  const [accountHolderName, setAccountHolderName] = useState('')
  const [accountNumber, setAccountNumber] = useState('')
  const [paymentReference, setPaymentReference] = useState('')
  const [preferredMethod, setPreferredMethod] = useState<'qr' | 'bank'>('qr')
  const [qrFile, setQrFile] = useState<File | null>(null)
  const [rememberedQr, setRememberedQr] = useState<Blob | null>(null)
  const [remember, setRemember] = useState(false)
  const [hasRemembered, setHasRemembered] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [pending, setPending] = useState<PaymentDetailsValues | null>(null)

  useEffect(() => {
    let cancelled = false
    paymentPrefs.load(userId).then(
      saved => {
        if (cancelled || !saved) return
        setBankName(saved.bankName ?? '')
        setAccountHolderName(saved.accountHolderName ?? '')
        setAccountNumber(saved.accountNumber ?? '')
        setPaymentReference(saved.paymentReference ?? '')
        setPreferredMethod(saved.preferredMethod)
        setRememberedQr(saved.qr)
        setRemember(true)
        setHasRemembered(true)
      },
      () => undefined, // IndexedDB unavailable: the form still works without a remembered copy
    )
    return () => {
      cancelled = true
    }
  }, [userId])

  const persist = async (values: PaymentDetailsValues) => {
    setSaving(true)
    setError(null)
    setStatus(null)
    try {
      const { qrFile: file, ...details } = values
      await createPaymentRepository().saveMyPaymentDetails(eventId, details, file instanceof File ? file : undefined)
      if (remember) {
        try {
          await paymentPrefs.save({ userId, ...details, qr: file })
          setHasRemembered(true)
        } catch {
          // The event copy is saved; only the device copy failed.
        }
      }
      setStatus(t('paymentForm.saved'))
      onSaved?.()
    } catch (e) {
      const code = e instanceof SettlementError ? e.code : 'action_failed'
      setError(code === 'action_failed' ? t('paymentForm.saveFailed') : t(`settlementError.${code}`, { defaultValue: t('settlementError.action_failed') }))
    } finally {
      setSaving(false)
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const file = qrFile ?? (rememberedQr ? new File([rememberedQr], 'qr', { type: rememberedQr.type }) : null)
    const parsed = paymentDetailsSchema.safeParse({ qrFile: file, bankName, accountHolderName, accountNumber, paymentReference, preferredMethod })
    if (!parsed.success) {
      setStatus(null)
      const key = `paymentForm.errors.${parsed.error.issues[0].message}`
      setError(t(i18n.exists(key) ? key : 'paymentForm.errors.generic'))
      return
    }
    if (warnBeforeSave) setPending(parsed.data)
    else void persist(parsed.data)
  }

  const forget = async () => {
    try {
      await paymentPrefs.forget(userId)
    } catch {
      return
    }
    setHasRemembered(false)
    setRemember(false)
    setRememberedQr(null)
    setStatus(t('paymentForm.forgotten'))
  }

  const bothGiven = Boolean(qrFile ?? rememberedQr) && Boolean(bankName && accountHolderName && accountNumber)

  return (
    <form onSubmit={submit} className="payment-form" noValidate>
      <h2>{t('paymentForm.title')}</h2>
      <p className="muted">{t('paymentForm.intro')}</p>

      <div className="group">
        <div className="group__actions">
          <label className="file-pick">
            <CameraIcon />
            {t('paymentForm.qr')}
            <input type="file" accept={QR_TYPES.join(',')} onChange={event => setQrFile(event.target.files?.[0] ?? null)} />
          </label>
        </div>
        {qrFile && <p className="group__status">{qrFile.name}</p>}
        {!qrFile && rememberedQr && <p className="group__status">{t('paymentForm.qrKept')}</p>}
        <label className="field">
          <span className="field__label">{t('paymentForm.bankName')}</span>
          <input value={bankName} onChange={event => setBankName(event.target.value)} autoComplete="off" />
        </label>
        <label className="field">
          <span className="field__label">{t('paymentForm.accountHolder')}</span>
          <input value={accountHolderName} onChange={event => setAccountHolderName(event.target.value)} autoComplete="off" />
        </label>
        <label className="field">
          <span className="field__label">{t('paymentForm.accountNumber')}</span>
          <input value={accountNumber} onChange={event => setAccountNumber(event.target.value)} inputMode="numeric" autoComplete="off" />
        </label>
        <label className="field">
          <span className="field__label">{t('paymentForm.reference')}</span>
          <input value={paymentReference} maxLength={100} onChange={event => setPaymentReference(event.target.value)} autoComplete="off" />
        </label>
      </div>

      {bothGiven && (
        <fieldset className="group">
          <legend className="group__legend">{t('paymentForm.preferred')}</legend>
          <label className="field field--check">
            <input type="radio" name="preferred" checked={preferredMethod === 'qr'} onChange={() => setPreferredMethod('qr')} /> {t('paymentForm.preferredQr')}
          </label>
          <label className="field field--check">
            <input type="radio" name="preferred" checked={preferredMethod === 'bank'} onChange={() => setPreferredMethod('bank')} /> {t('paymentForm.preferredBank')}
          </label>
        </fieldset>
      )}

      <div className="group">
        <label className="field field--check">
          <input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)} /> {t('paymentForm.remember')}
        </label>
      </div>
      <p className="muted">{t('paymentForm.rememberWarning')}</p>
      {hasRemembered && <button type="button" className="danger quiet" onClick={() => void forget()}>{t('paymentForm.forget')}</button>}

      <div aria-live="assertive">{error && <p role="alert" className="form-error">{error}</p>}</div>
      <div aria-live="polite">{status && <p>{status}</p>}</div>

      <button type="submit" className="primary" disabled={saving}>{saving ? t('paymentForm.saving') : t('paymentForm.save')}</button>

      {pending && (
        <ConfirmDialog
          title={t('paymentForm.changeWarningTitle')}
          confirmLabel={t('paymentForm.changeConfirm')}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const values = pending
            setPending(null)
            void persist(values)
          }}
        >
          <p>{t('paymentForm.changeWarning')}</p>
        </ConfirmDialog>
      )}
    </form>
  )
}
