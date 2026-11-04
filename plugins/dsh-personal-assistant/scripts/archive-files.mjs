export function archiveFiles(output) {
  const files = [];
  for (const line of output.split(/\r\n|\n|\r/)) {
    if (!line) continue;
    const path = line.replaceAll('\\', '/');
    if (!path.startsWith('package/') || path.split('/').includes('..')) {
      throw new Error('INVALID_PACKAGE_ARCHIVE_PATH');
    }
    if (!path.endsWith('/')) files.push({ path: path.slice(8) });
  }
  if (!files.length) throw new Error('EMPTY_PACKAGE_ARCHIVE');
  return files;
}

export function checkPackedFiles(files, expectedFiles) {
  if (!files.length) throw new Error('EMPTY_PACKAGE');
  const paths = new Set();
  for (const file of files) {
    const path = file.path.replaceAll('\\', '/');
    if (path.startsWith('/') || /^[A-Za-z]:/.test(path) || path.split('/').some(part => !part || part === '..' || part === '.')
      || /(^|\/)(\.git|\.dsh|\.local|node_modules|src|\.env[^/]*|\.credentials[^/]*|runtime)(\/|$)/i.test(path)
      || /(^|\/)(docs?|tests?|__tests__|fixtures?|spikes|artifacts)(\/|$)/i.test(path)
      || /\.(test|spec)\.[^/]+$/i.test(path)
      || /\.(?:sqlite(?:-wal|-shm)?|pem|key)$/i.test(path)) throw new Error('PRIVATE_OR_RUNTIME_FILE_IN_PACKAGE: ' + path);
    if (paths.has(path)) throw new Error('DUPLICATE_PACKAGE_FILE: ' + path);
    paths.add(path);
  }
  if (expectedFiles) {
    const expected = new Set(['package.json', ...expectedFiles]);
    for (const path of paths) if (!expected.has(path)) throw new Error('UNEXPECTED_PACKAGE_FILE: ' + path);
    for (const path of expected) if (!paths.has(path)) throw new Error('MISSING_PACKAGE_FILE: ' + path);
  }
}
