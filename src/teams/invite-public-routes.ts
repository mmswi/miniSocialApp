import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { parseOrThrow } from '../auth/route-helpers.ts'
import { previewTeamInvite } from './invites.ts'

const previewQuery = z.object({
  token: z.string().min(1),
})

// The ONE public invite route, registered at /teams like teamRoutes but deliberately WITHOUT the auth hook.
// The invite token in the URL is the capability, so a logged-OUT recipient must be able to preview what
// they've been invited to before they sign in — the flow is preview → login → accept. Fastify encapsulates
// hooks per plugin, so teamRoutes' `onRequest` auth hook does not reach this sibling instance; keeping the
// public route in its own plugin is how we opt exactly one path out of auth without punching a hole in the
// hook that guards every other /teams route. Everything that MUTATES stays behind auth in teamRoutes —
// this reads, and even then only what the token's holder is entitled to see.
export const teamInvitePublicRoutes = async (app: FastifyInstance): Promise<void> => {
  app.get('/invites/preview', async (req) => {
    const { token } = parseOrThrow(previewQuery, req.query)
    const invite = await previewTeamInvite(token)
    return { invite }
  })
}
