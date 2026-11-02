import { afterEach, describe, expect, it, vi } from 'vitest';
import { myEvent, setMyEvent, snapshotUrl } from '@/app/command/my-event';

afterEach(() => {
  setMyEvent(null);
  vi.unstubAllGlobals();
});

describe('the event this browser owns', () => {
  it('starts with none, so a new visitor lands on an untouched event', () => {
    expect(myEvent()).toBeNull();
    expect(snapshotUrl(null)).toBe('/api/snapshot');
  });

  it('asks for the owned event once there is one', () => {
    expect(snapshotUrl('abc 1')).toBe('/api/snapshot?event=abc%201');
  });

  it('remembers the event and can let it go', () => {
    setMyEvent('abc');
    expect(myEvent()).toBe('abc');

    setMyEvent(null);
    expect(myEvent()).toBeNull();
  });

  it('reads the event back after a reload', () => {
    const saved = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => saved.get(key) ?? null,
      setItem: (key: string, value: string) => saved.set(key, value),
      removeItem: (key: string) => saved.delete(key),
    });

    setMyEvent('abc');

    expect([...saved.values()]).toEqual(['abc']);
  });

  it('still works this session when the browser blocks storage', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('Blocked');
      },
      setItem: () => {
        throw new Error('Blocked');
      },
      removeItem: () => {
        throw new Error('Blocked');
      },
    });

    setMyEvent('abc');

    expect(myEvent()).toBe('abc');
  });
});
