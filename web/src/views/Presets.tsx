import { useState } from 'react';
import type { SystemState } from '../../../src/protocol/state.ts';
import { PRESET_COUNT, PRESET_BANK_SIZE } from '../../../src/protocol/messages.ts';
import type { Command } from '../lib/system.ts';

interface Props {
  state: SystemState;
  send: (command: Command) => void;
}

const BANKS = [0, 1, 2, 3];

/**
 * Preset recall. 500 presets in four banks of 128 -- the fourth is short, ending
 * at 500, and the grid must not offer 501..512 just because the bank is 128 wide.
 *
 * Preset NAMES are not readable over the published protocol, so they are held
 * locally and shown as editable labels. The unit echoes recalls, so the
 * highlighted preset is the unit's own, including recalls fired from a wall
 * plate or another controller.
 */
export function Presets({ state, send }: Props) {
  const [bank, setBank] = useState(0);
  const [confirm, setConfirm] = useState(true);

  const first = bank * PRESET_BANK_SIZE + 1;
  const last = Math.min(first + PRESET_BANK_SIZE - 1, PRESET_COUNT);
  const presets = Array.from({ length: last - first + 1 }, (_, i) => first + i);

  const recall = (preset: number) => {
    const name = state.presetNames[preset];
    if (confirm && !window.confirm(`Recall preset ${preset}${name ? ` — ${name}` : ''}?`)) return;
    send({ type: 'recallPreset', preset });
  };

  return (
    <div className="grid">
      <div className="toolbar">
        <div className="bank-tabs">
          {BANKS.map((b) => (
            <button key={b} className="tab" aria-selected={bank === b} onClick={() => setBank(b)}>
              Bank {b + 1}
              <span style={{ color: 'var(--text-faint)', marginLeft: 6, fontSize: 11 }}>
                {b * PRESET_BANK_SIZE + 1}–{Math.min((b + 1) * PRESET_BANK_SIZE, PRESET_COUNT)}
              </span>
            </button>
          ))}
        </div>

        <span className="spacer" />

        <label className="field">
          <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
          <span>Confirm before recall</span>
        </label>

        {state.currentPreset !== null && (
          <span className="pill" style={{ color: 'var(--good)', borderColor: 'var(--good)' }}>
            current: {state.currentPreset}
          </span>
        )}
      </div>

      <div className="panel">
        <div className="preset-grid">
          {presets.map((preset) => (
            <div
              key={preset}
              className={`preset${state.currentPreset === preset ? ' current' : ''}`}
            >
              <span className="n">{preset}</span>
              <input
                className="strip-name nm"
                value={state.presetNames[preset] ?? ''}
                placeholder="unnamed"
                onChange={(e) => send({ type: 'setPresetName', preset, name: e.target.value })}
                aria-label={`preset ${preset} name`}
              />
              <button className="btn" style={{ padding: '3px 8px' }} onClick={() => recall(preset)}>
                Recall
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className="note">
        Preset names are stored by this app — the published protocol can recall a preset and reports
        recalls made elsewhere, but cannot read back a preset's name or contents.
      </div>
    </div>
  );
}
