import { describe, expect, it } from "vitest";

import {
  ResourceAwareScheduler,
  type SchedulerTime,
} from "../../src/orchestration/resource-scheduler.js";

describe("ResourceAwareScheduler", () => {
  it("limits global concurrency and returns results in input order", async () => {
    const scheduler = new ResourceAwareScheduler({
      globalMaximumConcurrency: 2,
      resourceGroups: {},
    });
    let active = 0;
    let maximumActive = 0;
    const resolvers: Array<() => void> = [];
    const result = scheduler.map(
      [0, 1, 2, 3].map((value) => ({ value })),
      async (value) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await new Promise<void>((resolve) => resolvers.push(resolve));
        active -= 1;
        return value * 2;
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(maximumActive).toBe(2);
    expect(resolvers).toHaveLength(2);
    resolvers[1]!();
    resolvers[0]!();
    await new Promise((resolve) => setImmediate(resolve));
    resolvers[3]!();
    resolvers[2]!();
    await expect(result).resolves.toEqual([0, 2, 4, 6]);
  });

  it("enforces global and per-group limits", async () => {
    const scheduler = new ResourceAwareScheduler({
      globalMaximumConcurrency: 3,
      resourceGroups: {
        alpha: { maximumConcurrency: 1, minimumStartIntervalMs: 0 },
        beta: { maximumConcurrency: 2, minimumStartIntervalMs: 0 },
      },
    });
    let active = 0;
    let alphaActive = 0;
    let betaActive = 0;
    let maxActive = 0;
    let maxAlpha = 0;
    let maxBeta = 0;
    const mapped = scheduler.map(
      ["a1", "b1", "b2", "a2", "b3"].map((value) => ({
        value,
        resourceGroup: value.startsWith("a") ? "alpha" : "beta",
      })),
      async (value) => {
        active += 1;
        if (value.startsWith("a")) {
          alphaActive += 1;
          maxAlpha = Math.max(maxAlpha, alphaActive);
        } else {
          betaActive += 1;
          maxBeta = Math.max(maxBeta, betaActive);
        }
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        active -= 1;
        if (value.startsWith("a")) alphaActive -= 1;
        else betaActive -= 1;
        return value;
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(maxActive).toBe(3);
    expect(maxAlpha).toBe(1);
    expect(maxBeta).toBe(2);
    await expect(mapped).resolves.toEqual(["a1", "b1", "b2", "a2", "b3"]);
    await expect(
      new ResourceAwareScheduler({
        globalMaximumConcurrency: 1,
        resourceGroups: {},
      }).map([{ value: 1, resourceGroup: "missing" }], async (value) => value),
    ).rejects.toThrow(/unknown resource group/);
  });

  it("paces group starts with injected monotonic time and does not deadlock groups", async () => {
    let now = 0;
    const waits: number[] = [];
    const time: SchedulerTime = {
      nowMs: () => now,
      wait: async (delayMs) => {
        waits.push(delayMs);
        now += delayMs;
      },
    };
    const starts: Array<[string, number]> = [];
    const scheduler = new ResourceAwareScheduler({
      globalMaximumConcurrency: 1,
      resourceGroups: {
        alpha: { maximumConcurrency: 1, minimumStartIntervalMs: 750 },
        beta: { maximumConcurrency: 1, minimumStartIntervalMs: 1000 },
      },
      time,
    });
    await expect(
      scheduler.map(
        ["a1", "a2", "a3"].map((value) => ({ value, resourceGroup: "alpha" })),
        async (value) => {
          starts.push([value, now]);
          return value;
        },
      ),
    ).resolves.toEqual(["a1", "a2", "a3"]);
    expect(starts).toEqual([
      ["a1", 0],
      ["a2", 750],
      ["a3", 1500],
    ]);
    expect(waits).toEqual([750, 750]);
    await expect(
      scheduler.map([{ value: "b1", resourceGroup: "beta" }], async (value) => {
        starts.push([value, now]);
        return value;
      }),
    ).resolves.toEqual(["b1"]);
    expect(starts.at(-1)).toEqual(["b1", 1500]);
  });

  it("captures concurrent mapper starts before an immediately advancing wait", async () => {
    let now = 0;
    const starts: Array<[string, number]> = [];
    const time: SchedulerTime = {
      nowMs: () => now,
      wait: async (delayMs) => {
        now += delayMs;
      },
    };
    const scheduler = new ResourceAwareScheduler({
      globalMaximumConcurrency: 2,
      resourceGroups: {
        alpha: { maximumConcurrency: 2, minimumStartIntervalMs: 750 },
      },
      time,
    });

    await expect(
      scheduler.map(
        [
          { value: "a1", resourceGroup: "alpha" },
          { value: "a2", resourceGroup: "alpha" },
        ],
        async (value) => {
          starts.push([value, now]);
          return value;
        },
      ),
    ).resolves.toEqual(["a1", "a2"]);

    expect(starts).toEqual([
      ["a1", 0],
      ["a2", 750],
    ]);
  });

  it("does not let a later group overtake a blocked global queue head", async () => {
    let now = 0;
    const starts: string[] = [];
    const scheduler = new ResourceAwareScheduler({
      globalMaximumConcurrency: 2,
      resourceGroups: {
        alpha: { maximumConcurrency: 1, minimumStartIntervalMs: 100 },
        beta: { maximumConcurrency: 1, minimumStartIntervalMs: 0 },
      },
      time: {
        nowMs: () => now,
        wait: async (delayMs) => {
          now += delayMs;
        },
      },
    });
    await expect(
      scheduler.map(
        [
          { value: "a1", resourceGroup: "alpha" },
          { value: "a2", resourceGroup: "alpha" },
          { value: "b1", resourceGroup: "beta" },
        ],
        async (value) => {
          starts.push(value);
          return value;
        },
      ),
    ).resolves.toEqual(["a1", "a2", "b1"]);
    expect(starts).toEqual(["a1", "a2", "b1"]);
  });

  it("does not deadlock when different groups are admitted in FIFO order", async () => {
    const starts: string[] = [];
    const releases: Array<() => void> = [];
    const scheduler = new ResourceAwareScheduler({
      globalMaximumConcurrency: 2,
      resourceGroups: {
        alpha: { maximumConcurrency: 1, minimumStartIntervalMs: 0 },
        beta: { maximumConcurrency: 1, minimumStartIntervalMs: 0 },
      },
    });
    const mapped = scheduler.map(
      [
        { value: "a1", resourceGroup: "alpha" },
        { value: "b1", resourceGroup: "beta" },
      ],
      async (value) => {
        starts.push(value);
        await new Promise<void>((resolve) => releases.push(resolve));
        return value;
      },
    );

    await new Promise((resolve) => setImmediate(resolve));
    expect(starts).toEqual(["a1", "b1"]);
    expect(releases).toHaveLength(2);
    releases.forEach((release) => release());
    await expect(mapped).resolves.toEqual(["a1", "b1"]);
  });

  it("propagates the earliest input failure and never retries", async () => {
    const calls: number[] = [];
    const scheduler = new ResourceAwareScheduler({
      globalMaximumConcurrency: 3,
      resourceGroups: {},
    });
    await expect(
      scheduler.map(
        [0, 1, 2].map((value) => ({ value })),
        async (value) => {
          calls.push(value);
          if (value === 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
            throw new Error("first");
          }
          if (value === 1) throw new Error("second");
          return value;
        },
      ),
    ).rejects.toThrow("first");
    expect(calls).toEqual([0, 1, 2]);
  });

  it("turns a synchronous mapper throw into a rejected result without retrying", async () => {
    let calls = 0;
    const scheduler = new ResourceAwareScheduler({
      globalMaximumConcurrency: 1,
      resourceGroups: {},
    });
    await expect(
      scheduler.map([{ value: "only" }], () => {
        calls += 1;
        throw new Error("synchronous failure");
      }),
    ).rejects.toThrow("synchronous failure");
    expect(calls).toBe(1);
  });

  it("keeps FIFO admission and drains failures without retrying", async () => {
    const starts: number[] = [];
    const calls = new Map<number, number>();
    const scheduler = new ResourceAwareScheduler({
      globalMaximumConcurrency: 1,
      resourceGroups: { alpha: { maximumConcurrency: 1, minimumStartIntervalMs: 10 } },
      time: {
        nowMs: () => fakeNow,
        wait: async (delayMs) => {
          fakeNow += delayMs;
        },
      },
    });
    let fakeNow = 0;
    await expect(
      scheduler.map(
        [0, 1, 2].map((value) => ({ value, resourceGroup: "alpha" })),
        async (value) => {
          starts.push(value);
          calls.set(value, (calls.get(value) ?? 0) + 1);
          if (value === 1) throw new Error("rate limited");
          return value;
        },
      ),
    ).rejects.toThrow("rate limited");
    expect(starts).toEqual([0, 1, 2]);
    expect(calls).toEqual(
      new Map([
        [0, 1],
        [1, 1],
        [2, 1],
      ]),
    );
  });
});
