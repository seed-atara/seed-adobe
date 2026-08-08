# Adobe After Effects Integration Research

Research snapshot: 2026-08-08.

The starter architecture intentionally does not assume a specific Adobe extension technology.

Before implementation, verify from current official Adobe After Effects developer documentation which mechanism best supports:
- dockable panel UI
- active comp/playhead inspection
- rendering/exporting the current frame
- importing generated media
- inserting items/layers in a comp
- Windows/macOS deployment

Candidates may include scripting/CEP, newer extension frameworks where supported, or native SDK components. Choose only after current AE support is verified.

Architectural requirement: whichever host technology is chosen must remain behind `AeHostAdapter`.

Useful official starting point:
- https://developer.adobe.com/after-effects/

Record exact links and verified capability statements here before locking the host implementation.
