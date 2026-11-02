const titled = (text: string) => ({ title: { enabled: true, text } });

// Custom widgets draw their own headings.
const noTitle = { title: { enabled: false } };

// Boxes on a pre-printed form: square, with a pale rule, and no page margin to waste.
const layout = {
  pagePadding: 10,
  widgetPadding: 12,
  widgetBorderEnabled: true,
  widgetBorderColor: '#b9beda',
  widgetBorderWidth: 1,
  widgetBorderRadius: 0,
};

export const initialReport = {
  pages: [
    {
      id: 'crisis',
      layout,
      widgets: {
        wave: {
          type: 'column-chart-grouped',
          format: titled('Refund requests since the announcement'),
          dataMapping: {
            categoryKey: [{ id: 'wave.after' }],
            valueKey: [{ id: 'wave.requests', aggregation: 'sum' }],
          },
        },
        cover: { type: 'cash-position', format: noTitle, dataMapping: {} },
        clock: { type: 'chargeback-clock', format: noTitle, dataMapping: {} },
        vendors: {
          type: 'grid',
          format: titled('Vendors'),
          dataMapping: {
            cols: [{ id: 'vendors.vendor' }, { id: 'vendors.for' }, { id: 'vendors.owed' }, { id: 'vendors.status' }],
          },
        },
        attendees: {
          type: 'grid',
          format: titled('Attendees'),
          dataMapping: {
            cols: [
              { id: 'attendees.attendee' },
              { id: 'attendees.status' },
              { id: 'attendees.paid' },
              { id: 'attendees.asked' },
            ],
          },
        },
      },
      widgetLayout: {
        cover: { xTrack: 0, yTrack: 0, xSpan: 12, ySpan: 13 },
        wave: { xTrack: 12, yTrack: 0, xSpan: 12, ySpan: 13 },
        clock: { xTrack: 0, yTrack: 13, xSpan: 12, ySpan: 12 },
        vendors: { xTrack: 12, yTrack: 13, xSpan: 12, ySpan: 12 },
        attendees: { xTrack: 0, yTrack: 25, xSpan: 24, ySpan: 22 },
      },
    },
    {
      id: 'ledger',
      layout,
      widgets: {
        ledger: {
          type: 'grid',
          format: titled('Every movement of money, and why'),
          dataMapping: {
            cols: [{ id: 'ledger.when' }, { id: 'ledger.what' }, { id: 'ledger.amount' }, { id: 'ledger.paypal' }],
          },
        },
      },
      widgetLayout: {
        ledger: { xTrack: 0, yTrack: 0, xSpan: 24, ySpan: 47 },
      },
    },
  ],
  selectedPageId: 'crisis',
};
