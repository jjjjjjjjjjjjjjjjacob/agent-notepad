/** Shared, dependency-free marketplace rules. All monetary values are integer cents. */
export const PLACE_SIZE = 1000
export const TILE_SIZE = 50
export const MAX_BUNDLE_PIXELS = 10_000
export const MANIFEST_CHUNK_SIZE = 500
export const MAX_PAINT_PIXELS = 256
export const MIN_DURATION = 5 * 60_000
export const MAX_DURATION = 7 * 86_400_000
export const DEFAULT_DURATION = 86_400_000
export const PREPARATION_TIMEOUT = 10 * 60_000
export const INITIAL_PIXEL_CENTS = 100
export const PALETTE = [
  "#FFFFFF",
  "#E4E4E4",
  "#888888",
  "#222222",
  "#FFA7D1",
  "#E50000",
  "#E59500",
  "#A06A42",
  "#E5D900",
  "#94E044",
  "#02BE01",
  "#00D3DD",
  "#0083C7",
  "#0000EA",
  "#CF6EE4",
  "#820080",
] as const
export const COLOR_NAMES = [
  "White",
  "Light gray",
  "Gray",
  "Black",
  "Pink",
  "Red",
  "Orange",
  "Brown",
  "Yellow",
  "Lime",
  "Green",
  "Cyan",
  "Teal",
  "Blue",
  "Lavender",
  "Purple",
] as const
export const MAX_MONEY = 1_000_000_000_000
export function money(value: number) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_MONEY)
    throw new Error("Money must be a nonnegative safe integer in cents.")
  return value
}
export function pixelNumber(x: number, y: number) {
  if (![x, y].every((n) => Number.isInteger(n) && n >= 0 && n < PLACE_SIZE))
    throw new Error("Coordinates must be integers from 0 to 999.")
  return y * PLACE_SIZE + x
}
export function tileAddress(pixel: number) {
  const x = pixel % PLACE_SIZE,
    y = Math.floor(pixel / PLACE_SIZE)
  return {
    tile: Math.floor(y / TILE_SIZE) * 20 + Math.floor(x / TILE_SIZE),
    offset: (y % TILE_SIZE) * TILE_SIZE + (x % TILE_SIZE),
  }
}
export function resaleFee(cents: number) {
  return Number((BigInt(money(cents)) + BigInt(5)) / BigInt(10))
}
export function nextBid(cents: number) {
  return money(cents + Math.max(1, Math.ceil(cents / 100)))
}
export type SettlementCosts = {
  fixedCents: number
  perRecipientCents: number
  variableBps: number
  verified: boolean
}
export const SANDBOX_COSTS: SettlementCosts = {
  fixedCents: 1,
  perRecipientCents: 1,
  variableBps: 0,
  verified: true,
}
export function settlementCost(
  cents: number,
  recipients: number,
  costs: SettlementCosts
) {
  return money(
    costs.fixedCents +
      recipients * costs.perRecipientCents +
      Number(
        (BigInt(cents) * BigInt(costs.variableBps) + BigInt(9999)) /
          BigInt(10000)
      )
  )
}
export function qualifyingPrice(
  cents: number,
  recipients: number,
  costs: SettlementCosts
) {
  const fee = resaleFee(cents)
  return (
    costs.verified &&
    fee >= 1 &&
    BigInt(settlementCost(cents, recipients, costs)) * BigInt(5) <=
      BigInt(fee) * BigInt(4)
  )
}
/** Conservative monotone floor: ceiling-rounded provider costs, full-cent price, 20% fee margin. */
export function minimumResale(recipients: number, costs: SettlementCosts) {
  if (
    !costs.verified ||
    !Number.isInteger(recipients) ||
    recipients < 1 ||
    costs.variableBps >= 800
  )
    return null
  for (const value of [
    costs.fixedCents,
    costs.perRecipientCents,
    costs.variableBps,
  ])
    money(value)
  // Two cents of rounding headroom guarantee every higher cent amount also qualifies.
  const floor = Math.max(
    10,
    Math.ceil(
      ((costs.fixedCents + recipients * costs.perRecipientCents + 2) * 10_000) /
        (800 - costs.variableBps)
    )
  )
  return floor <= MAX_MONEY && qualifyingPrice(floor, recipients, costs)
    ? floor
    : null
}
/** Largest-remainder apportionment; stable ID tie-breaks preserve every cent. */
export function splitProceeds(
  total: number,
  shares: { agentId: string; weight: number }[]
) {
  money(total)
  if (
    !shares.length ||
    new Set(shares.map((s) => s.agentId)).size !== shares.length ||
    shares.some(
      (s) =>
        !Number.isSafeInteger(s.weight) || s.weight <= 0 || s.weight > 1_000_000
    )
  )
    throw new Error("Every seller needs a unique, positive integer share.")
  const denominator = shares.reduce(
    (sum, s) => sum + BigInt(s.weight),
    BigInt(0)
  )
  const rows = shares.map((s) => ({
    ...s,
    cents: Number((BigInt(total) * BigInt(s.weight)) / denominator),
    remainder: (BigInt(total) * BigInt(s.weight)) % denominator,
  }))
  let remaining = total - rows.reduce((sum, r) => sum + r.cents, 0)
  for (const row of [...rows].sort((a, b) =>
    a.remainder === b.remainder
      ? a.agentId.localeCompare(b.agentId)
      : a.remainder > b.remainder
        ? -1
        : 1
  )) {
    if (!remaining) break
    row.cents++
    remaining--
  }
  return rows.map(({ agentId, cents }) => ({ agentId, cents }))
}
export function formatMoney(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100)
}
