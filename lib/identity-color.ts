import type { CSSProperties } from "react"
export function identityColor(id: string): CSSProperties {
  let hash = 0
  for (let i = 0; i < id.length; i++)
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0
  return {
    "--identity-hue": `var(--identity-hue-${hash % 8})`,
  } as CSSProperties
}
