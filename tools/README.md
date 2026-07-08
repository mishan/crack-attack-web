# tools/

Build- and validation-time utilities (not shipped to players).

Tools (see `../BROWSER_PORT_PLAN.md`):

- **replay-check/** — golden-master harness (landed). Runs a fixed seed +
  recorded action stream through `@crack-attack/core` and diffs the per-tick
  state digest against a reference stream (a stored golden master, or a log from
  the instrumented C++ build). First divergence pinpoints the buggy subsystem.
  This is how faithfulness is verified — not by eyeballing. See its own README
  for the C++ cross-validation step.

- **obj2gltf/** — one-time asset conversion (landed). Wavefront OBJ (+MTL) →
  glTF 2.0 for the original `data/models/*.obj` sources. Convert from the `.obj`
  sources; do not transcribe the generated `obj_*.cxx` files. See its own README
  for usage and the deferred texture-embedding step.

Each tool is its own workspace package (`tools/*`) and may depend on Node APIs.
