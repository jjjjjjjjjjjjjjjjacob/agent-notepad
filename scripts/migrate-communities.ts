import { cp, mkdir, symlink, writeFile, mkdtemp } from "node:fs/promises"
import { resolve } from "node:path"
import { developmentDeployment, productionDeployment } from "../lib/environment"
const mode = process.argv[2]
if (mode !== "development" && mode !== "production")
  throw new Error("Specify development or production.")
const deployment =
  mode === "development" ? developmentDeployment : productionDeployment
await mkdir(".artifacts", { recursive: true })
const root = await mkdtemp(resolve(".artifacts/community-migration-"))
for (const path of [
  "convex",
  "lib",
  "config",
  "package.json",
  "convex.json",
  "tsconfig.json",
])
  await cp(resolve(path), resolve(root, path), { recursive: true })
await symlink(resolve("node_modules"), resolve(root, "node_modules"), "dir")
await writeFile(
  resolve(root, ".env.local"),
  `CONVEX_DEPLOYMENT=${mode === "development" ? "dev" : "prod"}:${deployment}\n`
)
const env = { ...process.env }
delete env.CONVEX_DEPLOYMENT
delete env.CONVEX_DEPLOY_KEY
async function cli(args: string[]) {
  const child = Bun.spawn(["bunx", "convex", ...args], {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code) throw new Error(err)
  return out
}
const deploy = () =>
  cli(
    mode === "development"
      ? ["dev", "--once", "--typecheck", "disable"]
      : ["deploy", "--yes", "--typecheck", "disable"]
  )
const schemaPath = resolve(root, "convex/schema.ts")
const strictSchema = await Bun.file(schemaPath).text()
const compatibleSchema = strictSchema.replace(
  'v.literal("community"),',
  'v.literal("community"), v.literal("server"),'
)
if (compatibleSchema === strictSchema)
  throw new Error("Could not construct the compatibility schema.")
await writeFile(schemaPath, compatibleSchema)
await deploy()
for (const phase of ["spaces", "roles", "messages"]) {
  let cursor: string | undefined
  do {
    const result = JSON.parse(
      await cli([
        "run",
        "migrations:communities",
        JSON.stringify({ phase, ...(cursor ? { cursor } : {}) }),
        "--deployment",
        deployment,
      ])
    ) as { done: boolean; cursor: string }
    cursor = result.done ? undefined : result.cursor
  } while (cursor)
}
await writeFile(schemaPath, strictSchema)
await deploy()
console.log(
  `Community migration complete on ${deployment}; strict schema restored.`
)
