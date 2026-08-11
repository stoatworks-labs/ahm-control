import { formatLevel } from '../../../src/protocol/levels.ts';
import type { Strip } from '../../../src/protocol/state.ts';
import { refId, type Command } from '../lib/system.ts';

interface Props {
  strip: Strip;
  send: (command: Command) => void;
  selected?: boolean;
  onSelect?: () => void;
}

/**
 * One channel strip: index, editable name, fader, readout, mute.
 *
 * The readout turns amber while a value is 'pending' -- sent to the unit but not
 * yet echoed back. On a system processor it matters whether the number on screen
 * is what the box is actually doing.
 */
export function StripRow({ strip, send, selected, onSelect }: Props) {
  const id = refId(strip);

  return (
    <div className={`strip${selected ? ' selected' : ''}`} onClick={onSelect}>
      <span className="strip-index">{String(strip.index).padStart(2, '0')}</span>

      <input
        className="strip-name"
        value={strip.name}
        onChange={(e) => send({ type: 'rename', ref: id, name: e.target.value })}
        onClick={(e) => e.stopPropagation()}
        aria-label={`${strip.kind} ${strip.index} name`}
      />

      <input
        type="range"
        min={0}
        max={127}
        value={strip.level}
        onChange={(e) => send({ type: 'setLevel', ref: id, level: Number(e.target.value) })}
        onClick={(e) => e.stopPropagation()}
        aria-label={`${strip.name} level`}
      />

      <span className={`strip-db${strip.origin === 'pending' ? ' pending' : ''}`}>
        {formatLevel(strip.level)}
      </span>

      <button
        className={`mute${strip.muted ? ' on' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          send({ type: 'setMute', ref: id, muted: !strip.muted });
        }}
        aria-pressed={strip.muted}
      >
        MUTE
      </button>
    </div>
  );
}
