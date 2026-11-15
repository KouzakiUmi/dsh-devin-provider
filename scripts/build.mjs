import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const target = new URL('lib/', root);

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });

const modules = (await readdir(new URL('src/', root))).filter((name) => /\.(?:mjs|json)$/.test(name));
for (const name of modules) {
  await copyFile(new URL(`src/${name}`, root), new URL(name, target));
}

const remote = (await readFile(new URL('src/remote.mjs', root), 'utf8')).replace(/^export /gm, '');
const client = (await readFile(new URL('src/client.js', root), 'utf8')).replace(/^export /gm, '');
const bundle = `window.__ModuleLoader__.load({id:'dsh-devin-provider',factory:(require)=>{\n'use strict';\n${remote}\n${client}\nreturn {name,inject,apply};\n}});\n`;
await writeFile(new URL('client.js', target), bundle);
console.log(`Built ${modules.length + 1} files in ${fileURLToPath(target)}`);
