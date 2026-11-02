// Charts the agent can add. Studio's own add_widget places an empty widget, and reports success even
// when the position overlaps another widget and fails to render. These are complete, valid, and placed
// by code, and the tool only reports success after checking the chart is really on the dashboard.

type Box = { xTrack: number; yTrack: number; xSpan: number; ySpan: number };

// The report's state, as far as this file needs it. Page layouts are extended by the agent at runtime.
type ReportPage = {
  id: string;
  widgets: Record<string, Record<string, unknown>>;
  widgetLayout: Record<string, Box>;
};
export type ReportState = { pages: ReportPage[]; selectedPageId?: string };

export const CHART_PRESETS = {
  attendees_by_status: {
    categoryKey: [{ id: 'attendees.status' }],
    valueKey: [{ id: 'attendees.attendee', aggregation: 'count' }],
  },
  money_by_status: {
    categoryKey: [{ id: 'attendees.status' }],
    valueKey: [{ id: 'attendees.paid', aggregation: 'sum' }],
  },
  vendors_owed: {
    categoryKey: [{ id: 'vendors.vendor' }],
    valueKey: [{ id: 'vendors.owed', aggregation: 'sum' }],
  },
} as const;

export type ChartPreset = keyof typeof CHART_PRESETS;

// The row the attendee list starts on. New charts go here and the list moves down.
const INSERT_AT = 25;
const CHART_HEIGHT = 12;

export function insertChart(state: ReportState, preset: ChartPreset, title: string, id: string): ReportState {
  const mapping = CHART_PRESETS[preset];
  if (!mapping) throw new Error(`Unknown chart preset: ${String(preset)}.`);

  const target = state.pages.find((page) => page.id === 'crisis') ?? state.pages[0];

  const widgetLayout: Record<string, Box> = {};
  for (const [key, box] of Object.entries(target.widgetLayout)) {
    widgetLayout[key] = box.yTrack >= INSERT_AT ? { ...box, yTrack: box.yTrack + CHART_HEIGHT } : box;
  }
  widgetLayout[id] = { xTrack: 0, yTrack: INSERT_AT, xSpan: 24, ySpan: CHART_HEIGHT };

  const widget = {
    type: 'bar-chart-grouped',
    format: { title: { enabled: true, text: title } },
    dataMapping: { categoryKey: [...mapping.categoryKey], valueKey: [...mapping.valueKey] },
  };

  return {
    ...state,
    pages: state.pages.map((page) =>
      page === target ? { ...page, widgets: { ...page.widgets, [id]: widget }, widgetLayout } : page,
    ),
  };
}

export function hasWidget(state: ReportState, id: string): boolean {
  return state.pages.some((page) => id in page.widgets && id in page.widgetLayout);
}

export function overlaps(layout: Record<string, Box>): [string, string][] {
  const entries = Object.entries(layout);
  const clashes: [string, string][] = [];

  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const [nameA, a] = entries[i];
      const [nameB, b] = entries[j];
      const apart =
        a.xTrack + a.xSpan <= b.xTrack ||
        b.xTrack + b.xSpan <= a.xTrack ||
        a.yTrack + a.ySpan <= b.yTrack ||
        b.yTrack + b.ySpan <= a.yTrack;
      if (!apart) clashes.push([nameA, nameB]);
    }
  }
  return clashes;
}
