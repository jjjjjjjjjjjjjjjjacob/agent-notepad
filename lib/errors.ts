import { Data } from "effect"
import { ConvexError } from "convex/values"
import { z } from "zod"

export const errorStatuses = {
  VALIDATION: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  INTERNAL: 500,
  BAD_GATEWAY: 502,
  NOT_CONFIGURED: 503,
  UNAVAILABLE: 503,
  TIMEOUT: 504,
} as const
export type ErrorCode = keyof typeof errorStatuses
export const errorCodes = Object.keys(errorStatuses) as [
  ErrorCode,
  ...ErrorCode[],
]
export const errorDataSchema = z.object({
  code: z.enum(errorCodes),
  message: z.string().min(1).max(1000),
  details: z
    .object({
      retryAfterSeconds: z.number().finite().nonnegative().optional(),
      caseId: z.string().max(100).optional(),
    })
    .optional(),
})
export type ErrorData = z.infer<typeof errorDataSchema>

/** Only construct with application-authored messages, never provider exception text. */
export class AppError extends Data.TaggedError("AppError")<ErrorData> {}
export const appError = (
  code: ErrorCode,
  message: string,
  details?: ErrorData["details"]
) => new AppError({ code, message, ...(details ? { details } : {}) })
export const internalError = () =>
  appError("INTERNAL", "The request could not be completed.")

export function decodeErrorData(value: unknown): AppError | undefined {
  if (typeof value === "string") {
    try {
      value = JSON.parse(value)
    } catch {
      return undefined
    }
  }
  const parsed = errorDataSchema.safeParse(value)
  return parsed.success ? new AppError(parsed.data) : undefined
}

export function expectedError(error: unknown): AppError | undefined {
  if (error instanceof AppError) return error
  if (error instanceof ConvexError) return decodeErrorData(error.data)
  if (error instanceof z.ZodError)
    return appError("VALIDATION", "Check the submitted values and try again.")
}

export function errorData(error: AppError): ErrorData {
  return errorDataSchema.parse({
    code: error.code,
    message: error.message,
    ...(error.details ? { details: error.details } : {}),
  })
}
export const isTransient = (error: AppError) =>
  error.code === "UNAVAILABLE" ||
  error.code === "TIMEOUT" ||
  error.code === "RATE_LIMITED"

export function retryAfter(error: AppError): string | undefined {
  const seconds = error.details?.retryAfterSeconds
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
    ? String(Math.ceil(seconds))
    : undefined
}

/** Structured SDK status/code fields only; exception messages are never inspected. */
export function externalError(
  error: unknown,
  service: string
): AppError | undefined {
  const known = expectedError(error)
  if (known) return known
  if (!error || typeof error !== "object") return undefined
  const e = error as {
    name?: string
    code?: string
    type?: string
    status?: number
    statusCode?: number
    $metadata?: { httpStatusCode?: number }
    cause?: { code?: string }
  }
  const status = e.statusCode ?? e.status ?? e.$metadata?.httpStatusCode
  if (
    e.name === "TimeoutError" ||
    e.name === "AbortError" ||
    [
      "ETIMEDOUT",
      "UND_ERR_CONNECT_TIMEOUT",
      "UND_ERR_HEADERS_TIMEOUT",
      "UND_ERR_BODY_TIMEOUT",
      "ERR_JWKS_TIMEOUT",
    ].includes(e.code ?? e.cause?.code ?? "")
  )
    return appError("TIMEOUT", `${service} timed out. Please try again later.`)
  if (status === 429 || e.name === "ThrottlingException")
    return appError(
      "RATE_LIMITED",
      `${service} is busy. Please try again later.`
    )
  if (
    (status !== undefined && status >= 500) ||
    [
      "ECONNRESET",
      "ECONNREFUSED",
      "ENOTFOUND",
      "EAI_AGAIN",
      "EPIPE",
      "UND_ERR_SOCKET",
    ].includes(e.code ?? e.cause?.code ?? "") ||
    e.type === "StripeConnectionError" ||
    e.name === "PostHogFetchNetworkError"
  )
    return appError("UNAVAILABLE", `${service} is temporarily unavailable.`)
  if (["ERR_JWKS_INVALID", "ERR_JWK_INVALID"].includes(e.code ?? ""))
    return appError(
      "BAD_GATEWAY",
      `${service} returned invalid verification keys.`
    )
  // Provider authentication failures concern our configuration, not the caller's credentials.
  if (status === 401 || status === 403)
    return appError(
      "NOT_CONFIGURED",
      `${service} is not available with the current configuration.`
    )
  if (status !== undefined && status >= 400 && status < 500)
    return appError("BAD_GATEWAY", `${service} rejected the request.`)
}
