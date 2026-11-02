import { useTranslation } from 'react-i18next'
import { progressPercent, type OcrProgress } from './ocrProgress'

/**
 * One bar for the whole scan, with the stage as text. Only the stage name is announced (aria-live); the byte
 * count and the bar's value are there to look at or query, not read out on every change.
 */
export function ScanProgress({ progress }: { progress: OcrProgress }) {
  const { t, i18n } = useTranslation()
  const percent = progressPercent(progress)
  const stage = t(`editor.scan.stage.${progress.stage}`)
  const mb = (bytes: number) =>
    new Intl.NumberFormat(i18n.language, { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(bytes / 1_000_000)
  const detail =
    progress.stage !== 'loading'
      ? ''
      : progress.totalBytes > 0 && progress.loadedBytes <= progress.totalBytes
        ? t('editor.scan.megabytes', { loaded: mb(progress.loadedBytes), total: mb(progress.totalBytes) })
        : t('editor.scan.firstTime')
  return (
    <div className="scan-progress">
      <p className="scan-progress__text">
        <span aria-live="polite">{stage}</span>
        {detail && <span className="scan-progress__detail">{detail}</span>}
      </p>
      <div
        className="scan-progress__track"
        role="progressbar"
        aria-label={t('editor.scan.progressLabel')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${percent}% ${stage}`}
      >
        <div
          className={progress.stage === 'reading' ? 'scan-progress__fill scan-progress__fill--working' : 'scan-progress__fill'}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  )
}
