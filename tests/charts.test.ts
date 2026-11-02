import { describe, expect, it } from 'vitest';
import { hasWidget, insertChart, overlaps } from '@/app/command/studio/charts';
import { initialReport } from '@/app/command/studio/report';

const state = () => JSON.parse(JSON.stringify(initialReport));

describe('insertChart', () => {
  it('adds a chart with real data mapped to it', () => {
    const next = insertChart(state(), 'attendees_by_status', 'Where attendees stand', 'chart-1');
    const page = next.pages[0];

    expect(page.widgets['chart-1'].dataMapping).toEqual({
      categoryKey: [{ id: 'attendees.status' }],
      valueKey: [{ id: 'attendees.attendee', aggregation: 'count' }],
    });
    expect(page.widgets['chart-1'].format).toEqual({ title: { enabled: true, text: 'Where attendees stand' } });
  });

  it('never overlaps a widget, because Studio refuses to render an overlap', () => {
    const next = insertChart(state(), 'money_by_status', 'Money', 'chart-1');
    expect(overlaps(next.pages[0].widgetLayout)).toEqual([]);
  });

  it('stays clear of overlaps when the agent adds several charts', () => {
    let next = state();
    for (const id of ['a', 'b', 'c']) next = insertChart(next, 'vendors_owed', id, id);

    expect(overlaps(next.pages[0].widgetLayout)).toEqual([]);
    expect(Object.keys(next.pages[0].widgetLayout)).toEqual(expect.arrayContaining(['a', 'b', 'c']));
  });

  it('puts the chart above the attendee list, so the organizer can see it', () => {
    const before = state().pages[0].widgetLayout.attendees.yTrack;
    const next = insertChart(state(), 'vendors_owed', 'Vendors', 'chart-1');
    const layout = next.pages[0].widgetLayout;

    expect(layout['chart-1'].yTrack).toBe(before);
    expect(layout.attendees.yTrack).toBeGreaterThan(before);
  });

  it('leaves the other pages and the input alone', () => {
    const input = state();
    const next = insertChart(input, 'vendors_owed', 'Vendors', 'chart-1');

    expect(next.pages[1]).toEqual(input.pages[1]);
    expect(input.pages[0].widgets['chart-1']).toBeUndefined();
  });

  it('rejects a preset it does not know', () => {
    expect(() => insertChart(state(), 'nonsense' as never, 'x', 'chart-1')).toThrow(/preset/i);
  });
});

describe('hasWidget', () => {
  it('confirms a widget is really on the dashboard', () => {
    const next = insertChart(state(), 'vendors_owed', 'Vendors', 'chart-1');

    expect(hasWidget(next, 'chart-1')).toBe(true);
    expect(hasWidget(next, 'missing')).toBe(false);
  });
});

describe('overlaps', () => {
  it('finds two widgets sharing a space', () => {
    expect(
      overlaps({
        a: { xTrack: 0, yTrack: 0, xSpan: 4, ySpan: 3 },
        b: { xTrack: 3, yTrack: 2, xSpan: 4, ySpan: 3 },
      }),
    ).toEqual([['a', 'b']]);
  });

  it('allows widgets that only touch', () => {
    expect(
      overlaps({
        a: { xTrack: 0, yTrack: 0, xSpan: 4, ySpan: 3 },
        b: { xTrack: 4, yTrack: 0, xSpan: 4, ySpan: 3 },
      }),
    ).toEqual([]);
  });
});
