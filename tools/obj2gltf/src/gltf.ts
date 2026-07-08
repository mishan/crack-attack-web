/**
 * gltf.ts — assemble a self-contained glTF 2.0 document from a parsed OBJ.
 *
 * De-duplicates (position, uv, normal) tuples into unique glTF vertices, emits
 * one primitive per material group, and inlines the binary buffer as a base64
 * data URI so the result is a single portable `.gltf` file (loadable directly by
 * three's `GLTFLoader`). Only vertex data we actually have is emitted — a model
 * without normals or UVs simply omits that attribute.
 */

import type { FaceVertex, Material, ObjModel } from './obj.js';

// glTF component types.
const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
// glTF bufferView targets.
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

export interface Gltf {
  readonly json: Record<string, unknown>;
  /** The binary buffer the JSON's base64 data URI encodes (returned for tests). */
  readonly binary: Uint8Array;
}

export interface ConvertOptions {
  /** Generator string stamped into `asset.generator`. */
  readonly generator?: string;
  /** Default material for face groups with no (or unknown) `usemtl`. */
  readonly defaultMaterial?: Material;
}

const DEFAULT_MATERIAL: Material = {
  name: 'default',
  diffuse: [0.8, 0.8, 0.8],
  opacity: 1,
  shininess: 0,
  diffuseMap: null,
};

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/** Align a byte length up to the next multiple of 4 (glTF accessor alignment). */
const align4 = (n: number): number => (n + 3) & ~3;

function toGltfMaterial(m: Material): Record<string, unknown> {
  const mat: Record<string, unknown> = {
    name: m.name,
    pbrMetallicRoughness: {
      baseColorFactor: [m.diffuse[0], m.diffuse[1], m.diffuse[2], m.opacity],
      metallicFactor: 0,
      // Ns (0..~1000 in these exports) → roughness. Higher shininess = smoother.
      roughnessFactor: clamp01(1 - m.shininess / 1000),
    },
    doubleSided: true,
    alphaMode: m.opacity < 1 ? 'BLEND' : 'OPAQUE',
  };
  // Preserve the texture reference for a later texture-embedding pass; the
  // source PNGs aren't in the reference tree, so we don't create an image here.
  if (m.diffuseMap) mat.extras = { map_Kd: m.diffuseMap };
  return mat;
}

/**
 * Convert a parsed OBJ (+ its materials) into a glTF 2.0 document. `materials`
 * maps `usemtl` names to parsed MTL materials; missing names fall back to the
 * default material.
 */
export function convertToGltf(
  model: ObjModel,
  materials: Map<string, Material>,
  options: ConvertOptions = {},
): Gltf {
  const hasNormals =
    model.normals.length > 0 &&
    model.groups.every((g) => g.triangles.every((t) => t.every((v) => v.normal >= 0)));
  const hasTexcoords =
    model.texcoords.length > 0 &&
    model.groups.every((g) => g.triangles.every((t) => t.every((v) => v.texcoord >= 0)));

  // --- de-duplicate face vertices into unique glTF vertices ---
  const uniqueKey = new Map<string, number>();
  const positions: number[] = [];
  const normals: number[] = [];
  const texcoords: number[] = [];

  const vertexId = (fv: FaceVertex): number => {
    // Key only on attributes that are actually emitted: including a texcoord or
    // normal index when that attribute is omitted would split otherwise-identical
    // vertices and bloat the buffer.
    const key = `${fv.position}/${hasTexcoords ? fv.texcoord : ''}/${hasNormals ? fv.normal : ''}`;
    let id = uniqueKey.get(key);
    if (id !== undefined) return id;
    id = positions.length / 3;
    positions.push(
      model.positions[fv.position * 3] ?? 0,
      model.positions[fv.position * 3 + 1] ?? 0,
      model.positions[fv.position * 3 + 2] ?? 0,
    );
    if (hasNormals) {
      normals.push(
        model.normals[fv.normal * 3] ?? 0,
        model.normals[fv.normal * 3 + 1] ?? 0,
        model.normals[fv.normal * 3 + 2] ?? 0,
      );
    }
    if (hasTexcoords) {
      texcoords.push(
        model.texcoords[fv.texcoord * 2] ?? 0,
        model.texcoords[fv.texcoord * 2 + 1] ?? 0,
      );
    }
    uniqueKey.set(key, id);
    return id;
  };

  // Per-group index lists, plus the material each group uses.
  const materialOrder: string[] = [];
  const materialIndex = new Map<string, number>();
  const primitives: { indices: number[]; material: number }[] = [];

  const resolveMaterial = (name: string | null): number => {
    const key = name ?? '__default__';
    let idx = materialIndex.get(key);
    if (idx === undefined) {
      idx = materialOrder.length;
      materialOrder.push(key);
      materialIndex.set(key, idx);
    }
    return idx;
  };

  for (const group of model.groups) {
    if (group.triangles.length === 0) continue;
    const indices: number[] = [];
    for (const tri of group.triangles) for (const fv of tri) indices.push(vertexId(fv));
    primitives.push({ indices, material: resolveMaterial(group.material) });
  }

  const vertexCount = positions.length / 3;
  if (vertexCount === 0) {
    // No faces → no geometry. A position accessor with count 0 (and its
    // Infinity/-Infinity min/max) is invalid glTF, so fail fast instead.
    throw new RangeError('OBJ produced no triangles — nothing to convert');
  }
  const use32 = vertexCount > 0xffff;

  // --- pack the binary buffer: [indices…][positions][normals?][texcoords?] ---
  const chunks: { bytes: Uint8Array; byteOffset: number }[] = [];
  let offset = 0;
  const push = (bytes: Uint8Array): number => {
    const at = offset;
    chunks.push({ bytes, byteOffset: at });
    offset = align4(at + bytes.byteLength);
    return at;
  };
  const f32 = (arr: number[]): Uint8Array => new Uint8Array(Float32Array.from(arr).buffer);

  const indexViews = primitives.map((p) => {
    const typed = use32 ? Uint32Array.from(p.indices) : Uint16Array.from(p.indices);
    return { byteOffset: push(new Uint8Array(typed.buffer)), count: p.indices.length };
  });
  const posOffset = push(f32(positions));
  const normOffset = hasNormals ? push(f32(normals)) : -1;
  const uvOffset = hasTexcoords ? push(f32(texcoords)) : -1;

  const buffer = new Uint8Array(offset);
  for (const c of chunks) buffer.set(c.bytes, c.byteOffset);

  // --- accessors + bufferViews ---
  const bufferViews: Record<string, unknown>[] = [];
  const accessors: Record<string, unknown>[] = [];

  const addView = (byteOffset: number, byteLength: number, target: number): number => {
    bufferViews.push({ buffer: 0, byteOffset, byteLength, target });
    return bufferViews.length - 1;
  };

  // Position min/max (required by the spec).
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k]!;
      if (v < min[k]!) min[k] = v;
      if (v > max[k]!) max[k] = v;
    }
  }

  const posAccessor = accessors.length;
  accessors.push({
    bufferView: addView(posOffset, positions.length * 4, ARRAY_BUFFER),
    componentType: FLOAT,
    count: vertexCount,
    type: 'VEC3',
    min,
    max,
  });
  let normAccessor = -1;
  if (hasNormals) {
    normAccessor = accessors.length;
    accessors.push({
      bufferView: addView(normOffset, normals.length * 4, ARRAY_BUFFER),
      componentType: FLOAT,
      count: vertexCount,
      type: 'VEC3',
    });
  }
  let uvAccessor = -1;
  if (hasTexcoords) {
    uvAccessor = accessors.length;
    accessors.push({
      bufferView: addView(uvOffset, texcoords.length * 4, ARRAY_BUFFER),
      componentType: FLOAT,
      count: vertexCount,
      type: 'VEC2',
    });
  }

  const meshPrimitives = primitives.map((p, i) => {
    const view = indexViews[i]!;
    const indexAccessor = accessors.length;
    accessors.push({
      bufferView: addView(view.byteOffset, view.count * (use32 ? 4 : 2), ELEMENT_ARRAY_BUFFER),
      componentType: use32 ? UNSIGNED_INT : UNSIGNED_SHORT,
      count: view.count,
      type: 'SCALAR',
    });
    const attributes: Record<string, number> = { POSITION: posAccessor };
    if (hasNormals) attributes.NORMAL = normAccessor;
    if (hasTexcoords) attributes.TEXCOORD_0 = uvAccessor;
    return { attributes, indices: indexAccessor, material: p.material };
  });

  const gltfMaterials = materialOrder.map((key) => {
    const mtl = key === '__default__' ? undefined : materials.get(key);
    return toGltfMaterial(mtl ?? options.defaultMaterial ?? DEFAULT_MATERIAL);
  });

  const base64 = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength).toString(
    'base64',
  );

  const json: Record<string, unknown> = {
    asset: { version: '2.0', generator: options.generator ?? 'obj2gltf (crack-attack)' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: meshPrimitives }],
    materials: gltfMaterials,
    accessors,
    bufferViews,
    buffers: [
      { byteLength: buffer.byteLength, uri: `data:application/octet-stream;base64,${base64}` },
    ],
  };

  return { json, binary: buffer };
}
