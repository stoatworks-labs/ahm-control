# Attributions

ahm-control is built on other people's work. This file lists what that work is, who did
it, and what it is doing here.

It is generated — the master lists live in the `stoatworks-backend` repo and are
pushed out by `scripts/sync-attributions.py`. Edit it there, not here.

## Third-party code this project uses

Libraries, SDKs and frameworks the project is built on or bundles.

### React

<https://react.dev>  
Licence: MIT  
Copyright: Meta Platforms, Inc. and affiliates

An npm dependency.

The UI layer for the browser tools and the Electron and Tauri front ends.

### The npm ecosystem

<https://www.npmjs.com>  
Licence: predominantly MIT  
Copyright: the individual package authors

npm dependencies, resolved and pinned in the lockfile.

Build tooling, test runners and the libraries the front ends are assembled from. The exact set and versions for any build are in that repo's lockfile, which is the authoritative list.

The full transitive dependency set for any build is pinned in this repo's lockfile,
which is the authoritative list. What is named above is the layers a reader would
want to know about, not every package that has ever been resolved.

## Work we checked ourselves against

No code was taken from these — but they were how we knew we had it right, and that is worth saying out loud.

### AHM TCP/IP Protocol V1.0 — Allen & Heath

Everything ahm-control sends to a processor comes from Allen & Heath's published protocol document: src/protocol/messages.ts encodes and decodes it, test/protocol.test.ts asserts its byte sequences literally, and the simulator in src/sim/ is built from the same document. Nothing was reverse engineered and nothing has been checked against a physical unit. Two rows of the document's own level table contradict its formula; docs/protocol.md records both and treats the formula as canonical. Not affiliated with or endorsed by Allen & Heath.

### AHM System Manager 1.61 factory configs — Allen & Heath

The .cfg reader in src/config/ was worked out from the six factory configs that ship inside AHM System Manager 1.61 (AHM-16/32/64 Default and Empty): a gzip'd POSIX tar, with Mixer.cfg's geometry confirmed by line lengths that scale with the model across all six. The config tests read them from an installed System Manager and skip when it is absent; no Allen & Heath file is vendored. The .dat parameter blobs are deliberately left undecoded.

## Inspirations

What this set out to be. No code, assets or binaries from any of these were used or examined — the debt is to the idea.

### Lake Controller and dbx DriveRack

A system-controller frontend for the Allen & Heath AHM series in the style of a Lake Controller or a dbx DriveRack: describe the PA once, describe each console once, then run the show by switching consoles in and out.

## Standards and published specifications

What the implementation is measured against.

- **RBJ Audio EQ Cookbook** — The biquad forms src/dsp/biquad.ts evaluates on the unit circle to draw the EQ curve. They model the app's own filters, not the AHM's, whose topology and Q convention are not published.

## Getting this wrong

If your work is here and the description is inaccurate, the licence is wrong, or you would rather not be listed — open an issue and it will be fixed.
