/**
 * @crack-attack/obj2gltf — Wavefront OBJ (+MTL) → glTF 2.0 conversion.
 *
 * A one-time build tool: convert the original `data/models/*.obj` sources to
 * glTF for the Three.js client. Do NOT transcribe the generated `obj_*.cxx`
 * files — convert from the `.obj` sources (see BROWSER_PORT_PLAN.md).
 */

export * from './obj.js';
export * from './gltf.js';
export * from './convert.js';
