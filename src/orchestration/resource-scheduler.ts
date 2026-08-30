import { performance } from "node:perf_hooks";

export interface SchedulerTime {
  nowMs(): number;
  wait(delayMs: number): Promise<void>;
}

export interface ResourceGroupLimit {
  readonly maximumConcurrency: number;
  readonly minimumStartIntervalMs: number;
}

export interface ScheduledItem<T> {
  readonly value: T;
  readonly resourceGroup?: string;
}

export interface ResourceSchedulerOptions {
  readonly globalMaximumConcurrency: number;
  readonly resourceGroups: Readonly<Record<string, ResourceGroupLimit>>;
  readonly time?: SchedulerTime;
}

const productionTime: SchedulerTime = {
  nowMs: () => performance.now(),
  wait: (delayMs) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, Math.max(0, delayMs));
    }),
};

interface GroupState {
  readonly limit: ResourceGroupLimit;
  active: number;
  lastStartedAt: number | undefined;
}

export class ResourceAwareScheduler {
  private readonly globalMaximumConcurrency: number;
  private readonly groups: Map<string, GroupState>;
  private readonly time: SchedulerTime;

  public constructor(options: ResourceSchedulerOptions) {
    if (
      !Number.isInteger(options.globalMaximumConcurrency) ||
      options.globalMaximumConcurrency < 1
    ) {
      throw new Error("globalMaximumConcurrency must be a positive integer");
    }
    this.globalMaximumConcurrency = options.globalMaximumConcurrency;
    this.time = options.time ?? productionTime;
    this.groups = new Map(
      Object.entries(options.resourceGroups).map(([name, limit]) => {
        if (
          !Number.isInteger(limit.maximumConcurrency) ||
          limit.maximumConcurrency < 1
        ) {
          throw new Error(
            `resource group ${name} maximumConcurrency must be a positive integer`,
          );
        }
        if (
          !Number.isFinite(limit.minimumStartIntervalMs) ||
          limit.minimumStartIntervalMs < 0
        ) {
          throw new Error(
            `resource group ${name} minimumStartIntervalMs must be non-negative`,
          );
        }
        return [name, { limit, active: 0, lastStartedAt: undefined }];
      }),
    );
  }

  public async map<T, R>(
    items: readonly ScheduledItem<T>[],
    mapper: (value: T, index: number) => Promise<R>,
  ): Promise<R[]> {
    for (const item of items) {
      if (item.resourceGroup !== undefined && !this.groups.has(item.resourceGroup)) {
        throw new Error(`unknown resource group: ${item.resourceGroup}`);
      }
    }
    const results: R[] = new Array(items.length);
    const errors: Array<{ index: number; error: unknown }> = [];
    const admitted = new Set<number>();
    let active = 0;
    let dispatching = false;
    let dispatchAgain = false;
    let resolveDone: (() => void) | undefined;
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    const dispatch = async (): Promise<void> => {
      if (dispatching) {
        dispatchAgain = true;
        return;
      }
      dispatching = true;
      try {
        while (admitted.size < items.length && active < this.globalMaximumConcurrency) {
          let selectedIndex: number | undefined;
          let selectedGroup: GroupState | undefined;
          let waitedForHead = false;
          for (let index = 0; index < items.length; index += 1) {
            if (admitted.has(index)) continue;
            const item = items[index]!;
            let group: GroupState | undefined;
            if (item.resourceGroup !== undefined) {
              group = this.groups.get(item.resourceGroup);
              if (group === undefined) {
                throw new Error(`unknown resource group: ${item.resourceGroup}`);
              }
              if (group.active >= group.limit.maximumConcurrency) break;
              const earliest =
                group.lastStartedAt === undefined
                  ? this.time.nowMs()
                  : group.lastStartedAt + group.limit.minimumStartIntervalMs;
              const delay = earliest - this.time.nowMs();
              if (delay > 0) {
                await this.time.wait(delay);
                waitedForHead = true;
                break;
              }
            }
            selectedIndex = index;
            selectedGroup = group;
            break;
          }
          if (selectedIndex === undefined) {
            if (waitedForHead) continue;
            break;
          }
          const index = selectedIndex;
          const item = items[index]!;
          const group = selectedGroup;
          admitted.add(index);
          active += 1;
          if (group !== undefined) {
            group.active += 1;
            group.lastStartedAt = this.time.nowMs();
          }
          let mapped: Promise<R>;
          try {
            mapped = mapper(item.value, index);
          } catch (error: unknown) {
            mapped = Promise.reject(error);
          }
          void mapped
            .then(
              (value) => {
                results[index] = value;
              },
              (error: unknown) => {
                errors.push({ index, error });
              },
            )
            .finally(() => {
              active -= 1;
              if (group !== undefined) group.active -= 1;
              void dispatch();
              if (admitted.size >= items.length && active === 0) resolveDone?.();
            });
        }
      } finally {
        dispatching = false;
        if (dispatchAgain) {
          dispatchAgain = false;
          void dispatch();
        }
      }
      if (admitted.size >= items.length && active === 0) resolveDone?.();
    };

    await dispatch();
    await done;
    if (errors.length > 0) {
      errors.sort((left, right) => left.index - right.index);
      throw errors[0]!.error;
    }
    return results;
  }
}
