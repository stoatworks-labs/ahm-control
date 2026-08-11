# The System Manager `.cfg` container

What is known about the AHM System Manager system file, from the six factory configs that ship
inside **AHM System Manager 1.61** (`AHM-16/32/64 Default.cfg` and `… Empty.cfg`).

Implemented in [`src/config/`](../src/config/). The parser handles the parts that are confirmed
and hands back the rest as raw bytes rather than guessing.

## Container

A `.cfg` is **gzip → POSIX tar**, containing:

```
archive/Mixer.cfg                  channel geometry, plain text
archive/Version.txt                format/firmware version, plain text
archive/UnitType_AHM-64-Unit.txt   ZERO BYTES — the model is the FILENAME
archive/CurrentSettings.dat        live parameter blob
archive/Scene1.dat                 scene parameter blob
archive/Devices/                   per-device data; empty in factory files
```

The unit-type marker file is empty. Its **name** carries the model, and reading its contents
gets you nothing.

## `Mixer.cfg`

Plain text, CRLF terminated:

```
L1  MixerConfigV2        magic
L2  m/S map, N/2 chars   pairing map A
L3  m/S map, N/2 chars   pairing map B
L4  decimal count        see below
L5  '0' × N              all zero in every factory file
L6  'N' × N/2            all 'N' in every factory file
```

`N` is the model size. Every line length scales with it exactly across all six files, which is
what confirms the geometry rather than assuming it:

| Model | L2/L3 | L4 (Empty) | L4 (Default) | L5 | L6 |
| --- | --- | --- | --- | --- | --- |
| AHM-16 | 8 | 16 | 12 | 16 | 8 |
| AHM-32 | 16 | 32 | 24 | 32 | 16 |
| AHM-64 | 32 | 64 | 52 | 64 | 32 |

`m` is mono and `S` is stereo. Each map character covers a **pair** of channels, which is why
the maps are `N/2` long.

### L4 is not derived from the maps

On the Empty configs `L4 == N`, which looks like "2 per map slot". No per-slot weighting
reproduces the Default configs:

| Model | Map A | L4 |
| --- | --- | --- |
| AHM-16 | 6×m + 2×S | 12 |
| AHM-32 | 14×m + 2×S | 24 |
| AHM-64 | 28×m + 4×S | 52 |

Mono=2/stereo=1 gives 14, 30, 60. Mono=2/stereo=0 gives 12, 28, 56. Neither fits all three, and
the shortfall (4, 8, 12) tracks neither `N` nor the stereo count consistently. So it is parsed
as an independent field, exposed verbatim, and **nothing downstream depends on it**.

## The `.dat` blobs — not decoded

`CurrentSettings.dat` and `Scene1.dat` are a **fixed-layout struct dump**, not a tagged format.
They contain readable labels that name the per-zone processing chain:

```
$Unit Analogue Input, Number NN     Port B Digital Input, Number NN
Unit SLink Digital Output, Number NN
Mix Delay, Zone NN                  Parametric EQ, Zone NN
xGEQ, Zone NN                       GEQ-PEQ, Zone NN
Compressor, Zone NN                 Compressor side chain, Zone NN
Insert, Zone NN                     Limiter, Zone NN
Allpass EQ, Zone NN                 Source Select Controller NN
```

Channel names (`Zone 01`, `Input 5`, `In 12`) are present too, in fixed-width records — the
source-selector block uses a 17-byte stride.

**The fields are not null-terminated and not cleared on write.** Shorter strings leave the tail
of whatever was there before, which is why raw `strings` output contains chimeras like
`Unit AnalSource3` and `ue InputSource13`. Any parser that trusts a run of printable bytes to be
one value will produce confident nonsense.

Decoding the field layout is genuine reverse-engineering work and is deliberately **not**
attempted here. Until it is done, this project reads the model, the version and the geometry
from a `.cfg`, and nothing else.
