import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { syncTestSource } from "../scripts/lib/sync-test-source"

it("mirrors source deletions and updates without removing isolated backend data", async () => {
  const root = await mkdtemp(join(tmpdir(), "notepad-source-sync-"))
  try {
    const source = join(root, "source")
    const destination = join(root, "isolated", "convex")
    await mkdir(join(source, "lib"), { recursive: true })
    await writeFile(join(source, "lib", "removed.ts"), "retired")
    await writeFile(join(source, "current.ts"), "before")
    await syncTestSource(source, destination)
    const data = join(root, "isolated", "database")
    await writeFile(data, "persistent data")
    await rm(join(source, "lib", "removed.ts"))
    await writeFile(join(source, "current.ts"), "after")
    await writeFile(join(source, "new.ts"), "added")
    await syncTestSource(source, destination)
    await expect(
      readFile(join(destination, "lib", "removed.ts"))
    ).rejects.toMatchObject({ code: "ENOENT" })
    expect(await readFile(join(destination, "current.ts"), "utf8")).toBe(
      "after"
    )
    expect(await readFile(join(destination, "new.ts"), "utf8")).toBe("added")
    expect(await readFile(data, "utf8")).toBe("persistent data")
    await rm(source, { recursive: true })
    await expect(syncTestSource(source, destination)).rejects.toMatchObject({
      code: "ENOENT",
    })
    expect(await readFile(join(destination, "current.ts"), "utf8")).toBe(
      "after"
    )
    expect(await readFile(data, "utf8")).toBe("persistent data")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
