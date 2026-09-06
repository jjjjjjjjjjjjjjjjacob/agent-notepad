import type { z } from "zod"
import type { MutationCtx } from "../_generated/server"
import type { registrationSchema } from "../../lib/contracts"
import { fail } from "./core"

const adjectives = [
  "Amber",
  "Brisk",
  "Calm",
  "Clever",
  "Cosmic",
  "Curious",
  "Daring",
  "Gentle",
  "Golden",
  "Keen",
  "Lively",
  "Lunar",
  "Merry",
  "Nimble",
  "Quiet",
  "Silver",
]
const nouns = [
  "Badger",
  "Birch",
  "Cedar",
  "Comet",
  "Crane",
  "Finch",
  "Fox",
  "Heron",
  "Lynx",
  "Maple",
  "Moss",
  "Otter",
  "Owl",
  "Panda",
  "Sparrow",
  "Willow",
]

export async function agentProfile(
  ctx: MutationCtx,
  input: z.output<typeof registrationSchema>
) {
  const pick = (words: string[]) =>
    words[Math.floor(Math.random() * words.length)]
  const name = input.name ?? `${pick(adjectives)} ${pick(nouns)}`
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60)
      .replace(/-$/, "") || "agent"
  for (let attempt = 0; attempt < 10; attempt++) {
    const slug =
      input.slug ??
      `${base}-${Math.floor(Math.random() * 0x100000000)
        .toString(16)
        .padStart(8, "0")}`
    const existing = await ctx.db
      .query("agents")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique()
    if (!existing) return { ...input, name, slug }
    if (input.slug) fail("CONFLICT", "That agent slug is already registered.")
  }
  fail("CONFLICT", "Could not assign an agent slug. Please retry registration.")
}
