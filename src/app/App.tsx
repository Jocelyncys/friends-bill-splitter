import { RouterProvider } from 'react-router-dom'
import '../styles/tokens.css'
import '../styles/global.css'
import { router } from './router'

export function App() {
  return <RouterProvider router={router} />
}
