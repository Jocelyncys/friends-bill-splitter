import { lazy } from 'react'
import { useTranslation } from 'react-i18next'

// Route pages are split into their own chunks so the first load only ships the shell and home page.
export const CreateEventPage = lazy(() => import('../features/events/CreateEventPage').then(m => ({ default: m.CreateEventPage })))
export const JoinEventPage = lazy(() => import('../features/events/JoinEventPage').then(m => ({ default: m.JoinEventPage })))
export const EventRoute = lazy(() => import('../features/events/EventRoute').then(m => ({ default: m.EventRoute })))
export const PeoplePage = lazy(() => import('../features/events/PeoplePage').then(m => ({ default: m.PeoplePage })))
export const ExpenseListPage = lazy(() => import('../features/expenses/ExpenseListPage').then(m => ({ default: m.ExpenseListPage })))
export const ExpenseEditorPage = lazy(() => import('../features/expenses/ExpenseEditorPage').then(m => ({ default: m.ExpenseEditorPage })))
export const ClaimItemsRoute = lazy(() => import('../features/expenses/ClaimItemsRoute').then(m => ({ default: m.ClaimItemsRoute })))
export const SettlementRoute = lazy(() => import('../features/settlement/SettlementRoute').then(m => ({ default: m.SettlementRoute })))

export function PageLoading() {
  const { t } = useTranslation()
  return <p role="status">{t('common.loading')}</p>
}
