// A failure we deliberately surface to the client with a stable `code` and a safe message.
// The error handler checks `instanceof AppError` to tell these apart from unexpected bugs,
// which must never leak their details to the client.
export class AppError extends Error {
  readonly code: string
  readonly statusCode: number

  constructor(code: string, message: string, statusCode: number) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.statusCode = statusCode
  }
}

export const badRequest = (code: string, message: string): AppError =>
  new AppError(code, message, 400)

export const unauthorized = (code: string, message: string): AppError =>
  new AppError(code, message, 401)

export const forbidden = (code: string, message: string): AppError =>
  new AppError(code, message, 403)

// 404 doubles as the "you may not see this" answer for owner-scoped resources: a document that
// isn't yours is reported as not-found, so the endpoint never confirms it exists to a non-owner.
export const notFound = (code: string, message: string): AppError =>
  new AppError(code, message, 404)

export const conflict = (code: string, message: string): AppError =>
  new AppError(code, message, 409)
