import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { ForgotPasswordPage } from './ForgotPasswordPage'

const fakeFetch = (status: number, body: unknown) =>
  vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })

const renderPage = () =>
  render(
    <MemoryRouter>
      <ForgotPasswordPage />
    </MemoryRouter>,
  )

describe('ForgotPasswordPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  test('shows the uniform "check your email" screen after submitting', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch(200, { message: 'If that email has an account, we sent a password reset link.' }),
    )
    renderPage()
    await userEvent.type(screen.getByLabelText('Email'), 'mara@example.test')
    await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }))
    expect(await screen.findByText('Check your email')).toBeInTheDocument()
  })

  test('surfaces the backend error message when the request fails', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch(429, {
        error: 'rate_limited',
        message: 'Too many requests. Try again in 30 seconds.',
      }),
    )
    renderPage()
    await userEvent.type(screen.getByLabelText('Email'), 'mara@example.test')
    await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }))
    expect(
      await screen.findByText('Too many requests. Try again in 30 seconds.'),
    ).toBeInTheDocument()
  })
})
