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

- **load-test/** — relay load generator (see `../docs/LOAD_TEST_PLAN.md`).
  Wire, sim and spectator bots, lobby idlers and churners, abusive clients and
  a scoreboard driver, run as the plan's named scenarios (L1–L12), each writing
  a CSV of generator and relay (`STATS=1`) numbers. See its own README.

Each tool is its own workspace package (`tools/*`) and may depend on Node APIs.
