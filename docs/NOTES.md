# Notes

Working notes for this repo: status, decisions, and the traps that have actually bitten.
Migrated out of Claude Code's memory on 2026-08-24, so they are written in the first
person and dated by when each thing was learned — that date is usually the useful part.

Cross-cutting notes that are not specific to this repo live in
[fleet-notes](https://github.com/stoatworks-labs/fleet-notes).

*ahm-control — PUBLIC Lake/DriveRack-style system controller for Allen & Heath AHM install processors; created 2026-08-11; simulator-verified only, processing editors deliberately cannot write to hardware*

**`~/Projects/ahm-control`** — github.com/stoatworks-labs/ahm-control, **PUBLIC**, branch `main`.
Created **2026-08-11**. Local server (Node, TS run via type-stripping) + React/Vite browser UI.
Five views: Topology, Routing, Levels, Processing, Presets.

**The load-bearing fact about this project:** Allen & Heath's *published* TCP/IP protocol carries
levels, mutes, input→zone and zone→zone crosspoints, preset recall and source select — and
**nothing else**. No PEQ, delay, dynamics, metering, or name read-back. So the Processing view is
real and usable but is marked `origin: 'local'` and **never touches the socket**; the UI says so
on screen. The `ValueOrigin` type (`'device' | 'pending' | 'local'`) is the honesty mechanism —
don't let a local value render as unit-confirmed. See [ahm tcp protocol](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_ahm_tcp_protocol.md).

**Reframed 2026-08-11 (same day) from a generic matrix controller into a real system controller.**
`src/system/` is a pure domain model: **output topology** (groups, mono/stereo, allocated zones;
presets L/R, +Subs, +Frontfills, +Delays, Custom), **consoles** (one feed per group; one
production desk always live, secondaries switched `single` or `multi`), and a **resolver** that
turns those into crosspoints. **Format compensation is ONE mechanism, not special cases**:
compare what the desk sends to the group and pass through / sum / duplicate. "Derive" points a
group at another group's feed and reruns the same comparison — so subs derived from stereo mains
give a mono mixdown for a mono sub group and L/R for a stereo one, configured once. Subs on an
aux are just a direct feed. **Don't add per-case branches.**

**Two containment rules, both load-bearing:** `managedCrosspoints()` limits closing to the
inputs/zones this system allocated (never stomps hand-patched routing); and the server ALSO keeps
an `opened` set of every crosspoint it ever wrote — **necessary because shrinking a desk's input
usage (stereo→mono, or a group going derived) drops those inputs out of the allocation, so their
open crosspoints fall outside the managed space and could never be closed, stranding a "removed"
console still feeding the PA.** Found by a test, not inspection. `opened` doesn't survive a
restart — the remaining gap.

**103 tests pass, typecheck clean, production build works. NO AHM HARDWARE HAS EVER TOUCHED IT.**
Verification is a simulator (`src/sim/`) built from the same spec as the client, so the tests
prove self-consistency, not hardware compatibility. Never describe it as hardware-verified.

Stack pins are deliberate per [ts7 eslint10 vite8 ceilings](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_ts7_eslint10_vite8_ceilings.md): typescript `~6.0.3`,
eslint `^9`, vite `^7`. Node runs the TS directly, so **no enums / namespaces / parameter
properties** — an enum fails at load with `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` (hit this).

Dev entry is `npm run dev` (simulator) or `node scripts/dev.mjs --host <ip>`. The launch config
lives in `~/.claude/launch.json` (resolved from HOME, so `scripts/dev.mjs` resolves its own cwd
from `import.meta.url`).

**Two design decisions worth not re-litigating:**
- **Read-back after write.** The spec documents that a preset recall is echoed to everyone but
  says nothing about whether a level/mute is echoed to the client that sent it. Rather than
  assume, `AhmDevice` issues a debounced (120 ms) get after each write to turn `pending` into
  `device`. Works whichever way a real unit behaves.
- **Names and preset names are app-local**, because the protocol cannot read them back.

Private RE sibling for everything the published protocol can't reach: [ahm re](https://github.com/stoatworks-labs/ahm-re/blob/main/docs/NOTES.md) (`ahm-re`).
Config container reader details: [ahm cfg container](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_ahm_cfg_container.md).
