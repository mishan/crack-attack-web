/**
 * obj.ts — a small, dependency-free Wavefront OBJ + MTL parser.
 *
 * Scoped to what the Crack Attack! models (Wings 3D exports) actually use:
 * `v`/`vn`/`vt`, faces as `f a`, `a/b`, `a//c`, or `a/b/c` (with negative /
 * relative indices), `o`/`g` groups, `usemtl`, and `mtllib`. Faces with more
 * than three vertices are fan-triangulated. Everything else is ignored.
 */

/** A single face-vertex: 0-based indices into the model's position/uv/normal arrays. */
export interface FaceVertex {
  readonly position: number;
  /** UV index, or -1 if the face vertex has none. */
  readonly texcoord: number;
  /** Normal index, or -1 if the face vertex has none. */
  readonly normal: number;
}

/** A run of triangles sharing one material (`usemtl`). */
export interface FaceGroup {
  /** Material name from `usemtl`, or null if none was active. */
  readonly material: string | null;
  /** Triangles, each three {@link FaceVertex}. */
  readonly triangles: FaceVertex[][];
}

export interface ObjModel {
  /** Flat xyz positions (3 per vertex). */
  readonly positions: number[];
  /** Flat xyz normals (3 per vertex). */
  readonly normals: number[];
  /** Flat uv texcoords (2 per vertex). */
  readonly texcoords: number[];
  /** Referenced `mtllib` filenames, in order. */
  readonly mtllibs: string[];
  /** Face groups, split on material changes. */
  readonly groups: FaceGroup[];
}

/** A parsed MTL material. Only the fields we translate to glTF are kept. */
export interface Material {
  readonly name: string;
  /** Diffuse colour (Kd), default white. */
  readonly diffuse: [number, number, number];
  /** Dissolve/opacity (d, or `1 - Tr`), default 1. */
  readonly opacity: number;
  /** Specular exponent (Ns), default 0. */
  readonly shininess: number;
  /** Diffuse texture filename (map_Kd), or null. */
  readonly diffuseMap: string | null;
}

/**
 * Resolve an OBJ index token: 1-based, or negative to count back from the end
 * of the `count` elements parsed so far. Returns a 0-based index, and throws if
 * it falls outside `[0, count)` — a malformed reference must fail loudly rather
 * than get silently clamped to a wrong vertex downstream.
 */
function resolveIndex(token: string, count: number): number {
  const n = Number.parseInt(token, 10);
  if (!Number.isInteger(n) || n === 0) throw new RangeError(`invalid OBJ index "${token}"`);
  const idx = n > 0 ? n - 1 : count + n;
  if (idx < 0 || idx >= count) {
    throw new RangeError(`OBJ index ${n} out of range (only ${count} elements defined)`);
  }
  return idx;
}

/** Parse a required, finite float from a `v`/`vn`/`vt` token, or throw. */
function num(token: string | undefined, tag: string): number {
  const n = Number(token);
  if (token === undefined || token === '' || !Number.isFinite(n)) {
    throw new RangeError(`invalid "${tag}" value "${token ?? ''}"`);
  }
  return n;
}

/** Parse OBJ text into an {@link ObjModel}. */
export function parseObj(text: string): ObjModel {
  const positions: number[] = [];
  const normals: number[] = [];
  const texcoords: number[] = [];
  const mtllibs: string[] = [];
  const groups: FaceGroup[] = [];

  let current: FaceGroup | null = null;
  let currentMaterial: string | null = null;

  const ensureGroup = (): FaceGroup => {
    if (!current || current.material !== currentMaterial) {
      current = { material: currentMaterial, triangles: [] };
      groups.push(current);
    }
    return current;
  };

  const parseFaceVertex = (token: string): FaceVertex => {
    // token is `v`, `v/vt`, `v//vn`, or `v/vt/vn`
    const [vs, vts, vns] = token.split('/');
    if (vs === undefined || vs === '') throw new RangeError(`invalid face vertex "${token}"`);
    return {
      position: resolveIndex(vs, positions.length / 3),
      texcoord: vts ? resolveIndex(vts, texcoords.length / 2) : -1,
      normal: vns ? resolveIndex(vns, normals.length / 3) : -1,
    };
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;

    const parts = line.split(/\s+/);
    const tag = parts[0];
    switch (tag) {
      case 'v':
        positions.push(num(parts[1], 'v'), num(parts[2], 'v'), num(parts[3], 'v'));
        break;
      case 'vn':
        normals.push(num(parts[1], 'vn'), num(parts[2], 'vn'), num(parts[3], 'vn'));
        break;
      case 'vt':
        // U is required; V defaults to 0, an optional W is ignored.
        texcoords.push(num(parts[1], 'vt'), parts[2] === undefined ? 0 : num(parts[2], 'vt'));
        break;
      case 'usemtl':
        currentMaterial = parts[1] ?? null;
        break;
      case 'mtllib':
        for (const lib of parts.slice(1)) mtllibs.push(lib);
        break;
      case 'f': {
        const verts = parts.slice(1).map(parseFaceVertex);
        if (verts.length < 3) break;
        const group = ensureGroup();
        // Fan-triangulate: (0, i, i+1).
        for (let i = 1; i + 1 < verts.length; i++) {
          group.triangles.push([verts[0]!, verts[i]!, verts[i + 1]!]);
        }
        break;
      }
      default:
        // o, g, s, and anything else: no geometry impact for our models.
        break;
    }
  }

  return { positions, normals, texcoords, mtllibs, groups };
}

/** Parse MTL text into a map of material name → {@link Material}. */
export function parseMtl(text: string): Map<string, Material> {
  const materials = new Map<string, Material>();

  let name: string | null = null;
  let diffuse: [number, number, number] = [1, 1, 1];
  let opacity = 1;
  let shininess = 0;
  let diffuseMap: string | null = null;

  const flush = (): void => {
    if (name !== null) materials.set(name, { name, diffuse, opacity, shininess, diffuseMap });
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    switch (parts[0]) {
      case 'newmtl':
        flush();
        name = parts[1] ?? '';
        diffuse = [1, 1, 1];
        opacity = 1;
        shininess = 0;
        diffuseMap = null;
        break;
      case 'Kd':
        diffuse = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
        break;
      case 'd':
        opacity = Number(parts[1]);
        break;
      case 'Tr':
        // Some exporters use Tr = 1 - d.
        opacity = 1 - Number(parts[1]);
        break;
      case 'Ns':
        shininess = Number(parts[1]);
        break;
      case 'map_Kd':
        diffuseMap = parts[parts.length - 1] ?? null;
        break;
      default:
        break;
    }
  }
  flush();
  return materials;
}
