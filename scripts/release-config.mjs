import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const root = fileURLToPath(new URL('../', import.meta.url));
export function inside(base, path) {
  if (typeof path !== 'string' || !path || isAbsolute(path)) throw new Error('INVALID_PACKAGE_PATH');
  const target = resolve(base, path), rel = relative(base, target);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('PACKAGE_PATH_ESCAPES_ROOT');
  if (existsSync(target)) {
    const realRel = relative(realpathSync(base), realpathSync(target));
    if (realRel === '..' || realRel.startsWith('..' + sep) || isAbsolute(realRel)) throw new Error('PACKAGE_SYMLINK_ESCAPES_ROOT');
  }
  return target;
}

export function checkRelease(base = root, tag = process.env.GITHUB_REF_NAME, { built = true } = {}) {
  const config = JSON.parse(readFileSync(resolve(base, 'release/config.json'), 'utf8'));
  if (config.schemaVersion !== 1 || config.releaseEnabled !== true) throw new Error('RELEASE_NOT_READY: the installable plugin has not passed its release acceptance.');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repository)) throw new Error('INVALID_REPOSITORY');
  if (!/^[a-z0-9-]+\.tgz$/.test(config.assetName)) throw new Error('INVALID_ASSET_NAME');
  const directory = inside(base, config.packageDirectory);
  const pkg = JSON.parse(readFileSync(resolve(directory, 'package.json'), 'utf8'));
  if (pkg.private !== false) throw new Error('PACKAGE_NOT_PUBLIC');
  if (!pkg.name || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(pkg.version)) throw new Error('INVALID_PACKAGE_VERSION');
  if (tag !== 'v' + pkg.version) throw new Error('TAG_VERSION_MISMATCH');
  if (!pkg.license || pkg.license === 'UNLICENSED') throw new Error('DISTRIBUTION_LICENSE_REQUIRED');
  if (!pkg.engines?.dsh || !pkg.dsh?.bundle?.patch) throw new Error('DSH_BUNDLE_REQUIRED');
  if (!Array.isArray(pkg.files) || !pkg.files.length || pkg.files.includes('*') || pkg.files.includes('**')) throw new Error('PACKAGE_FILE_ALLOWLIST_REQUIRED');
  for (const path of [pkg.main, ...[pkg.dsh.bundle.patch].flat()]) {
    if (!path) throw new Error('PACKAGE_ENTRY_MISSING');
    const entry = inside(directory, path);
    if (built && !existsSync(entry)) throw new Error('PACKAGE_ENTRY_MISSING');
  }
  for (const script of ['build', 'test', 'test:package']) {
    if (!pkg.scripts?.[script]) throw new Error('REQUIRED_SCRIPT_MISSING: ' + script);
  }
  return { config, pkg, directory, tag };
}

export function checkPackedFiles(files) {
  if (!files.length) throw new Error('EMPTY_PACKAGE');
  for (const file of files) {
    const path = file.path.replaceAll('\\', '/');
    if (path.startsWith('/') || path.split('/').includes('..')
      || /(^|\/)(\.git|\.dsh|node_modules|\.env[^/]*|\.credentials[^/]*|state\.sqlite[^/]*|runtime)(\/|$)/i.test(path)
      || /\.(?:sqlite(?:-wal|-shm)?|pem|key)$/i.test(path)) throw new Error('PRIVATE_OR_RUNTIME_FILE_IN_PACKAGE: ' + path);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = checkRelease(root, process.env.GITHUB_REF_NAME, { built: false });
    console.log(JSON.stringify({ repository: result.config.repository, tag: result.tag, package: result.pkg.name }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
