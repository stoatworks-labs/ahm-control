# AGENTS.md

Onboarding for another LLM or a new contributor. `README.md` is the user-facing description;
this file is the *why*.

## What this is

A system-controller frontend for Allen &amp; Heath AHM-16/32/64 install processors, in the style
of a Lake Controller or dbx DriveRack. Local server holds one TCP connection to the processor;
browsers connect to the server over a WebSocket.

Sibling: a **private** repo for reverse-engineering the AHM System Manager protocol. Anything
RE-derived belongs there, not here. This repo is public and contains only work derived from
Allen &amp; Heath's *published* protocol document plus observation of file formats.

## Verified vs assumed — read this before claiming anything works

**Verified:**

- All 103 tests pass (`npm test`) and `npm run typecheck` is clean.
- Protocol encoding matches the byte sequences printed in the published spec — those are
  asserted literally in `test/protocol.test.ts`.
- The client drives the simulator over a real TCP socket: levels, mutes, crosspoints, preset
  recall, source select, multi-client sync, and reconnect after the unit drops the link.
- The `.cfg` reader parses all six factory configs that ship inside System Manager 1.61, and
  the model in the marker filename agrees with the geometry in `Mixer.cfg` for every one.
- The EQ maths is checked against known filter behaviour (bell gain at centre, Butterworth
  −3 dB at cutoff, shelf plateaus, cascade summing in dB).

**Assumed / unverified:**

- **No AHM hardware has ever been connected to this code.** The simulator is built from the
  same spec as the client, so the tests prove self-consistency, not hardware compatibility.
  Do not describe anything here as hardware-verified.
- Whether a real unit echoes a level or mute back to the client that sent it is **not
  documented**. The device layer therefore does an explicit debounced read-back after a write
  instead of relying on an echo. Preset recall *is* documented as echoed to everyone.
- The TLS port (51327) and its auth handshake are not implemented.
- Two rows of the published level table contradict the formula in the same document. See
  docs/protocol.md; neither can be settled without a unit.
- `Mixer.cfg` line 4's meaning is unknown. It is parsed and exposed, and nothing depends on it.

## Load-bearing details

- **`src/protocol/` is pure.** No sockets, no Node built-ins beyond types. It is imported by
  both the server and the browser, so there is one definition of a strip and a crosspoint.
- **`ValueOrigin` (`'device' | 'pending' | 'local'`) is the honesty mechanism.** `local` means
  the protocol *cannot* write it. Processing is permanently `local` and the UI says so on
  screen. Never let a local value render as though the unit confirmed it.
- **Node runs the TypeScript directly** via type stripping. That means **no enums, no
  namespaces, no parameter properties** — only erasable syntax. An enum fails at load with
  `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`.
- **Level conversion truncates and needs its epsilon.** See docs/protocol.md.
- **The decoder is stateful.** NRPN arrives as three separate messages, so the decoder keeps
  per-MIDI-channel state and must be reset when a connection drops, or a half-parsed parameter
  from the old link corrupts the first value on the new one.
- **Dependency pins are deliberate**: typescript `~6.0.3`, eslint `^9`, vite `^7`. TS 7,
  eslint 10 and vite 8 all break this stack. Do not accept those Dependabot majors.

## Traps already hit here

- **A closing WebSocket must not clear a newer one.** `socket.onclose` originally nulled the
  socket ref unconditionally; under React StrictMode's double-mount the *old* socket's close
  fired after the *new* one was assigned, so the UI received state but silently dropped every
  command. Guard with `if (socketRef.current === socket)`.
- **"Connected" on the client is not "registered" on the server.** The client reports connected
  when the TCP handshake completes; the server adds the socket to its client set a turn later.
  A broadcast fired in that window reaches nobody — this caused a 2-in-3 flaky test until the
  rig waited on both sides.
- **A malformed command must not kill the socket.** A bad strip id threw out of the WebSocket
  message handler and took the connection down. It is caught and returned as an error message.
- **The `.dat` config blobs have uncleared fixed-width fields**, so naive string extraction
  produces convincing garbage. See docs/config-format.md.

## Layout

```
src/protocol/    pure: messages, levels, addressing, shared state model
src/config/      .cfg container reader (gzip -> tar -> members)
src/dsp/         biquad design + magnitude response, for the EQ curve
src/server/      HTTP + WebSocket server, and the AHM TCP connection
src/sim/         fake AHM speaking the published protocol
src/system/      pure domain model: output topology, consoles, routing resolver
web/             React UI (system, routing, levels, processing, presets)
test/            node:test; no test framework dependency
```

## Running

```bash
npm install
npm run dev                          # simulator, no hardware needed
node scripts/dev.mjs --host 10.0.0.5 # a real unit
npm test
npm run typecheck
```

The config tests read the factory `.cfg` files out of `/Applications/AHM System Manager 1.61.app`
and skip when it is absent, so CI stays green without Allen &amp; Heath software installed. No
Allen &amp; Heath file is vendored into this repo.

## The system model (added after the first release)

`src/system/` is the domain model, and it is pure — no I/O, no protocol. It is the part worth
understanding first.

- **`topology.ts`** — output groups (mono/stereo, allocated zones) and the four presets.
- **`desks.ts`** — consoles, their per-group feeds, and which are live. One production console
  is always live; secondary consoles are switched in `single` or `multi` mode.
- **`routing.ts`** — `resolveRouting()` turns (topology, desks, live set) into crosspoints, and
  `diffRouting()` works out the minimum set of writes to get there.

**Format compensation is one mechanism, not a pile of special cases.** A feed declares what the
desk sends; the resolver compares that to the output group and either passes it through, sums
it, or duplicates it. "Derive" points a group at another group's feed and then runs the same
comparison — which is why subs derived from mains automatically give a mono mixdown for a mono
sub group and L/R for a stereo one, with no second setting. Do not add per-case branches here.

**Two containment rules that are load-bearing:**

- `managedCrosspoints()` limits what may be closed to inputs and zones this system allocated, so
  the resolver never stomps on routing an operator patched by hand elsewhere on the unit.
- The server ALSO keeps an `opened` set of every crosspoint it has ever written. The managed set
  alone is not enough: reconfiguring a desk to use fewer inputs (stereo → mono, or a group going
  derived) drops those inputs out of the allocation, so their open crosspoints fall outside the
  managed space and could never be closed — leaving a console you thought you removed still
  feeding the PA. That bug was found by a test, not by inspection. The `opened` set does not
  survive a server restart, which is the remaining gap.

**Crosspoint writes are read back like level and mute writes.** Without it a whole resolved
patch sits at `pending` and reads as though the unit ignored it.

## Notes

`docs/NOTES.md` carries this repo's working notes — current status, decisions
already made, and the traps that have actually bitten. Read it before changing
anything non-obvious. Cross-cutting fleet knowledge lives in
[fleet-notes](https://github.com/stoatworks-labs/fleet-notes).
