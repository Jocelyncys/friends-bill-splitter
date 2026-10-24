import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { App } from './App'
import '../i18n'

describe('App', () => {
  it('switches between English and Simplified Chinese', async () => {
    render(<App />)
    expect(screen.getByRole('heading', { name: 'What would you like to split?' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '简体中文' }))
    expect(screen.getByRole('heading', { name: '你想怎样分账？' })).toBeInTheDocument()
  })
})
