import { useMemo } from 'react';
import type { SystemState } from '../../../src/protocol/state.ts';
import { crosspointKey } from '../../../src/protocol/state.ts';

interface Props {
  state: SystemState;
}

/**
 * System overview: sources on the left, the matrix in the middle, zones on the
 * right, with the counts that actually matter when you walk up to a rack.
 *
 * "Routed" counts a zone as fed if any crosspoint into it is open and unmuted.
 * Crosspoints the unit has never reported are absent from state.sends, so they
 * are counted as closed rather than assumed open.
 */
export function Topology({ state }: Props) {
  const summary = useMemo(() => {
    const feeds = new Map<number, number>();
    let openCrosspoints = 0;

    for (const [key, point] of Object.entries(state.sends)) {
      if (point.muted || point.level <= 0) continue;
      openCrosspoints++;
      const zoneIndex = Number(key.split('->zone:')[1]);
      if (Number.isFinite(zoneIndex)) {
        feeds.set(zoneIndex, (feeds.get(zoneIndex) ?? 0) + 1);
      }
    }

    return {
      openCrosspoints,
      feeds,
      fedZones: feeds.size,
      mutedInputs: state.inputs.filter((s) => s.muted).length,
      mutedZones: state.zones.filter((s) => s.muted).length,
    };
  }, [state.sends, state.inputs, state.zones]);

  return (
    <div className="grid" style={{ gap: 16 }}>
      <div className="topology">
        <div className="panel">
          <h2 className="panel-title">Inputs — {state.inputs.length}</h2>
          <div className="io-list">
            {state.inputs.map((input) => (
              <div key={input.index} className={`io-chip${input.muted ? ' muted' : ''}`}>
                <span className="n">{String(input.index).padStart(2, '0')}</span>
                <span>{input.name}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="grid">
          <div className="flow-node">
            <div className="cap">AHM-{state.model}</div>
            <div className="big">
              {state.inputs.length}&thinsp;&times;&thinsp;{state.zones.length}
            </div>
            <div className="cap">matrix</div>
          </div>

          <div className="flow-node">
            <div className="big">{summary.openCrosspoints}</div>
            <div className="cap">open crosspoints</div>
          </div>

          <div className="flow-node">
            <div className="big">
              {summary.fedZones}
              <span style={{ color: 'var(--text-faint)', fontSize: 18 }}>/{state.zones.length}</span>
            </div>
            <div className="cap">zones fed</div>
          </div>

          {(summary.mutedInputs > 0 || summary.mutedZones > 0) && (
            <div className="flow-node" style={{ borderColor: 'var(--bad)' }}>
              <div className="cap">muted</div>
              <div style={{ fontSize: 13 }}>
                {summary.mutedInputs} in · {summary.mutedZones} zone
              </div>
            </div>
          )}
        </div>

        <div className="panel">
          <h2 className="panel-title">Zones — {state.zones.length}</h2>
          <div className="io-list">
            {state.zones.map((zone) => {
              const feedCount = summary.feeds.get(zone.index) ?? 0;
              return (
                <div
                  key={zone.index}
                  className={`io-chip${zone.muted ? ' muted' : ''}`}
                  title={feedCount ? `${feedCount} source(s) routed` : 'no sources routed'}
                >
                  <span className="n">{String(zone.index).padStart(2, '0')}</span>
                  <span>{zone.name}</span>
                  <span className="n" style={{ color: feedCount ? 'var(--good)' : 'var(--text-faint)' }}>
                    {feedCount}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="note">
        Topology is drawn from the matrix state the unit reports plus the model size. Physical I/O
        cards, expander units and SLink devices are described in the System Manager file format,
        which is not decoded yet — import a <span className="mono">.cfg</span> to confirm the model
        and firmware version.
        {state.configVersion && (
          <>
            {' '}
            Imported: <span className="mono">{state.configVersion}</span>
          </>
        )}
      </div>
    </div>
  );
}

export { crosspointKey };
