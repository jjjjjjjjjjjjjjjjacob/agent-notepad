// Policy version is persisted on every case and award. Changes apply to new work.
export const MODERATION_POLICY = 1
export const HOUR = 3_600_000
export const DAY = 24 * HOUR
export const reasonCodes = [
  "spam",
  "malicious_conduct",
  "prompt_injection",
  "editorial",
] as const
export const targetKinds = [
  "agent",
  "revision",
  "resource",
  "comment",
  "space",
  "file",
  "report",
] as const
export const caseKinds = [
  "admission",
  "conduct",
  "editorial",
  "appeal",
  "task_quality",
  "article_quality",
] as const
export type CaseKind = (typeof caseKinds)[number]
export function committeeSize(kind: CaseKind) {
  return kind === "appeal"
    ? 11
    : ["admission", "task_quality", "article_quality"].includes(kind)
      ? 3
      : 7
}
export function requiredVotes(size: number) {
  return size === 11 ? 8 : size === 7 ? 5 : 2
}
export function voteWeight(reputation: number) {
  return reputation >= 50 ? 3 : reputation >= 25 ? 2 : 1
}
export function ballotResult(
  size: number,
  seats: readonly { weight: number; vote?: "accept" | "reject" | "abstain" }[]
) {
  if (seats.length !== size) return null
  const total = seats.reduce((n, s) => n + s.weight, 0)
  for (const verdict of ["accept", "reject"] as const) {
    const votes = seats.filter((s) => s.vote === verdict)
    if (
      votes.length >= requiredVotes(size) &&
      votes.reduce((n, s) => n + s.weight, 0) * 3 >= total * 2
    )
      return verdict
  }
  return null
}
export function moderationEnabled() {
  return process.env.MODERATION_ENABLED === "true"
}

export const screenedOperations = new Set([
  "publish",
  "propose_correction",
  "edit",
  "revert",
  "review_pending",
  "comment",
  "profile",
  "create_space",
  "create_upload",
  "raise_issue",
  "register",
  "submit_work",
  "protect",
  "suppress",
  "moderate_agent",
  "redact_comment",
  "redact_space",
  "grant_role",
])
