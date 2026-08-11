import { useRef, useState } from 'react';
import { useSystem, uploadConfig } from './lib/system.ts';
import { StripRow } from './components/Strip.tsx';
import { System } from './views/System.tsx';
import { Routing } from './views/Routing.tsx';
import { Processing } from './views/Processing.tsx';
import { Presets } from './views/Presets.tsx';

const TABS = ['System', 'Routing', 'Levels', 'Processing', 'Presets'] as const;
type Tab = (typeof TABS)[number];

export function App() {
  const { state, linkUp, send } = useSystem();
  const [tab, setTab] = useState<Tab>('System');
  const [host, setHost] = useState('');
  const [configInfo, setConfigInfo] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const onConfigChosen = async (file: File | undefined) => {
    if (!file) return;
    try {
      const info = await uploadConfig(file);
      setConfigInfo(`AHM-${info.model} · ${info.channelCount} ch · ${info.version}`);
    } catch (err) {
      setConfigInfo(`could not read: ${(err as Error).message}`);
    }
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          AHM Control<span>system processor</span>
        </div>

        <nav className="tabs" role="tablist">
          {TABS.map((name) => (
            <button
              key={name}
              className="tab"
              role="tab"
              aria-selected={tab === name}
              onClick={() => setTab(name)}
            >
              {name}
            </button>
          ))}
        </nav>

        <span className="spacer" />

        {state?.simulated && <span className="pill sim">simulator — no hardware</span>}
        {state?.configVersion && <span className="pill">{state.configVersion}</span>}

        <div className="status">
          <span className={`dot ${linkUp ? state?.status ?? 'disconnected' : 'error'}`} />
          <span className="mono" style={{ fontSize: 12 }}>
            {!linkUp
              ? 'server unreachable'
              : state
                ? `${state.status}${state.host ? ` · ${state.host}:${state.port}` : ''}`
                : 'starting'}
          </span>
        </div>

        <input
          className="text-input"
          style={{ width: 130 }}
          placeholder="AHM address"
          value={host}
          onChange={(e) => setHost(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && host.trim()) send({ type: 'connect', host: host.trim() });
          }}
        />
        <button
          className="btn primary"
          onClick={() => host.trim() && send({ type: 'connect', host: host.trim() })}
        >
          Connect
        </button>

        <button className="btn" onClick={() => fileRef.current?.click()} title={configInfo ?? ''}>
          Import .cfg
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".cfg"
          hidden
          onChange={(e) => onConfigChosen(e.target.files?.[0])}
        />
      </header>

      <main className="content">
        {!state ? (
          <div className="empty">Waiting for the local server…</div>
        ) : (
          <>
            {tab === 'System' && <System state={state} send={send} />}
            {tab === 'Routing' && <Routing state={state} send={send} />}
            {tab === 'Levels' && <Levels state={state} send={send} />}
            {tab === 'Processing' && <Processing state={state} send={send} />}
            {tab === 'Presets' && <Presets state={state} send={send} />}
          </>
        )}
      </main>
    </div>
  );
}

function Levels({
  state,
  send,
}: {
  state: NonNullable<ReturnType<typeof useSystem>['state']>;
  send: ReturnType<typeof useSystem>['send'];
}) {
  const groups = [
    { title: `Inputs — ${state.inputs.length}`, strips: state.inputs },
    { title: `Zones — ${state.zones.length}`, strips: state.zones },
    { title: `Control groups — ${state.controlGroups.length}`, strips: state.controlGroups },
  ];

  return (
    <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(420px, 1fr))' }}>
      {groups.map(({ title, strips }) => (
        <div key={title} className="panel">
          <h2 className="panel-title">{title}</h2>
          <div className="strip-list">
            {strips.map((strip) => (
              <StripRow key={`${strip.kind}:${strip.index}`} strip={strip} send={send} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
