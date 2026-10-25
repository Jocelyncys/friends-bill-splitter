import { Suspense, type ReactNode } from 'react'
import { createHashRouter } from 'react-router-dom'
import { AppShell } from '../components/AppShell'
import { HomePage } from './HomePage'
import {
  ClaimItemsRoute,
  CreateEventPage,
  EventRoute,
  ExpenseEditorPage,
  ExpenseListPage,
  JoinEventPage,
  PageLoading,
  PeoplePage,
  SettlementRoute,
} from './lazyPages'

const suspend = (element: ReactNode) => <Suspense fallback={<PageLoading />}>{element}</Suspense>

export const router = createHashRouter([
  {
    element: <AppShell />,
    children: [
      { path: '/', element: <HomePage /> },
      { path: '/new/:mode', element: suspend(<CreateEventPage />) },
      { path: '/join/:token', element: suspend(<JoinEventPage />) },
      { path: '/event/:eventId', element: suspend(<EventRoute />) },
      { path: '/event/:eventId/expenses', element: suspend(<ExpenseListPage />) },
      { path: '/event/:eventId/expenses/new', element: suspend(<ExpenseEditorPage />) },
      { path: '/event/:eventId/expenses/:expenseId/edit', element: suspend(<ExpenseEditorPage />) },
      { path: '/event/:eventId/expenses/:expenseId/claim', element: suspend(<ClaimItemsRoute />) },
      { path: '/event/:eventId/people', element: suspend(<PeoplePage />) },
      { path: '/event/:eventId/settle', element: suspend(<SettlementRoute phase="preview" />) },
      { path: '/event/:eventId/payments', element: suspend(<SettlementRoute phase="payment" />) },
    ],
  },
])
