import { useState } from 'react';
import type { SystemState } from '../../../src/protocol/state.ts';
import {
  TOPOLOGY_PRESETS,
  zoneCount,
  validateTopology,
  newGroup,
  type ChannelFormat,
  type OutputGroup,
  type OutputRole,
} from '../../../src/system/topology.ts';
import {
  activeDesks,
  deskInputWidth,
  validateDesks,
  type Desk,
  type FeedSource,
} from '../../../src/system/desks.ts';
import { resolveRouting } from '../../../src/system/routing.ts';
import type { Command } from '../lib/system.ts';

interface Props {
  state: SystemState;
  send: (command: Command) => void;
}

const ROLES: OutputRole[] = ['main', 'sub', 'frontfill', 'delay', 'other'];
const SOURCES: FeedSource[] = ['direct', 'derived', 'none'];

/**
 * The system design screen, and the one an operator actually lives on during a
 * changeover: pick the output topology once, describe each console once, then
 * switch desks in and out from the row at the top.
 */
export function System({ state, send }: Props) {
  const [editingDeskId, setEditingDeskId] = useState<string | null>(null);

  const live = activeDesks(state.desks);
  const liveIds = new Set(live.map((d) => d.id));
  const resolved = resolveRouting(state.topology, state.desks);
  const problems = [
    ...validateTopology(state.topology, state.model),
    ...validateDesks(state.desks, state.model),
  ];

  const editing = state.desks.desks.find((d) => d.id === editingDeskId) ?? null;

  const updateGroups = (groups: OutputGroup[]) => send({ type: 'setTopologyGroups', groups });

  return (
    <div className="grid" style={{ gap: 16 }}>
      {/* ---------------------------------------------------------- live */}
      <div className="panel">
        <h2 className="panel-title">Live consoles</h2>

        <div className="desk-row">
          {state.desks.desks.map((desk) => {
            const isProduction = desk.role === 'production';
            const isLive = liveIds.has(desk.id);
            return (
              <button
                key={desk.id}
                className={`desk-chip${isLive ? ' live' : ''}${isProduction ? ' production' : ''}`}
                onClick={() => !isProduction && send({ type: 'toggleSecondary', id: desk.id })}
                title={isProduction ? 'The production console is always live' : 'Switch this console in or out'}
              >
                <span className="desk-name">{desk.name}</span>
                <span className="desk-meta">
                  {isProduction ? 'always live' : isLive ? 'live' : 'off'} · {deskInputWidth(desk)} in
                </span>
              </button>
            );
          })}

          {state.desks.desks.length === 0 && (
            <span style={{ color: 'var(--text-faint)' }}>No consoles defined yet.</span>
          )}
        </div>

        <div className="toolbar" style={{ marginTop: 12, marginBottom: 0 }}>
          <div className="tabs">
            {(['single', 'multi'] as const).map((mode) => (
              <button
                key={mode}
                className="tab"
                aria-selected={state.desks.selectMode === mode}
                onClick={() => send({ type: 'setSelectMode', mode })}
              >
                {mode === 'single' ? 'One at a time' : 'Several at once'}
              </button>
            ))}
          </div>

          <span className="spacer" />

          <label className="field">
            <label htmlFor="summing">Mono sum</label>
            <input
              id="summing"
              type="number"
              min={-12}
              max={0}
              step={0.5}
              value={state.desks.summingGainDb}
              onChange={(e) => send({ type: 'setSummingGain', db: Number(e.target.value) })}
            />
            <span style={{ color: 'var(--text-faint)' }}>dB per leg</span>
          </label>

          <button className="btn" onClick={() => send({ type: 'addDesk' })}>
            Add console
          </button>
        </div>
      </div>

      {problems.length > 0 && (
        <div className="note" style={{ borderLeftColor: 'var(--bad)' }}>
          {problems.map((p) => (
            <div key={p}>{p}</div>
          ))}
        </div>
      )}

      {state.routingWarnings.length > 0 && (
        <div className="note" style={{ borderLeftColor: 'var(--warn)' }}>
          {state.routingWarnings.map((w) => (
            <div key={w}>{w}</div>
          ))}
        </div>
      )}

      {/* ------------------------------------------------------ topology */}
      <div className="panel">
        <h2 className="panel-title">Output topology</h2>

        <div className="preset-row">
          {TOPOLOGY_PRESETS.map((preset) => (
            <button
              key={preset.id}
              className="topo-preset"
              aria-selected={state.topology.preset === preset.id}
              onClick={() => send({ type: 'setTopologyPreset', preset: preset.id })}
            >
              <span className="nm">{preset.name}</span>
              <span className="desc">{preset.description}</span>
            </button>
          ))}
        </div>

        <table className="band-table" style={{ marginTop: 12 }}>
          <thead>
            <tr>
              <th style={{ width: 180 }}>Group</th>
              <th style={{ width: 110 }}>Role</th>
              <th style={{ width: 100 }}>Format</th>
              <th style={{ width: 110 }}>Zones</th>
              <th style={{ width: 40 }} />
            </tr>
          </thead>
          <tbody>
            {state.topology.groups.map((group, i) => (
              <tr key={group.id}>
                <td>
                  <input
                    type="text"
                    value={group.name}
                    onChange={(e) =>
                      updateGroups(
                        state.topology.groups.map((g, j) => (i === j ? { ...g, name: e.target.value } : g)),
                      )
                    }
                  />
                </td>
                <td>
                  <select
                    value={group.role}
                    onChange={(e) =>
                      updateGroups(
                        state.topology.groups.map((g, j) =>
                          i === j ? { ...g, role: e.target.value as OutputRole } : g,
                        ),
                      )
                    }
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <select
                    value={group.format}
                    onChange={(e) =>
                      updateGroups(
                        state.topology.groups.map((g, j) =>
                          i === j ? { ...g, format: e.target.value as ChannelFormat } : g,
                        ),
                      )
                    }
                  >
                    <option value="mono">mono</option>
                    <option value="stereo">stereo</option>
                  </select>
                </td>
                <td className="mono" style={{ color: 'var(--text-dim)' }}>
                  {group.zones.join(', ') || '—'}
                </td>
                <td>
                  <button
                    className="btn"
                    style={{ padding: '2px 8px' }}
                    onClick={() => updateGroups(state.topology.groups.filter((_, j) => j !== i))}
                    aria-label={`remove ${group.name}`}
                  >
                    ×
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <button
          className="btn"
          style={{ marginTop: 8 }}
          onClick={() => updateGroups([...state.topology.groups, newGroup(state.topology)])}
        >
          Add output group
        </button>
      </div>

      {/* --------------------------------------------------------- desks */}
      <div className="panel">
        <h2 className="panel-title">Console feeds</h2>

        <div className="tabs" style={{ marginBottom: 10, flexWrap: 'wrap' }}>
          {state.desks.desks.map((desk) => (
            <button
              key={desk.id}
              className="tab"
              aria-selected={editingDeskId === desk.id}
              onClick={() => setEditingDeskId(desk.id === editingDeskId ? null : desk.id)}
            >
              {desk.name}
            </button>
          ))}
        </div>

        {editing ? (
          <DeskEditor desk={editing} state={state} send={send} onRemove={() => setEditingDeskId(null)} />
        ) : (
          <div style={{ color: 'var(--text-faint)', fontSize: 13 }}>
            Pick a console to describe how it feeds the system.
          </div>
        )}
      </div>

      {/* ------------------------------------------------------ resolved */}
      <div className="panel">
        <h2 className="panel-title">Resolved routing — {resolved.crosspoints.length} crosspoints</h2>
        <table className="band-table">
          <thead>
            <tr>
              <th style={{ width: 160 }}>Console</th>
              <th style={{ width: 130 }}>Group</th>
              <th style={{ width: 100 }}>Input → Zone</th>
              <th style={{ width: 80 }}>Gain</th>
              <th>Compensation</th>
            </tr>
          </thead>
          <tbody>
            {resolved.crosspoints.map((point, i) => (
              <tr key={i}>
                <td>{point.deskName}</td>
                <td>{point.groupId}</td>
                <td className="mono">
                  {point.from.index} → {point.to.index}
                </td>
                <td className="mono">{point.gainDb === 0 ? '0.0' : point.gainDb.toFixed(1)} dB</td>
                <td style={{ color: point.note === 'direct' ? 'var(--text-faint)' : 'var(--local)' }}>
                  {point.note}
                </td>
              </tr>
            ))}
            {resolved.crosspoints.length === 0 && (
              <tr>
                <td colSpan={5} style={{ color: 'var(--text-faint)' }}>
                  Nothing routed yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DeskEditor({
  desk,
  state,
  send,
  onRemove,
}: {
  desk: Desk;
  state: SystemState;
  send: (command: Command) => void;
  onRemove: () => void;
}) {
  const update = (next: Desk) => send({ type: 'updateDesk', desk: next });

  return (
    <div className="grid" style={{ gap: 10 }}>
      <div className="toolbar" style={{ marginBottom: 0 }}>
        <input
          className="text-input"
          value={desk.name}
          onChange={(e) => update({ ...desk, name: e.target.value })}
          aria-label="console name"
        />

        <label className="field">
          <label htmlFor={`${desk.id}-role`}>Role</label>
          <select
            id={`${desk.id}-role`}
            className="text-input"
            value={desk.role}
            onChange={(e) => update({ ...desk, role: e.target.value as Desk['role'] })}
          >
            <option value="production">production (always live)</option>
            <option value="secondary">secondary (switched)</option>
          </select>
        </label>

        <label className="field">
          <label htmlFor={`${desk.id}-trim`}>Trim</label>
          <input
            id={`${desk.id}-trim`}
            type="number"
            min={-24}
            max={12}
            step={0.5}
            value={desk.trimDb}
            onChange={(e) => update({ ...desk, trimDb: Number(e.target.value) })}
          />
          <span style={{ color: 'var(--text-faint)' }}>dB</span>
        </label>

        <span className="spacer" />

        <button
          className="btn"
          onClick={() => {
            send({ type: 'removeDesk', id: desk.id });
            onRemove();
          }}
        >
          Remove console
        </button>
      </div>

      <table className="band-table">
        <thead>
          <tr>
            <th style={{ width: 130 }}>Output group</th>
            <th style={{ width: 110 }}>Desk sends</th>
            <th style={{ width: 100 }}>Format</th>
            <th style={{ width: 130 }}>Derive from</th>
            <th style={{ width: 90 }}>Trim</th>
            <th style={{ width: 90 }}>Inputs</th>
          </tr>
        </thead>
        <tbody>
          {state.topology.groups.map((group) => {
            const feed = desk.feeds.find((f) => f.groupId === group.id);
            if (!feed) return null;

            const setFeed = (patch: Partial<typeof feed>) =>
              update({
                ...desk,
                feeds: desk.feeds.map((f) => (f.groupId === group.id ? { ...f, ...patch } : f)),
              });

            const mismatch = feed.source !== 'none' && feed.format !== group.format;

            return (
              <tr key={group.id} className={feed.source === 'none' ? 'off' : ''}>
                <td>
                  {group.name}
                  <span className="mono" style={{ color: 'var(--text-faint)', marginLeft: 6 }}>
                    {group.format === 'stereo' ? 'st' : 'mono'}
                  </span>
                </td>
                <td>
                  <select
                    value={feed.source}
                    onChange={(e) => setFeed({ source: e.target.value as FeedSource })}
                  >
                    {SOURCES.map((s) => (
                      <option key={s} value={s}>
                        {s === 'direct' ? 'its own output' : s === 'derived' ? 'derive' : 'nothing'}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <select
                    value={feed.format}
                    onChange={(e) => setFeed({ format: e.target.value as ChannelFormat })}
                    style={mismatch ? { borderColor: 'var(--local)' } : undefined}
                    title={mismatch ? 'Differs from the output group — will be compensated' : ''}
                  >
                    <option value="mono">mono</option>
                    <option value="stereo">stereo</option>
                  </select>
                </td>
                <td>
                  {feed.source === 'derived' ? (
                    <select
                      value={feed.deriveFrom ?? ''}
                      onChange={(e) => setFeed({ deriveFrom: e.target.value })}
                    >
                      <option value="">—</option>
                      {state.topology.groups
                        .filter((g) => g.id !== group.id)
                        .map((g) => (
                          <option key={g.id} value={g.id}>
                            {g.name}
                          </option>
                        ))}
                    </select>
                  ) : (
                    <span style={{ color: 'var(--text-faint)' }}>—</span>
                  )}
                </td>
                <td>
                  <input
                    type="number"
                    min={-24}
                    max={12}
                    step={0.5}
                    value={feed.trimDb}
                    onChange={(e) => setFeed({ trimDb: Number(e.target.value) })}
                  />
                </td>
                <td className="mono" style={{ color: 'var(--text-dim)' }}>
                  {feed.inputs.join(', ') || '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>
        {zoneCount(state.topology.groups[0]?.format ?? 'mono') > 0 && (
          <>
            A format that differs from the output group is compensated automatically: stereo into a
            mono group is summed at {state.desks.summingGainDb} dB per leg, mono into a stereo group
            feeds both sides at unity. “Derive” takes another group's feed — pick Mains on a console
            with no sub send and the subs get a mono mixdown, or stereo L/R if the sub group is
            itself stereo.
          </>
        )}
      </div>
    </div>
  );
}
