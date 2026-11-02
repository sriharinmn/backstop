// The event this browser has cancelled and now owns. With none, a visitor lands on an untouched event.

const KEY = 'backstop-event';

// Some private windows block storage, so the open page remembers it too.
let memory: string | null = null;

export function myEvent(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return memory;
  }
}

export function setMyEvent(eventId: string | null) {
  memory = eventId;
  try {
    if (eventId) localStorage.setItem(KEY, eventId);
    else localStorage.removeItem(KEY);
  } catch {
    // Blocked storage only means the event is forgotten when the page closes.
  }
}

export function snapshotUrl(eventId: string | null) {
  return eventId ? `/api/snapshot?event=${encodeURIComponent(eventId)}` : '/api/snapshot';
}
