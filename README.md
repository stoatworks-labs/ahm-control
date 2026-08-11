# ahm-control

> This is an AI-assisted project. The code was written with [Claude Code](https://claude.com/claude-code).
> Everything here has been verified against the published Allen &amp; Heath protocol document and a
> simulator built from it — **no AHM hardware has ever been connected to this code**, and the
> EQ/delay/dynamics screens are not sent to a unit at all, because the published protocol has no
> message for them.

A system-controller frontend for the Allen &amp; Heath AHM series, in the style of a Lake
Controller or a dbx DriveRack: preset recall, a live input routing matrix, a system topology
view, and per-output processing.

Runs as a small local server plus a browser UI, so one machine holds the connection to the
processor and any number of tablets or laptops on the network can drive it.

## What actually works

The AHM's published TCP/IP control protocol covers a specific slice of the processor. This
project implements all of it, and is honest about the rest.

| Feature | Status |
| --- | --- |
| Preset recall (500 presets, 4 banks) | Live — and recalls made elsewhere are picked up |
| Input / zone / control-group levels | Live, with read-back confirmation |
| Input / zone / control-group mutes | Live |
| Input → zone and zone → zone routing | Live, level and mute per crosspoint |
| Source selector | Live, including the unit's colour and name reply |
| System topology | Derived from the matrix state, model size and an imported `.cfg` |
| PEQ / delay / compressor / limiter | **Local only — not sent to the unit** |
| Channel and preset names | Local only — the protocol cannot read them back |

The processing editors are real and usable for designing a tuning, and the EQ curve is computed
from actual biquad maths. They just cannot be pushed to the hardware yet: the published protocol
carries levels, mutes, routing, source selection and preset recall, and nothing else. Getting
processing onto the unit needs the System Manager protocol, which is not published — that work
lives in a separate private repository.

## Running it

```bash
npm install
```

Against the built-in simulator, which needs no hardware:

```bash
npm run dev
```

Against a real processor:

```bash
node scripts/dev.mjs --host 192.168.1.70
```

Then open <http://localhost:5173>. The UI also has an address box and a Connect button, so you
can point it at a unit without restarting.

The AHM listens on TCP **51325** (plaintext). Port 51327 is the TLS variant and needs a user
profile and password handshake; only the plaintext port is implemented.

## Tests

```bash
npm test
```

69 tests. The protocol tests assert byte sequences taken from Allen &amp; Heath's published
document; the integration tests run the client against the simulator over a real TCP socket; the
config tests parse the six factory `.cfg` files that ship inside AHM System Manager, and skip
cleanly when it is not installed.

```bash
npm run typecheck
```

## How it fits together

```
browser (React)  ──WebSocket──>  local server  ──TCP 51325──>  AHM processor
                                      │
                                      └── simulator (in-process, for development)
```

`src/protocol/` is pure and has no I/O: message encoding, the level curve, channel addressing.
`src/server/device.ts` owns the socket and the state cache. `src/sim/` is a fake AHM built from
the same spec, which is what the tests run against.

## Documentation

- [docs/protocol.md](docs/protocol.md) — the published protocol, including two points where
  Allen &amp; Heath's own document contradicts itself
- [docs/config-format.md](docs/config-format.md) — what is known about the System Manager `.cfg`
  container, and what is still opaque

## Licence

MIT. Allen &amp; Heath, AHM and dLive are trademarks of Allen &amp; Heath Limited. This project is
not affiliated with or endorsed by Allen &amp; Heath.
