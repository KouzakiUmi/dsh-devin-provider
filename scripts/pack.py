"""Build an npm-compatible tarball from the existing plugin build, without npm/install hooks."""
import argparse
import hashlib
import json
from glob import glob
from pathlib import Path
import tarfile

root = Path(__file__).resolve().parent.parent
manifest = json.loads((root / 'package.json').read_text(encoding='utf-8'))
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output-dir', default='artifacts', help='Output directory, relative to the source root unless absolute')
args = parser.parse_args()
output_dir = (root / args.output_dir).resolve()
output = output_dir / f"{manifest['name']}-{manifest['version']}.tgz"
checksum = output.with_suffix(output.suffix + '.sha256')
if output.exists() or checksum.exists():
    raise SystemExit(f'Will not overwrite an existing artifact or checksum: {output}')

# Keep the tarball in sync with package.json "files": directories are expanded,
# globs are resolved, and package.json itself is always included.
files = [root / 'package.json']
for entry in manifest.get('files', []):
    for match in sorted(glob(str(root / entry))):
        candidate = Path(match)
        if candidate.is_dir():
            files.extend(sorted(p for p in candidate.rglob('*') if p.is_file()))
        elif candidate.is_file():
            files.append(candidate)
files = sorted(set(files))
if not (root / 'lib' / 'index.mjs').is_file() or not (root / 'lib' / 'client.js').is_file():
    raise SystemExit('Build the plugin before packing')
for path in files:
    if path.is_symlink() or not path.resolve().is_relative_to(root):
        raise SystemExit(f'Refusing an unsafe package path: {path}')
output.parent.mkdir(parents=True, exist_ok=True)

with output.open('xb') as stream:
    with tarfile.open(fileobj=stream, mode='w:gz') as archive:
        for path in files:
            archive.add(path, arcname='package/' + path.relative_to(root).as_posix(), recursive=False)
with tarfile.open(output, 'r:gz') as archive:
    names = archive.getnames()
    assert 'package/package.json' in names and 'package/lib/index.mjs' in names
    assert not any('/.reference/' in name or '/test/' in name or '/test-output/' in name for name in names)
digest = hashlib.sha256(output.read_bytes()).hexdigest()
with checksum.open('x', encoding='utf-8', newline='\n') as stream:
    stream.write(f'{digest}  {output.name}\n')
print(f'Packed {len(files)} files: {output.name} ({output.stat().st_size} bytes)')
print('SHA256:', digest)
