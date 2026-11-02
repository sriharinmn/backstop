'use client';

// The latest snapshot, shared with widgets that AG Studio mounts outside this React tree's context.

import { useSyncExternalStore } from 'react';
import type { AgAiHarness } from 'ag-studio';
import type { Snapshot } from '@/lib/queries';

let current: Snapshot | null = null;
const listeners = new Set<() => void>();

export function publishSnapshot(snapshot: Snapshot) {
  current = snapshot;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function latestSnapshot(): Snapshot | null {
  return current;
}

export function useSnapshot(): Snapshot | null {
  return useSyncExternalStore(subscribe, () => current, () => null);
}

// The agent harness Studio builds, shared with the rail so the conversation can live beside the slips.
let harness: AgAiHarness | null = null;

export function publishHarness(next: AgAiHarness) {
  harness = next;
  for (const listener of listeners) listener();
}

export function useHarness(): AgAiHarness | null {
  return useSyncExternalStore(subscribe, () => harness, () => null);
}
