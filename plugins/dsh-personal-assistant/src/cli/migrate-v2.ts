#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { migrateDirectory } from '../storage/migrate-v2.js';
export { migrateDirectory };

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  try {
    const args = process.argv.slice(2);
    if (args.includes('--help')) {
      console.log(
        'migrate-v2 --source /old/data --destination /new/data\nmigrate-v2 --fresh --destination /new/data',
      );
    } else {
      const values: Record<string, string> = {};
      let fresh = false;
      for (let index = 0; index < args.length; index++) {
        if (args[index] === '--fresh') {
          fresh = true;
          continue;
        }
        if (
          !['--source', '--destination'].includes(args[index]) ||
          !args[index + 1] ||
          args[index + 1].startsWith('--') ||
          values[args[index]]
        )
          throw new Error('INVALID_MIGRATION_ARGUMENTS');
        values[args[index]] = args[++index];
      }
      if (!values['--destination'] || fresh === Boolean(values['--source']))
        throw new Error('Specify --source or --fresh, and --destination');
      console.log(
        JSON.stringify(
          migrateDirectory({ source: values['--source'], destination: values['--destination'] }),
          null,
          2,
        ),
      );
    }
  } catch (error) {
    const failure = error as Error & { code?: string; details?: unknown };
    console.error(
      JSON.stringify({ error: failure.code ?? failure.message, details: failure.details ?? null }),
    );
    process.exitCode = 1;
  }
}
