'use client';

import { useState } from 'react';
import { useStudioApi } from './store';

const TABS = [
  { id: 'crisis', label: 'Overview' },
  { id: 'ledger', label: 'Ledger' },
];

export function SheetTabs() {
  const api = useStudioApi();
  const [selected, setSelected] = useState('crisis');

  function open(id: string) {
    if (!api) return;
    api.setState({ ...api.getState(), selectedPageId: id });
    setSelected(id);
  }

  return (
    <div className="sheet-tabs" role="tablist" aria-label="Dashboard pages">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={selected === tab.id}
          disabled={!api}
          onClick={() => open(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
