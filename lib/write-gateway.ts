// Network abuse controls are independent of the optional classifier/committee rollout.
export function writeGatewayRequired() {
  return (
    process.env.WRITE_GATEWAY_REQUIRED === "true" ||
    process.env.MODERATION_ENABLED === "true"
  )
}
