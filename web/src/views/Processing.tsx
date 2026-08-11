import { useMemo, useState } from 'react';
import type { FilterType, PeqBand, SystemState, ZoneProcessing } from '../../../src/protocol/state.ts';
import { combinedResponse, logFrequencies, msToMetres, metresToMs } from '../../../src/dsp/biquad.ts';
import type { Command } from '../lib/system.ts';

interface Props {
  state: SystemState;
  send: (command: Command) => void;
}

const CURVE_POINTS = 240;
const DB_RANGE = 18;
const BAND_COLOURS = ['#3da9fc', '#4ec9a0', '#e0a33e', '#e5544b', '#a877e0', '#48c6d6', '#d67ab1', '#8fbf5a'];
const FILTER_TYPES: FilterType[] = ['bell', 'lowShelf', 'highShelf', 'highPass', 'lowPass'];
const GRID_FREQUENCIES = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];

const WIDTH = 900;
const HEIGHT = 260;
const PAD_L = 40;
const PAD_R = 12;
const PAD_Y = 14;

/**
 * Per-output processing: PEQ, delay, dynamics.
 *
 * Every value here is held by this app alone. The published AHM protocol has no
 * message for any of it, so nothing on this screen is sent to the unit and the
 * banner says so. The curve is drawn from this app's own filter model -- it is a
 * picture of the numbers in the editor, not a prediction of the AHM's output.
 */
export function Processing({ state, send }: Props) {
  const [groupId, setGroupId] = useState<string | null>(null);

  // Default to the first group rather than pinning one at mount: the topology
  // can change under us, and a stale id would show an empty screen.
  const group =
    state.topology.groups.find((g) => g.id === groupId) ?? state.topology.groups[0] ?? null;

  // A stereo group's zones are edited as one, so the first zone is the editable
  // copy and every zone in the group receives the write.
  const processing = group ? state.processing[group.zones[0]] : undefined;

  const frequencies = useMemo(() => logFrequencies(CURVE_POINTS), []);
  const curve = useMemo(
    () => (processing ? combinedResponse(processing.peq, frequencies) : []),
    [processing, frequencies],
  );

  if (!group || !processing) {
    return <div className="empty">No output groups yet — define the topology on the System tab.</div>;
  }

  const update = (patch: Partial<ZoneProcessing>) =>
    send({ type: 'setGroupProcessing', group: group.id, processing: patch });

  const updateBand = (bandIndex: number, patch: Partial<PeqBand>) => {
    const peq = processing.peq.map((band, i) => (i === bandIndex ? { ...band, ...patch } : band));
    update({ peq });
  };

  const xFor = (hz: number) => {
    const t = (Math.log10(hz) - Math.log10(20)) / (Math.log10(20000) - Math.log10(20));
    return PAD_L + t * (WIDTH - PAD_L - PAD_R);
  };
  const yFor = (db: number) =>
    PAD_Y + ((DB_RANGE - db) / (DB_RANGE * 2)) * (HEIGHT - PAD_Y * 2);

  const path = curve
    .map((db, i) => `${i === 0 ? 'M' : 'L'}${xFor(frequencies[i]).toFixed(1)} ${yFor(db).toFixed(1)}`)
    .join(' ');

  return (
    <div className="proc-layout">
      <div className="panel">
        <h2 className="panel-title">Output groups</h2>
        <div className="zone-picker">
          {state.topology.groups.map((g) => (
            <button
              key={g.id}
              className="zone-btn"
              aria-selected={g.id === group.id}
              onClick={() => setGroupId(g.id)}
            >
              <span className="n">{g.zones.join('/')}</span>
              <span>{g.name}</span>
              <span className="spacer" />
              <span className="n">{g.format === 'stereo' ? 'st' : 'mono'}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="proc-main">
        <div className="note">
          <strong>Not sent to the unit.</strong> The published AHM control protocol carries levels,
          mutes, routing, source selection and preset recall — it has no message for EQ, delay or
          dynamics. These values live in this app only, and the curve is drawn from this app's filter
          model rather than the AHM's.
        </div>

        <div className="panel">
          <h2 className="panel-title">
            {group.name} — parametric EQ <span className="pill local">local</span>
            <span style={{ color: 'var(--text-faint)', fontWeight: 400, marginLeft: 8 }}>
              zone{group.zones.length > 1 ? 's' : ''} {group.zones.join(' + ')} · every live console
              routed here shares this processing
            </span>
          </h2>

          <svg className="eq-svg" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} preserveAspectRatio="none">
            {GRID_FREQUENCIES.map((hz) => (
              <g key={hz}>
                <line x1={xFor(hz)} x2={xFor(hz)} y1={PAD_Y} y2={HEIGHT - PAD_Y} stroke="var(--line)" />
                <text x={xFor(hz) + 3} y={HEIGHT - 3} fill="var(--text-faint)" fontSize="9">
                  {hz >= 1000 ? `${hz / 1000}k` : hz}
                </text>
              </g>
            ))}

            {[-12, -6, 0, 6, 12].map((db) => (
              <g key={db}>
                <line
                  x1={PAD_L}
                  x2={WIDTH - PAD_R}
                  y1={yFor(db)}
                  y2={yFor(db)}
                  stroke={db === 0 ? 'var(--line-bright)' : 'var(--line)'}
                />
                <text x={4} y={yFor(db) + 3} fill="var(--text-faint)" fontSize="9">
                  {db > 0 ? `+${db}` : db}
                </text>
              </g>
            ))}

            <path d={path} fill="none" stroke="var(--accent)" strokeWidth="2" />

            {processing.peq.map((band, i) =>
              band.enabled ? (
                <circle
                  key={i}
                  cx={xFor(band.frequency)}
                  cy={yFor(band.gain)}
                  r="5"
                  fill={BAND_COLOURS[i % BAND_COLOURS.length]}
                  stroke="var(--bg)"
                  strokeWidth="1.5"
                />
              ) : null,
            )}
          </svg>

          <table className="band-table">
            <thead>
              <tr>
                <th style={{ width: 46 }}>Band</th>
                <th style={{ width: 96 }}>Type</th>
                <th style={{ width: 92 }}>Freq (Hz)</th>
                <th style={{ width: 84 }}>Gain (dB)</th>
                <th style={{ width: 74 }}>Q</th>
                <th style={{ width: 44 }}>On</th>
              </tr>
            </thead>
            <tbody>
              {processing.peq.map((band, i) => (
                <tr key={i} className={band.enabled ? '' : 'off'}>
                  <td>
                    <span
                      className="swatch"
                      style={{ background: BAND_COLOURS[i % BAND_COLOURS.length] }}
                    />{' '}
                    <span className="mono">{i + 1}</span>
                  </td>
                  <td>
                    <select
                      value={band.type}
                      onChange={(e) => updateBand(i, { type: e.target.value as FilterType })}
                    >
                      {FILTER_TYPES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      type="number"
                      min={20}
                      max={20000}
                      step={1}
                      value={Math.round(band.frequency)}
                      onChange={(e) => updateBand(i, { frequency: Number(e.target.value) })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min={-18}
                      max={18}
                      step={0.5}
                      value={band.gain}
                      onChange={(e) => updateBand(i, { gain: Number(e.target.value) })}
                    />
                  </td>
                  <td>
                    <input
                      type="number"
                      min={0.1}
                      max={20}
                      step={0.1}
                      value={band.q}
                      onChange={(e) => updateBand(i, { q: Number(e.target.value) })}
                    />
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={band.enabled}
                      onChange={(e) => updateBand(i, { enabled: e.target.checked })}
                      aria-label={`band ${i + 1} enabled`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="grid" style={{ gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
          <div className="panel">
            <h2 className="panel-title">Delay</h2>
            <div className="grid" style={{ gap: 8 }}>
              <div className="field">
                <label htmlFor="delay-ms">Time</label>
                <input
                  id="delay-ms"
                  type="number"
                  min={0}
                  max={1000}
                  step={0.1}
                  value={processing.delay.milliseconds}
                  onChange={(e) =>
                    update({ delay: { ...processing.delay, milliseconds: Number(e.target.value) } })
                  }
                />
                <span style={{ color: 'var(--text-faint)' }}>ms</span>
              </div>
              <div className="field">
                <label htmlFor="delay-m">Distance</label>
                <input
                  id="delay-m"
                  type="number"
                  min={0}
                  step={0.01}
                  value={msToMetres(processing.delay.milliseconds).toFixed(2)}
                  onChange={(e) =>
                    update({
                      delay: {
                        ...processing.delay,
                        milliseconds: Number(metresToMs(Number(e.target.value)).toFixed(3)),
                      },
                    })
                  }
                />
                <span style={{ color: 'var(--text-faint)' }}>m</span>
              </div>
              <label className="field">
                <input
                  type="checkbox"
                  checked={processing.delay.enabled}
                  onChange={(e) => update({ delay: { ...processing.delay, enabled: e.target.checked } })}
                />
                <span>Enabled</span>
              </label>
            </div>
          </div>

          <DynamicsPanel
            title="Compressor"
            value={processing.compressor}
            onChange={(compressor) => update({ compressor })}
          />
          <DynamicsPanel
            title="Limiter"
            value={processing.limiter}
            onChange={(limiter) => update({ limiter })}
          />
        </div>
      </div>
    </div>
  );
}

function DynamicsPanel({
  title,
  value,
  onChange,
}: {
  title: string;
  value: ZoneProcessing['compressor'];
  onChange: (next: ZoneProcessing['compressor']) => void;
}) {
  const id = title.toLowerCase();
  return (
    <div className="panel">
      <h2 className="panel-title">{title}</h2>
      <div className="grid" style={{ gap: 8 }}>
        <div className="field">
          <label htmlFor={`${id}-th`}>Threshold</label>
          <input
            id={`${id}-th`}
            type="number"
            min={-60}
            max={20}
            step={0.5}
            value={value.threshold}
            onChange={(e) => onChange({ ...value, threshold: Number(e.target.value) })}
          />
          <span style={{ color: 'var(--text-faint)' }}>dB</span>
        </div>
        <div className="field">
          <label htmlFor={`${id}-ratio`}>Ratio</label>
          <input
            id={`${id}-ratio`}
            type="number"
            min={1}
            max={60}
            step={0.1}
            value={value.ratio}
            onChange={(e) => onChange({ ...value, ratio: Number(e.target.value) })}
          />
          <span style={{ color: 'var(--text-faint)' }}>:1</span>
        </div>
        <div className="field">
          <label htmlFor={`${id}-atk`}>Attack</label>
          <input
            id={`${id}-atk`}
            type="number"
            min={0.1}
            max={200}
            step={0.1}
            value={value.attack}
            onChange={(e) => onChange({ ...value, attack: Number(e.target.value) })}
          />
          <span style={{ color: 'var(--text-faint)' }}>ms</span>
        </div>
        <div className="field">
          <label htmlFor={`${id}-rel`}>Release</label>
          <input
            id={`${id}-rel`}
            type="number"
            min={1}
            max={2000}
            step={1}
            value={value.release}
            onChange={(e) => onChange({ ...value, release: Number(e.target.value) })}
          />
          <span style={{ color: 'var(--text-faint)' }}>ms</span>
        </div>
        <label className="field">
          <input
            type="checkbox"
            checked={value.enabled}
            onChange={(e) => onChange({ ...value, enabled: e.target.checked })}
          />
          <span>Enabled</span>
        </label>
      </div>
    </div>
  );
}
