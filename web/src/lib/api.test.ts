import { beforeEach, describe, expect, test, vi } from 'vitest'
import { API_fetchMe, API_logout, ApiError } from './api'

// Builds a fake fetch Response with just the bits our request() helper reads.
const fakeFetch = (status: number, body: unknown) =>
  vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })

describe('api request helper', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  test('returns the parsed body on a 2xx', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch(200, { user: { id: '1', email: 'a@b.c', emailVerified: true, name: null } }),
    )
    const { user } = await API_fetchMe()
    expect(user.email).toBe('a@b.c')
  })

  test('maps a non-2xx to an ApiError carrying the backend code + message', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch(401, { error: 'not_authenticated', message: 'Sign in to continue.' }),
    )
    const error = await API_fetchMe().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      status: 401,
      code: 'not_authenticated',
      message: 'Sign in to continue.',
    })
  })

  test('treats a 204 as null without trying to parse a body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 204 }))
    expect(await API_logout()).toBeNull()
  })

  test('always sends the session cookie (credentials: include)', async () => {
    const fetchSpy = fakeFetch(200, {
      user: { id: '1', email: 'a@b.c', emailVerified: false, name: null },
    })
    vi.stubGlobal('fetch', fetchSpy)
    await API_fetchMe()
    expect(fetchSpy).toHaveBeenCalledWith(
      '/auth/me',
      expect.objectContaining({ credentials: 'include' }),
    )
  })
})
