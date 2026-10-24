import { PaymentPhase, type PaymentPhaseProps } from './PaymentPhase'
import { SettlementPreview, type SettlementPreviewProps } from './SettlementPreview'

type Props = { phase: 'preview' | 'payment' } & SettlementPreviewProps & PaymentPhaseProps

/** Presentational settlement screen: the preview (choose a method) or the payment tracker. */
export function SettlementPage({ phase, ...props }: Props) {
  return phase === 'preview' ? <SettlementPreview {...props} /> : <PaymentPhase {...props} />
}
