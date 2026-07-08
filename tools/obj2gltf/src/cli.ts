/**
 * cli.ts — batch OBJ → glTF conversion.
 *
 * Usage:
 *   obj2gltf <out-dir> <model.obj> [more.obj …]
 *
 * Each `<model.obj>` is converted to `<out-dir>/<basename>.gltf`. `mtllib`
 * references are resolved relative to each OBJ's own directory. Exit code is 0
 * on success, 2 on a usage/IO error.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { argv, exit, stderr, stdout } from 'node:process';
import { objToGltf } from './convert.js';

function fail(message: string): never {
  stderr.write(`obj2gltf: ${message}\n`);
  return exit(2);
}

function main(): void {
  const [outDir, ...objPaths] = argv.slice(2);
  if (!outDir || objPaths.length === 0) {
    fail('usage: obj2gltf <out-dir> <model.obj> [more.obj …]');
  }
  mkdirSync(outDir, { recursive: true });

  for (const objPath of objPaths) {
    let objText: string;
    try {
      objText = readFileSync(objPath, 'utf8');
    } catch (e) {
      fail(`could not read ${objPath}: ${(e as Error).message}`);
    }

    const objDir = dirname(objPath);
    const gltf = objToGltf(
      objText,
      (lib) => {
        const libPath = resolve(objDir, lib);
        return existsSync(libPath) ? readFileSync(libPath, 'utf8') : null;
      },
      { generator: 'obj2gltf (crack-attack)' },
    );

    const outName = basename(objPath).replace(/\.obj$/i, '') + '.gltf';
    const outPath = join(outDir, outName);
    writeFileSync(outPath, JSON.stringify(gltf.json, null, 2) + '\n');
    stdout.write(`${objPath} → ${outPath}\n`);
  }
}

main();
