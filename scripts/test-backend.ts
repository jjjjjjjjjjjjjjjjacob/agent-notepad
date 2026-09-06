import { cp, mkdir, symlink, writeFile, stat } from "node:fs/promises"
import { watch, type FSWatcher } from "node:fs"
import { resolve } from "node:path"
const root = resolve(".artifacts/test-backend")
await mkdir(root, { recursive: true })
for (const path of [
  "convex",
  "lib",
  "config",
  "package.json",
  "convex.json",
  "tsconfig.json",
])
  await cp(resolve(path), resolve(root, path), { recursive: true, force: true })
try {
  await stat(resolve(root, "node_modules"))
} catch {
  await symlink(resolve("node_modules"), resolve(root, "node_modules"), "dir")
}
// The backend's data lives under this isolated project directory, never .convex/ in the workspace.
const childEnv = { ...process.env }
delete childEnv.CONVEX_DEPLOYMENT
delete childEnv.CONVEX_DEPLOY_KEY
// Keep a reused isolated backend on the current source, without sharing its data directory.
let syncTimer: ReturnType<typeof setTimeout> | undefined
let syncQueue = Promise.resolve()
const watchers: FSWatcher[] = []
for (const source of ["convex", "lib", "config"])
  watchers.push(
    watch(resolve(source), { recursive: true }, (_event, name) => {
      if (name?.includes("_generated")) return
      clearTimeout(syncTimer)
      syncTimer = setTimeout(() => {
        syncQueue = syncQueue
          .then(async () => {
            for (const path of ["convex", "lib", "config"])
              await cp(resolve(path), resolve(root, path), {
                recursive: true,
                force: true,
              })
          })
          .catch((error) =>
            console.error(
              "Could not update isolated backend source:",
              error.message
            )
          )
      }, 200)
    })
  )
const processHandle = Bun.spawn(
  [
    "bunx",
    "convex",
    "dev",
    "--configure",
    "existing",
    "--team",
    "jjjjjjjjjjjjjjjjacob-gmail-com",
    "--project",
    "agent-notepad",
    "--dev-deployment",
    "local",
    "--local-cloud-port",
    "3215",
    "--local-site-port",
    "3216",
    "--typecheck",
    "disable",
    "--tail-logs",
    "disable",
  ],
  { cwd: root, env: childEnv, stdout: "inherit", stderr: "inherit" }
)
let initialized = false
const readiness = Bun.serve({
  hostname: "127.0.0.1",
  port: 3217,
  fetch: () =>
    new Response("Isolated test backend", { status: initialized ? 200 : 503 }),
})
function shutdown() {
  initialized = false
  clearTimeout(syncTimer)
  for (const watcher of watchers) watcher.close()
  readiness.stop(true)
  processHandle.kill()
}
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
async function cli(args: string[]) {
  const child = Bun.spawn(["bunx", "convex", ...args], {
    cwd: root,
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
  })
  if (await child.exited)
    throw new Error(await new Response(child.stderr).text())
}
let ready = false
for (let i = 0; i < 180; i++) {
  try {
    const r = await fetch("http://127.0.0.1:3216/api/v1/spaces?limit=1")
    if (r.ok) {
      ready = true
      break
    }
  } catch {}
  await Bun.sleep(1000)
}
if (!ready) {
  shutdown()
  throw new Error("Isolated test backend did not become ready.")
}
await cli(["env", "set", "SITE_URL", "http://127.0.0.1:4242"])
await cli(["env", "set", "TRUSTED_ORIGINS", "http://127.0.0.1:4242"])
await cli([
  "env",
  "set",
  "BETTER_AUTH_SECRET",
  "isolated-test-secret-not-for-production-7f56b9",
])
await cli(["env", "set", "PLACE_ENABLED", process.env.PLACE_ENABLED ?? "true"])
await cli(["run", "seed:run"])
await writeFile(resolve(root, "ready"), "isolated-test-backend")
initialized = true
console.log("Isolated test backend ready on 3215/3216.")
await processHandle.exited
shutdown()
