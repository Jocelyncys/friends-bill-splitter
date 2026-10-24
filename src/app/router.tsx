import { createHashRouter } from 'react-router-dom'
import { AppShell } from '../components/AppShell'
import { CreateEventPage } from '../features/events/CreateEventPage'
import { EventRoute } from '../features/events/EventRoute'
import { JoinEventPage } from '../features/events/JoinEventPage'
import { PeoplePage } from '../features/events/PeoplePage'
import { ClaimItemsRoute } from '../features/expenses/ClaimItemsRoute'
import { ExpenseEditorPage } from '../features/expenses/ExpenseEditorPage'
import { ExpenseListPage } from '../features/expenses/ExpenseListPage'
import { HomePage } from './HomePage'

export const router = createHashRouter([
  {
    element: <AppShell />,
    children: [
      { path: '/', element: <HomePage /> },
      { path: '/new/:mode', element: <CreateEventPage /> },
      { path: '/join/:token', element: <JoinEventPage /> },
      { path: '/event/:eventId', element: <EventRoute /> },
      { path: '/event/:eventId/expenses', element: <ExpenseListPage /> },
      { path: '/event/:eventId/expenses/new', element: <ExpenseEditorPage /> },
      { path: '/event/:eventId/expenses/:expenseId/claim', element: <ClaimItemsRoute /> },
      { path: '/event/:eventId/people', element: <PeoplePage /> },
    ],
  },
])
