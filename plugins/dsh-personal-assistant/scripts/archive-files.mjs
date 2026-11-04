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
