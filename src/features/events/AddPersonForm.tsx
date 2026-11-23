import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { PlusIcon } from '../../components/icons'

const MAX_NAME = 40

type Props = {
  /** Resolve true once the person is added (the form then clears), false to keep the typed name. */
  onAdd: (name: string) => Promise<boolean>
  disabled?: boolean
  /** Starts as a "+ Add person" button that opens the form (claim page); the People page shows it open. */
  collapsible?: boolean
}

/** Owner/co-host: add someone by name, without inviting them. */
export function AddPersonForm({ onAdd, disabled = false, collapsible = false }: Props) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(!collapsible)
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(false)

  if (!open) {
    return (
      <button type="button" className="chip add-person__open" disabled={disabled} onClick={() => setOpen(true)}>
        <PlusIcon />
        {t('people.addPerson')}
      </button>
    )
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    event.stopPropagation() // the claim page renders this inside other forms' areas
    const trimmed = name.trim()
    if (!trimmed) return setError(true)
    setError(false)
    setSaving(true)
    const ok = await onAdd(trimmed)
    setSaving(false)
    if (!ok) return
    setName('')
    if (collapsible) setOpen(false)
  }

  return (
    <form className="add-person" onSubmit={e => void submit(e)}>
      <label className="field add-person__field">
        <span className="field__label">{t('people.addPersonName')}</span>
        <input
          value={name}
          maxLength={MAX_NAME}
          autoFocus={collapsible}
          onChange={e => setName(e.target.value)}
          aria-invalid={error || undefined}
        />
      </label>
      {error && <p role="alert" className="form-error">{t('people.addPersonNameRequired')}</p>}
      <p className="note">{t('people.addPersonHint')}</p>
      <div className="add-person__actions">
        {collapsible && (
          <button type="button" className="quiet" onClick={() => { setOpen(false); setName(''); setError(false) }}>
            {t('common.cancel')}
          </button>
        )}
        <button type="submit" className="primary" disabled={disabled || saving}>
          {saving ? t('people.addingPerson') : t('people.addPersonSubmit')}
        </button>
      </div>
    </form>
  )
}
