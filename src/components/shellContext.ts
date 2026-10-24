import type { RealtimeStatus } from '../features/events/useEventRealtime'

export type ShellContext = {
  setEventName: (name: string) => void
  /** Changes whenever the open event changed (realtime) or a page asked for a refresh. */
  refreshKey: number
  refresh: () => void
  realtimeStatus: RealtimeStatus
}
