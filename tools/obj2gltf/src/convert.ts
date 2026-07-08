/**
 * convert.ts — orchestration glue between the OBJ parser and the glTF emitter.
 */

import { convertToGltf, type ConvertOptions, type Gltf } from './gltf.js';
import { parseMtl, parseObj, type Material } from './obj.js';

/** Convert OBJ text (with an MTL resolver) into a glTF document. */
export function objToGltf(
  objText: string,
  resolveMtl: (filename: string) => string | null,
  options: ConvertOptions = {},
): Gltf {
  const model = parseObj(objText);

  const materials = new Map<string, Material>();
  for (const lib of model.mtllibs) {
    const mtlText = resolveMtl(lib);
    if (mtlText === null) continue; // missing .mtl → materials fall back to default
    for (const [name, material] of parseMtl(mtlText)) materials.set(name, material);
  }

  return convertToGltf(model, materials, options);
}
