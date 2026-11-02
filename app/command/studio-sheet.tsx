'use client';

import { useEffect, useMemo } from 'react';
import { AgStudioAiModule, type AgAiHarness, type AgStudioApi } from 'ag-studio';
import { AgStudio, AgStudioProvider } from 'ag-studio-react';
import type { Snapshot } from '@/lib/queries';
import { publishHarness, publishSnapshot, publishStudioApi } from './store';
import { buildAgent } from './studio/agent';
import { buildStudioData } from './studio/data';
import { initialReport } from './studio/report';
import { formTheme } from './studio/theme';
import { widgets } from './widgets';

// The report holds custom widget types, which Studio's default registry type does not know about.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Studio = AgStudio as any;

// Studio builds its harness lazily for its own chat panel, which view mode does not show.
// The rail needs the agent straight away, so build it once per Studio instance and share it.
const agents = new WeakMap<AgStudioApi, AgAiHarness>();

function agentFor(api: AgStudioApi) {
  let harness = agents.get(api);
  if (!harness) {
    harness = buildAgent(api);
    agents.set(api, harness);
  }
  return harness;
}

const ai = ({ api }: { api: AgStudioApi }) => agentFor(api);

export default function StudioSheet({ snapshot, licenseKey }: { snapshot: Snapshot; licenseKey?: string }) {
  const data = useMemo(() => buildStudioData(snapshot), [snapshot]);

  useEffect(() => publishSnapshot(snapshot), [snapshot]);

  return (
    <AgStudioProvider licenseKey={licenseKey} modules={[AgStudioAiModule]}>
      <div style={{ position: 'absolute', inset: 0 }}>
        <Studio
          style={{ height: '100%', width: '100%' }}
          onStudioReady={(event: { api: AgStudioApi }) => {
            publishStudioApi(event.api);
            publishHarness(agentFor(event.api));
          }}
          data={data}
          initialState={initialReport}
          theme={formTheme}
          widgets={widgets}
          ai={ai}
          mode="view"
          panels={{ view: {} }}
        />
      </div>
    </AgStudioProvider>
  );
}
