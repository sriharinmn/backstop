import { createWidgets } from 'ag-studio-react';
import { CashPosition } from './cash-position';
import { ChargebackClock } from './chargeback-clock';

const ICON =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect x="1.5" y="3" width="13" height="10" fill="none" stroke="#1f2a7a" stroke-width="1.5"/></svg>',
  );

const custom = [
  {
    id: 'cash-position',
    label: 'What you can cover',
    comp: CashPosition,
    defaultSize: { width: 500, height: 240 },
    ai: { description: 'Bar showing money paid out, money covered by cash, and the shortfall.' },
  },
  {
    id: 'chargeback-clock',
    label: 'Chargebacks',
    comp: ChargebackClock,
    defaultSize: { width: 500, height: 240 },
    ai: { description: 'Open chargebacks with days left to answer each one.' },
  },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const widgets = (config: any) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (createWidgets as any)({
    additionalTypes: custom.map((widget) => ({
      ...widget,
      icon: { url: ICON },
      dataMapping: {},
      form: (params: { createDefaults: (options: { dataMappingItems: never[] }) => unknown }) =>
        params.createDefaults({ dataMappingItems: [] }),
      minSize: { width: 240, height: 120 },
    })),
    menu: [...config.menu, { label: 'Backstop', widgetIds: custom.map((widget) => widget.id) }],
  });
