# AHM TCP/IP protocol

Everything in this document comes from Allen &amp; Heath's published *AHM TCP/IP Protocol V1.0*
specification. Nothing here was obtained by reverse engineering, and nothing here has been
checked against a physical unit.

Implemented in [`src/protocol/messages.ts`](../src/protocol/messages.ts), asserted byte-for-byte
in [`test/protocol.test.ts`](../test/protocol.test.ts).

## Transport

| | |
| --- | --- |
| Plaintext | TCP **51325** — no authentication |
| TLS | TCP **51327** — send `UserProfile, UserPassword` first; the unit replies `AuthOK` or drops |

`UserProfile` is `0x00`–`0x1F`. Only the plaintext port is implemented here.

TCP provides no message framing, so a reader must handle both a message split across two reads
and several messages arriving in one. The decoder returns a `consumed` count and the caller
retains the remainder.

## Addressing

Every strip is a MIDI channel (`N`) plus a note number (`CH`). Wire values are 0-based.

| Class | `N` | `CH` |
| --- | --- | --- |
| Inputs 1–64 | 0 | `0x00`–`0x3F` |
| Zones 1–64 | 1 | `0x00`–`0x3F` |
| Control groups 1–32 | 2 | `0x00`–`0x1F` |

## SysEx header

```
F0 00 00 1A 50 12 MV mV
```

`00 00 1A` is the Allen &amp; Heath manufacturer ID; `MV`/`mV` are the protocol major/minor
version, `01 00` in V1.0. The decoder deliberately **does not compare the version bytes** — a
unit on a newer minor version still speaks this message set.

## Messages

| Function | Form |
| --- | --- |
| Mute on | `9N CH 7F` then `9N CH 00` |
| Mute off | `9N CH 3F` then `9N CH 00` |
| Get mute | `<hdr> 0N 01 09 CH F7` |
| Level | `BN 63 CH` · `BN 62 17` · `BN 06 LV` |
| Get level | `<hdr> 0N 01 0B CH F7` |
| Level inc/dec | `BN 63 CH` · `BN 62 20` · `BN 06 7F`/`3F` |
| Send level | `<hdr> 0N 02 CH SndN SndCH LV F7` |
| Send mute | `<hdr> 0N 03 CH SndN SndCH 7F`/`3F` `F7` |
| Send inc/dec | `<hdr> 0N 04 CH SndN SndCH 7F`/`3F` `F7` |
| Get send level | `<hdr> 0N 01 0F 02 CH SndN SndCH F7` |
| Get send mute | `<hdr> 0N 01 0F 03 CH SndN SndCH F7` |
| Preset recall | `B0 00 <bank>` then `C0 <program>` |
| Audio playback | `<hdr> 00 06 <player> <track> F7` |
| Source select | `<hdr> 00 08 CH <source> F7` |

Received mutes: velocity `00` and Note Off are ignored; `01`–`3F` is unmuted, `40`–`7F` is muted.

### Presets

500 presets in four banks of 128. The fourth bank is short — it runs `385`–`500`, so program
values stop at `0x73`. A grid that offers all 128 slots in bank 4 is offering 12 presets that do
not exist.

### Source selector

Setting a source is `<hdr> 00 08 CH <source> F7`. The unit's reply is longer and adds a colour
byte and an ASCII name:

```
<hdr> 00 08 CH <source> <colour> <name...> F7
```

Colours: `00` off, `01` red, `02` green, `03` yellow, `04` blue, `05` magenta, `06` cyan,
`07` white. Source numbers are 1–20 (`0x00`–`0x13` on the wire).

## The level curve

```
LV = floor( ((dB + 48) / 58) * 127 )
```

covering −48 dB to +10 dB in one 7-bit byte. Byte `0x69` (105) is unity.

**It truncates, it does not round.** The published reference table only reproduces under
truncation: at −40 dB the table says 17 where rounding gives 18, and at −45 dB it says 6 where
rounding gives 7.

In the implementation the truncation is applied to `raw + 1e-9`. That epsilon is load-bearing —
without it, binary floating point puts byte 3 at `2.9999999999999996` and a byte → dB → byte
round trip loses a step.

### Known conflicts in the published document

Two rows of Allen &amp; Heath's reference table disagree with the formula printed in the same
document. Both are recorded here rather than silently resolved, and both are excluded from the
table-conformance test.

| Gain | Table | Formula | Note |
| --- | --- | --- | --- |
| +5 dB | `0x76` (118) | 116 | The table's top end is irregular: 105 → 118 is 13 steps for 5 dB where every other 5 dB step is 11. |
| −47.5 dB | `0x00` (0) | 1 | Half-step rounding at the very bottom of the range; −48 dB is 0 either way. |

The formula is treated as canonical because it is exact at unity and self-consistent across the
whole range. Neither point can be settled without a real unit.

## What the protocol does not carry

There is **no published message for PEQ, GEQ, delay, compressor, limiter or metering**, and no
way to read a channel or preset name. That is not an omission in this implementation — those
parameters travel over AHM System Manager's own protocol, which Allen &amp; Heath does not
publish. See [config-format.md](config-format.md) for what the offline file format reveals.
