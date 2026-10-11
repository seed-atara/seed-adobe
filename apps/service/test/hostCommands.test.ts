import { describe, expect, it } from "vitest";
import { HOST_COMMANDS, HostCommandQueue } from "../src/host/commands.js";

/**
 * The queue is the only thing standing between an agent and an artist's
 * project file, so its refusals matter more than its successes.
 */

/** Marks a panel present without waiting out a real long poll. */
function withPanel(queue: HostCommandQueue): void {
  void queue.next(5);
}

describe("driving the host from outside the panel", () => {
  it("refuses a name that is not on the allowlist", async () => {
    const queue = new HostCommandQueue();
    withPanel(queue);

    /*
     * The rule the whole design exists for. An agent on the other end of this
     * would be far more capable if it could send ExtendScript, and that is
     * precisely what must never be possible: the panel runs inside the
     * artist's project with their filesystem, and CLAUDE.md forbids executing
     * text a model produced.
     */
    await expect(queue.run("app.project.close()")).rejects.toThrow(/not a host command/);
    await expect(queue.run("eval")).rejects.toThrow(/never scripts/);
  });

  it("refuses up front when no panel is listening", async () => {
    const queue = new HostCommandQueue();
    // Queueing into a void and timing out two minutes later teaches the caller
    // nothing it could not have been told immediately.
    await expect(queue.run("ping")).rejects.toThrow(/no SEED panel is listening/);
  });

  it("hands a queued command to a panel that asks for work", async () => {
    const queue = new HostCommandQueue();
    withPanel(queue);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const running = queue.run("getContext", { verbose: true });
    const command = await queue.next(500);

    expect(command?.name).toBe("getContext");
    expect(command?.args).toEqual({ verbose: true });

    queue.complete(command!.id, { ok: true, value: { comp: "Comp 1" } });
    await expect(running).resolves.toEqual({ ok: true, value: { comp: "Comp 1" } });
  });

  it("wakes a parked panel the moment work arrives", async () => {
    const queue = new HostCommandQueue();
    withPanel(queue);
    await new Promise((resolve) => setTimeout(resolve, 10));

    // The panel asks first and waits — the normal case, and the one that makes
    // a command land in milliseconds rather than on the next tick of a timer.
    const parked = queue.next(2000);
    const running = queue.run("listRegions");

    const command = await parked;
    expect(command?.name).toBe("listRegions");
    queue.complete(command!.id, { ok: true, value: [] });
    await expect(running).resolves.toMatchObject({ ok: true });
  });

  it("releases a parked panel with nothing when the hold expires", async () => {
    const queue = new HostCommandQueue();
    // A heartbeat, not a limit: the panel reconnects straight away.
    await expect(queue.next(20)).resolves.toBeUndefined();
  });

  it("gives up on a host that never answers, and says why", async () => {
    const queue = new HostCommandQueue();
    withPanel(queue);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const result = await queue.run("captureFrame", {}, 1000);
    expect(result.ok).toBe(false);
    // A modal dialog in After Effects blocks ExtendScript entirely, and it is
    // far and away the likeliest cause, so the message names it.
    expect(result.error).toMatch(/did not answer captureFrame/);
    expect(result.error).toMatch(/modal dialog/);
  });

  it("ignores a result for a command that already gave up", async () => {
    const queue = new HostCommandQueue();
    withPanel(queue);
    await new Promise((resolve) => setTimeout(resolve, 10));

    const result = await queue.run("ping", {}, 1000);
    expect(result.ok).toBe(false);
    // The panel did the work either way; failing it for being slow would make
    // a late answer look like a panel bug.
    expect(() => queue.complete("gone", { ok: true })).not.toThrow();
  });

  it("reports whether a panel is there, which is what a caller needs first", async () => {
    const queue = new HostCommandQueue();
    expect(queue.connected()).toBe(false);
    expect(queue.stats().connected).toBe(false);

    withPanel(queue);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(queue.connected()).toBe(true);
  });

  it("publishes an allowlist that separates reading from changing the project", () => {
    // The distinction is what someone deciding whether to let an agent near
    // their project actually needs, so it is not buried in one flat list.
    expect(HOST_COMMANDS).toContain("getContext");
    expect(HOST_COMMANDS).toContain("createRegion");
    expect(HOST_COMMANDS).not.toContain("evalScript");
  });
});
