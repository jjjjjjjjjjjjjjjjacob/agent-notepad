import { Cause, Effect, Exit, Option } from "effect"
import { ConvexError } from "convex/values"
import { z } from "zod"
import {
  AppError,
  appError,
  errorData,
  errorStatuses,
  expectedError,
  externalError,
  internalError,
  retryAfter,
} from "./errors"

type Classifier = (error: unknown) => AppError | undefined
const classified = (error: unknown, classify: Classifier) => {
  const known = classify(error)
  return known ? Effect.fail(known) : Effect.die(error)
}

/** Scope this adapter to one fallible call, not an entire business workflow. */
export function attempt<A>(
  operation: () => PromiseLike<A>,
  classify: Classifier = expectedError
): Effect.Effect<A, AppError> {
  return Effect.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: (error) => error,
  }).pipe(Effect.catchAll((error) => classified(error, classify)))
}
export function attemptSync<A>(
  operation: () => A,
  classify: Classifier = expectedError
): Effect.Effect<A, AppError> {
  return Effect.try({ try: operation, catch: (error) => error }).pipe(
    Effect.catchAll((error) => classified(error, classify))
  )
}
export const external = <A>(operation: () => PromiseLike<A>, service: string) =>
  attempt(operation, (error) => externalError(error, service))

/** Fetch rejects with TypeError for browser/network failures. Only wrap fetch itself here. */
export function fetchEffect(
  operation: () => Promise<Response>,
  service: string
) {
  return attempt(
    operation,
    (error) =>
      externalError(error, service) ??
      (error instanceof TypeError
        ? appError("UNAVAILABLE", `${service} is temporarily unavailable.`)
        : undefined)
  )
}
export const responseJson = (response: Response, service: string) =>
  attempt(
    () => response.json() as Promise<unknown>,
    (error) =>
      error instanceof SyntaxError
        ? appError("BAD_GATEWAY", `${service} returned an invalid response.`)
        : externalError(error, service)
  )
export function validate<A>(
  schema: z.ZodType<A>,
  input: unknown,
  message = "Check the submitted values and try again."
) {
  return Effect.suspend(() => {
    const result = schema.safeParse(input)
    return result.success
      ? Effect.succeed(result.data)
      : Effect.fail(appError("VALIDATION", message))
  })
}
export const parseJson = (text: string) =>
  attemptSync(
    () => JSON.parse(text) as unknown,
    (error) =>
      error instanceof SyntaxError
        ? appError("VALIDATION", "The request must contain valid JSON.")
        : undefined
  )

export const isExpectedCause = (cause: Cause.Cause<AppError>) =>
  Cause.isFailure(cause) && !Cause.isDie(cause) && !Cause.isInterrupted(cause)
export function failureError(cause: Cause.Cause<AppError>): AppError {
  // A combined failure/defect must never be treated as a recoverable application error.
  if (isExpectedCause(cause)) {
    const failure = Cause.failureOption(cause)
    if (Option.isSome(failure)) return failure.value
  }
  return internalError()
}
export function reportFailure(source: string, cause: Cause.Cause<AppError>) {
  console.error("application_error", {
    source,
    error_code: failureError(cause).code.toLowerCase(),
    kind: isExpectedCause(cause) ? "failure" : "defect",
  })
}

/** Compatibility adapter: preserve typed errors, rather than exposing FiberFailure wrappers. */
export async function runEffect<A>(
  effect: Effect.Effect<A, AppError>
): Promise<A> {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) return exit.value
  if (isExpectedCause(exit.cause)) throw failureError(exit.cause)
  throw new Error("Unexpected operation failure.")
}
export async function runConvex<A>(
  effect: Effect.Effect<A, AppError>,
  source: string
): Promise<A> {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) return exit.value
  if (!isExpectedCause(exit.cause)) {
    reportFailure(source, exit.cause)
    throw new Error("The request could not be completed.")
  }
  throw new ConvexError(errorData(failureError(exit.cause)))
}
export function errorResponse(
  error: AppError,
  headers?: HeadersInit,
  stringEnvelope = false
) {
  const responseHeaders = new Headers(headers)
  responseHeaders.set("Cache-Control", "no-store")
  responseHeaders.set("X-Content-Type-Options", "nosniff")
  const retry = retryAfter(error)
  if (retry) responseHeaders.set("Retry-After", retry)
  return Response.json(
    { error: stringEnvelope ? error.message : errorData(error) },
    { status: errorStatuses[error.code], headers: responseHeaders }
  )
}
export async function runHttp(
  effect: Effect.Effect<Response, AppError>,
  source: string,
  onError: (error: AppError) => Response = errorResponse
) {
  const exit = await Effect.runPromiseExit(effect)
  if (Exit.isSuccess(exit)) return exit.value
  if (!isExpectedCause(exit.cause)) reportFailure(source, exit.cause)
  return onError(failureError(exit.cause))
}
