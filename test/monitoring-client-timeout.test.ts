import { afterEach, expect, it, vi } from "vitest";
import { callCommand, clientConfiguration } from "../cli/client";
import { command } from "../src/lib/api";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
const input = {
  workspaceId: "alpha", connectionId: "monitoring", connectionRevision: 1,
  configurationRevision: 1, targetId: "health", requestId: "8ba01cc4-cbc8-42b5-b892-62c5bf226a0c",
};
it.each(["browser", "cli"])("%s waits for a saved thirty-second diagnostic and gives recovery guidance on interruption", async (client) => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation((delay) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Timeout", "TimeoutError")), delay);
    return controller.signal;
  });
  vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(Response.json({ completed: true })), 31000);
    init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal?.reason); }, { once: true });
  }));
  const run = () => client === "browser" ? command("monitoring_probe", input)
    : callCommand(clientConfiguration("https://hq.example", false, "synthetic-token"), "monitoring_probe", input);
  const completed = run();
  const checked = expect(completed).resolves.toEqual({ completed: true });
  await vi.advanceTimersByTimeAsync(31000);
  await checked;
  vi.mocked(globalThis.fetch).mockImplementation((_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
  }));
  const interrupted = expect(run()).rejects.toThrow(/same request ID/i);
  await vi.advanceTimersByTimeAsync(45000);
  await interrupted;
});
