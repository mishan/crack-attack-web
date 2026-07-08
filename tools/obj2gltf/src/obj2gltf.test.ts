import { describe, expect, it } from 'vitest';
import { objToGltf } from './convert.js';
import { convertToGltf, type Gltf } from './gltf.js';
import { parseMtl, parseObj } from './obj.js';

/** The slice of the glTF document the tests read (avoids `any`). */
interface GltfJson {
  asset: { version: string };
  scenes: unknown[];
  meshes: {
    primitives: { attributes: Record<string, number>; indices: number; material: number }[];
  }[];
  accessors: { count: number; type: string; min?: number[]; max?: number[] }[];
  materials: {
    alphaMode: string;
    pbrMetallicRoughness: { baseColorFactor: number[]; metallicFactor: number };
    extras?: { map_Kd?: string };
  }[];
  buffers: { uri: string; byteLength: number }[];
}

const json = (g: Gltf): GltfJson => g.json as unknown as GltfJson;

// A minimal two-triangle quad with normals, UVs, and a material — mirrors the
// shape of the real Wings 3D exports without needing the gitignored assets.
const QUAD_OBJ = `# quad
mtllib quad.mtl
o quad
v 0 0 0
v 1 0 0
v 1 1 0
v 0 1 0
vn 0 0 1
vt 0 0
vt 1 0
vt 1 1
vt 0 1
usemtl red
f 1/1/1 2/2/1 3/3/1
f 1/1/1 3/3/1 4/4/1
`;

const QUAD_MTL = `newmtl red
Kd 0.9 0.1 0.1
d 1.0
Ns 250
map_Kd red.png
`;

describe('parseObj', () => {
  it('reads positions, normals, uvs, mtllib, and triangulated faces', () => {
    const m = parseObj(QUAD_OBJ);
    expect(m.positions.length).toBe(4 * 3);
    expect(m.normals.length).toBe(1 * 3);
    expect(m.texcoords.length).toBe(4 * 2);
    expect(m.mtllibs).toEqual(['quad.mtl']);
    expect(m.groups.length).toBe(1);
    expect(m.groups[0]!.material).toBe('red');
    expect(m.groups[0]!.triangles.length).toBe(2);
  });

  it('fan-triangulates an n-gon face', () => {
    const m = parseObj('v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n');
    expect(m.groups[0]!.triangles.length).toBe(2); // quad → 2 tris
  });

  it('resolves negative (relative) face indices', () => {
    const m = parseObj('v 0 0 0\nv 1 0 0\nv 1 1 0\nf -3 -2 -1\n');
    const tri = m.groups[0]!.triangles[0]!;
    expect(tri.map((v) => v.position)).toEqual([0, 1, 2]);
  });

  it('handles faces without uvs or normals (`f a`)', () => {
    const m = parseObj('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
    const tri = m.groups[0]!.triangles[0]!;
    expect(tri.every((v) => v.texcoord === -1 && v.normal === -1)).toBe(true);
  });

  it('throws on an out-of-range face index', () => {
    expect(() => parseObj('v 0 0 0\nv 1 0 0\nf 1 2 5\n')).toThrow(/out of range/);
    expect(() => parseObj('v 0 0 0\nf -5\n')).toThrow(/out of range/);
  });

  it('throws on a malformed / missing vertex coordinate', () => {
    expect(() => parseObj('v 0 0\nf 1 1 1\n')).toThrow(/invalid "v"/); // too few tokens
    expect(() => parseObj('v 0 foo 0\n')).toThrow(/invalid "v"/); // non-numeric
  });
});

describe('parseMtl', () => {
  it('reads Kd, d, Ns, and map_Kd', () => {
    const mats = parseMtl(QUAD_MTL);
    const red = mats.get('red')!;
    expect(red.diffuse).toEqual([0.9, 0.1, 0.1]);
    expect(red.opacity).toBe(1);
    expect(red.shininess).toBe(250);
    expect(red.diffuseMap).toBe('red.png');
  });
});

describe('convertToGltf', () => {
  it('emits a valid glTF 2.0 skeleton', () => {
    const g = objToGltf(QUAD_OBJ, () => QUAD_MTL);
    const j = json(g);
    expect(j.asset.version).toBe('2.0');
    expect(j.scenes.length).toBe(1);
    expect(j.meshes[0].primitives.length).toBe(1);
    expect(j.buffers[0].uri).toMatch(/^data:application\/octet-stream;base64,/);
    expect(j.buffers[0].byteLength).toBe(g.binary.byteLength);
  });

  it('de-duplicates shared vertices (quad → 4 unique, not 6)', () => {
    const g = objToGltf(QUAD_OBJ, () => QUAD_MTL);
    const j = json(g);
    const posAccessor = j.accessors[j.meshes[0].primitives[0].attributes.POSITION];
    expect(posAccessor.count).toBe(4); // two tris share an edge (2 verts)
    expect(posAccessor.type).toBe('VEC3');
    expect(posAccessor.min).toEqual([0, 0, 0]);
    expect(posAccessor.max).toEqual([1, 1, 0]);
  });

  it('carries the material colour into baseColorFactor', () => {
    const g = objToGltf(QUAD_OBJ, () => QUAD_MTL);
    const j = json(g);
    const mat = j.materials[0];
    expect(mat.pbrMetallicRoughness.baseColorFactor).toEqual([0.9, 0.1, 0.1, 1]);
    expect(mat.pbrMetallicRoughness.metallicFactor).toBe(0);
    expect(mat.extras?.map_Kd).toBe('red.png'); // texture reference preserved
  });

  it('omits NORMAL/TEXCOORD_0 when the model lacks them', () => {
    const g = objToGltf('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n', () => null);
    const j = json(g);
    const attrs = j.meshes[0].primitives[0].attributes;
    expect(attrs.POSITION).toBeDefined();
    expect(attrs.NORMAL).toBeUndefined();
    expect(attrs.TEXCOORD_0).toBeUndefined();
    // a group with an unknown/absent material still gets a default material
    expect(j.materials.length).toBe(1);
  });

  it('de-duplicates on position alone when the NORMAL attribute is omitted', () => {
    // Mixed normal presence → NORMAL is dropped. The shared verts carry a normal
    // index in one triangle and none in the other; keyed on position alone they
    // must still merge instead of splitting.
    const obj = 'v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nvn 0 0 1\nf 1//1 2//1 3//1\nf 1 3 4\n';
    const g = objToGltf(obj, () => null);
    const j = json(g);
    expect(j.meshes[0].primitives[0].attributes.NORMAL).toBeUndefined();
    const posAccessor = j.accessors[j.meshes[0].primitives[0].attributes.POSITION];
    expect(posAccessor.count).toBe(4); // 4 unique positions, not 5 or 6
  });

  it('throws when the OBJ produces no triangles', () => {
    expect(() => objToGltf('v 0 0 0\nv 1 0 0\n', () => null)).toThrow(/no triangles/);
  });

  it('splits primitives per material and marks translucent materials BLEND', () => {
    const obj = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nusemtl a\nf 1 2 3\nusemtl b\nf 1 2 3\n';
    const mtl = 'newmtl a\nKd 1 1 1\nd 1\nnewmtl b\nKd 0 0 0\nd 0.5\n';
    const g = convertToGltf(parseObj(obj), parseMtl(mtl));
    const j = json(g);
    expect(j.meshes[0].primitives.length).toBe(2);
    expect(j.materials[1].alphaMode).toBe('BLEND');
    expect(j.materials[0].alphaMode).toBe('OPAQUE');
  });
});
