# obj2gltf

One-time asset converter: Wavefront **OBJ (+MTL) → glTF 2.0**, for the original
Crack Attack! models. Convert from the `.obj` sources in `crack-attack/data/models/`
— do **not** transcribe the generated `obj_*.cxx` files (those are a build
artifact of the C++ project).

## What it does

- **`obj.ts`** — a small OBJ/MTL parser scoped to what the Wings 3D exports use:
  `v`/`vn`/`vt`, `f` in all four index forms (`a`, `a/b`, `a//c`, `a/b/c`,
  including negative/relative indices), `o`/`g`, `usemtl`, `mtllib`. N-gon faces
  are fan-triangulated.
- **`gltf.ts`** — de-duplicates `(position, uv, normal)` tuples into unique glTF
  vertices, emits one primitive per material, and inlines the binary buffer as a
  base64 data URI, so the output is a single portable `.gltf` file (loadable
  directly by three's `GLTFLoader`). Missing attributes are omitted; MTL `Kd`/`d`
  become `baseColorFactor`, `Ns` maps to `roughnessFactor`, and `map_Kd` is
  preserved in `material.extras` for a later texture-embedding pass.
- **`cli.ts`** — batch conversion.

## Usage

```sh
pnpm --filter @crack-attack/obj2gltf build
node tools/obj2gltf/dist/cli.js <out-dir> <model.obj> [more.obj …]

# e.g. convert the in-game rounded-cube block model:
node tools/obj2gltf/dist/cli.js packages/client/public/models \
  crack-attack/data/models/crackattackcubehires_simplified.obj
```

`mtllib` references are resolved relative to each OBJ's directory. See
`examples/block.gltf` for a converted sample (the rounded-cube block).

## Notes / next steps

- **Textures** — the block flavor materials colour themselves via `map_Kd`
  (e.g. `000.png`), but those PNGs are not present in the reference tree, so the
  converter records the texture name in `material.extras.map_Kd` without
  embedding an image. When the source PNGs (or TGA→PNG conversions) are
  available, a follow-up can embed them as glTF images/textures.
- **Wiring into the client** — the client currently renders solid-coloured
  instanced boxes (`packages/client/src/render`). Loading these glTF models via
  `GLTFLoader` is a separate step; the geometry is ready.
