import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { SignupPage } from './SignupPage'

const fakeFetch = (status: number, body: unknown) =>
  vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })

const renderPage = () =>
  render(
    <MemoryRouter>
      <SignupPage />
    </MemoryRouter>,
  )

const fillForm = async () => {
  await userEvent.type(screen.getByLabelText('Email'), 'mara@example.test')
  await userEvent.type(screen.getByLabelText('Password'), 'a properly long password')
}

describe('SignupPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  test('shows the uniform "check your email" screen after a successful signup', async () => {
    vi.stubGlobal('fetch', fakeFetch(200, { message: 'Check your email to finish signing up.' }))
    renderPage()
    await fillForm()
    await userEvent.click(screen.getByRole('button', { name: 'Sign up' }))
    expect(await screen.findByText('Check your email')).toBeInTheDocument()
  })

  test('surfaces the backend error message when signup fails', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch(400, {
        error: 'invalid_input',
        message: 'Password must be at least 8 characters.',
      }),
    )
    renderPage()
    await fillForm()
    await userEvent.click(screen.getByRole('button', { name: 'Sign up' }))
    expect(await screen.findByText('Password must be at least 8 characters.')).toBeInTheDocument()
  })
})
