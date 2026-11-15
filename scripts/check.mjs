import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

const files = [];
for (const folder of ['src', 'scripts', 'test']) {
  let entries;
  try {
    entries = await readdir(folder);
  } catch {
    continue;
  }
  for (const name of entries) {
    if (/\.(mjs|cjs|js)$/.test(name)) files.push(`${folder}/${name}`);
  }
}

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

for (const file of ['src/client.js', 'src/remote.mjs']) {
  const code = await readFile(file, 'utf8');
  if (/from\s+['"]node:|require\(['"](?:node:|fs|path|child_process|crypto|http)/.test(code)) {
    throw new Error(`${file} contains a Node dependency`);
  }
}
try {
  const bundled = await readFile('lib/client.js', 'utf8');
  if (/from\s+['"]node:|require\(['"](?:node:|fs|path|child_process|crypto|http)/.test(bundled)) {
    throw new Error('lib/client.js contains a Node dependency');
  }
  const result = spawnSync(process.execPath, ['--check', 'lib/client.js'], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

const sourceNames = new Set(await readdir('src'));
for (const name of sourceNames) {
  if (!/\.(mjs|js)$/.test(name)) continue;
  const source = await readFile(`src/${name}`, 'utf8');
  for (const match of source.matchAll(/(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]/g)) {
    const specifier = match[1] ?? match[2];
    if (!specifier?.startsWith('./')) continue;
    const target = specifier.slice(2);
    if (target.includes('/') || !sourceNames.has(target)) {
      throw new Error(`src/${name} 引用了 src 之外或不存在的模块：${specifier}`);
    }
  }
}

const manifest = JSON.parse(await readFile('package.json', 'utf8'));
if (!manifest.dsh?.bundle?.patch || !manifest.exports['./client'] || !manifest.exports['./locale/*.json'] || !manifest.exports['./icon']) {
  throw new Error('Invalid plugin manifest');
}

for (const loc of ['locale/en.json', 'locale/zh.json']) {
  const parsed = JSON.parse(await readFile(loc, 'utf8'));
  if (!parsed?.meta?.title || !parsed?.meta?.description) {
    throw new Error(`${loc} 缺少 meta.title 或 meta.description`);
  }
}

console.log(`Syntax checked ${files.length} sources; manifest, locales, client boundary and import closure checked`);
