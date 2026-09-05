import { beforeEach, describe, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  fetch: vi.fn(),
  dispatchers: [] as { connect: { lookup: (...args: unknown[]) => void } }[],
  close: vi.fn(),
}))
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }))
vi.mock("undici", () => ({
  fetch: mocks.fetch,
  Agent: class {
    constructor(options: (typeof mocks.dispatchers)[number]) {
      mocks.dispatchers.push(options)
    }
    close() {
      return mocks.close()
    }
  },
}))
import { safeFetchText } from "../lib/safe-fetch"
beforeEach(() => {
  mocks.lookup.mockReset()
  mocks.fetch.mockReset()
  mocks.close.mockReset()
  mocks.dispatchers.length = 0
  mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }])
})
describe("source requests", () => {
  it("times out DNS resolution before opening a connection", async () => {
    vi.useFakeTimers()
    try {
      mocks.lookup.mockImplementation(() => new Promise(() => {}))
      const check = expect(
        safeFetchText("https://example.com/source")
      ).rejects.toThrow("DNS lookup timed out")
      await vi.advanceTimersByTimeAsync(4001)
      await check
      expect(mocks.fetch).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
  it("blocks a public hostname that resolves to any private address before connecting", async () => {
    mocks.lookup.mockResolvedValue([
      { address: "8.8.8.8", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ])
    await expect(safeFetchText("https://example.com/source")).rejects.toThrow(
      "private"
    )
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
  it("revalidates redirect destinations before a second request", async () => {
    mocks.fetch.mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { Location: "http://169.254.169.254/latest/meta-data" },
      })
    )
    await expect(safeFetchText("https://example.com/source")).rejects.toThrow(
      "Private"
    )
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
    expect(mocks.close).toHaveBeenCalledTimes(1)
  })
  it("pins the validated address instead of resolving again during connection", async () => {
    mocks.fetch.mockResolvedValue(
      new Response("source", { headers: { "Content-Type": "text/plain" } })
    )
    expect((await safeFetchText("https://example.com/source")).text).toBe(
      "source"
    )
    const callback = vi.fn()
    mocks.dispatchers[0].connect.lookup("example.com", { all: true }, callback)
    expect(callback).toHaveBeenCalledWith(null, [
      { address: "8.8.8.8", family: 4 },
    ])
    expect(mocks.lookup).toHaveBeenCalledTimes(1)
  })
  it("bounds streamed responses even when the server omits Content-Length", async () => {
    mocks.fetch.mockResolvedValue(
      new Response("too much content", {
        headers: { "Content-Type": "text/plain" },
      })
    )
    await expect(
      safeFetchText("https://example.com/source", 4)
    ).rejects.toThrow("size limit")
    expect(mocks.close).toHaveBeenCalledTimes(1)
  })
})
