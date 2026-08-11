import { useState } from 'react';
import { crosspointKey, type SystemState } from '../../../src/protocol/state.ts';
import { formatLevel, dbToLevel } from '../../../src/protocol/levels.ts';
import { refId, type Command } from '../lib/system.ts';

interface Props {
  state: SystemState;
  send: (command: Command) => void;
}

type Source = 'input' | 'zone';

/**
 * The routing matrix: sources down the side, zones across the top.
 *
 * Click toggles a crosspoint between closed and the pinned level. Shift-click
 * toggles its mute, which is a distinct thing on this platform -- a muted
 * crosspoint keeps its level, so you can drop a feed and restore it exactly.
 */
export function Routing({ state, send }: Props) {
  const [sourceKind, setSourceKind] = useState<Source>('input');
  const [openDb, setOpenDb] = useState(0);

  const sources = sourceKind === 'input' ? state.inputs : state.zones;
  const openLevel = dbToLevel(openDb);

  const toggle = (fromId: string, toId: string, muted: boolean, level: number, shift: boolean) => {
    if (shift) {
      send({ type: 'setSendMute', from: fromId, to: toId, muted: !muted });
      return;
    }
    send({ type: 'setSendLevel', from: fromId, to: toId, level: level > 0 ? 0 : openLevel });
  };

  return (
    <div className="grid">
      <div className="toolbar">
        <div className="tabs">
          <button
            className="tab"
            aria-selected={sourceKind === 'input'}
            onClick={() => setSourceKind('input')}
          >
            Input → Zone
          </button>
          <button
            className="tab"
            aria-selected={sourceKind === 'zone'}
            onClick={() => setSourceKind('zone')}
          >
            Zone → Zone
          </button>
        </div>

        <span className="spacer" />

        <label className="field">
          <label htmlFor="openlevel">Open at</label>
          <input
            id="openlevel"
            type="number"
            min={-48}
            max={10}
            step={0.5}
            value={openDb}
            onChange={(e) => setOpenDb(Number(e.target.value))}
          />
          <span className="mono" style={{ color: 'var(--text-faint)' }}>
            dB · byte {openLevel}
          </span>
        </label>

        <span className="pill">shift-click = mute crosspoint</span>
      </div>

      <div className="panel" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="matrix-wrap">
          <table className="matrix">
            <thead>
              <tr>
                <th className="corner" style={{ position: 'sticky', left: 0 }}>
                  <span style={{ padding: '0 10px', color: 'var(--text-faint)', fontSize: 11 }}>
                    {sourceKind === 'input' ? 'INPUT' : 'ZONE'} ╲ ZONE
                  </span>
                </th>
                {state.zones.map((zone) => (
                  <th key={zone.index}>
                    <div className="vertical-label">
                      {String(zone.index).padStart(2, '0')} {zone.name}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sources.map((source) => {
                const fromId = refId(source);
                return (
                  <tr key={fromId}>
                    <th title={source.name}>
                      <span className="mono" style={{ color: 'var(--text-faint)', marginRight: 8 }}>
                        {String(source.index).padStart(2, '0')}
                      </span>
                      {source.name}
                    </th>

                    {state.zones.map((zone) => {
                      const toId = refId(zone);
                      // A zone cannot feed itself; the unit has no such crosspoint.
                      const isSelf = sourceKind === 'zone' && zone.index === source.index;
                      const point = state.sends[crosspointKey(source, zone)];
                      const level = point?.level ?? 0;
                      const muted = point?.muted ?? false;
                      const open = level > 0;

                      if (isSelf) {
                        return (
                          <td key={toId}>
                            <div
                              className="cell"
                              style={{ background: 'var(--panel-2)', cursor: 'default' }}
                            />
                          </td>
                        );
                      }

                      return (
                        <td key={toId}>
                          <button
                            className="cell"
                            title={`${source.name} → ${zone.name}\n${
                              open ? formatLevel(level) : 'closed'
                            }${muted ? ' (muted)' : ''}`}
                            onClick={(e) => toggle(fromId, toId, muted, level, e.shiftKey)}
                            aria-label={`${source.name} to ${zone.name}`}
                          >
                            {open && (
                              <span
                                className={`cell-fill${muted ? ' muted' : ''}`}
                                // Opacity tracks level, so a matrix reads at a glance.
                                style={{ opacity: 0.25 + (level / 127) * 0.75 }}
                              />
                            )}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
