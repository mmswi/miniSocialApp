import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { ResetPasswordPage } from './ResetPasswordPage'

const fakeFetch = (status: number, body: unknown) =>
  vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })

// The page reads its token from ?token, so render it on a URL that carries one.
const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/reset-password?token=a-valid-looking-token']}>
      <ResetPasswordPage />
    </MemoryRouter>,
  )

describe('ResetPasswordPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  test('blocks submit and shows an error when the two passwords differ', async () => {
    const fetchSpy = fakeFetch(200, { message: 'ok' })
    vi.stubGlobal('fetch', fetchSpy)
    renderPage()

    await userEvent.type(screen.getByLabelText('New password'), 'first-password-1')
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'second-password-2')
    await userEvent.click(screen.getByRole('button', { name: 'Reset password' }))

    expect(await screen.findByText("Those passwords don't match.")).toBeInTheDocument()
    // The single-use token must not be spent on a typo — the request never goes out.
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  test('submits when the two passwords match', async () => {
    const fetchSpy = fakeFetch(200, {
      message: 'Your password has been reset. You can now log in.',
    })
    vi.stubGlobal('fetch', fetchSpy)
    renderPage()

    await userEvent.type(screen.getByLabelText('New password'), 'matching-password-1')
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'matching-password-1')
    await userEvent.click(screen.getByRole('button', { name: 'Reset password' }))

    expect(fetchSpy).toHaveBeenCalledWith(
      '/auth/reset-password',
      expect.objectContaining({ method: 'POST' }),
    )
  })
})
