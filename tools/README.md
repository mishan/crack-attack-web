# tools/

Build- and validation-time utilities (not shipped to players).

Planned (see `../BROWSER_PORT_PLAN.md`):

- **replay-check/** — golden-master harness. Runs a fixed seed + recorded action
  stream through `@crack-attack/core` and diffs the per-tick state digest against
  a log captured from the instrumented C++ build. First divergence pinpoints the
  buggy subsystem. This is how faithfulness is verified — not by eyeballing.
- **obj2gltf/** — one-time asset conversion from the original `data/models/*.obj`
  to glTF for the Three.js client. Do not transcribe the generated `obj_*.cxx`
  files; convert from the `.obj` sources.

Each tool is its own workspace package (`tools/*`) and may depend on Node APIs.
