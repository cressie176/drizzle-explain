const { ok } = require('node:assert/strict');
const { describe, test } = require('node:test');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

const entryPoints = [
  { specifier: 'drizzle-explain', file: 'lib/index.js', names: ['createExplain', 'Operation'] },
  { specifier: 'drizzle-explain/postgres', file: 'postgres.js', names: ['postgresDriver'] },
  { specifier: 'drizzle-explain/mariadb', file: 'mariadb.js', names: ['mariadbDriver'] },
];

describe('package entry points', () => {
  for (const { specifier, file, names } of entryPoints) {
    test(`${specifier} exposes ${names.join(' and ')} to a named ESM import`, async () => {
      const imported = await import(pathToFileURL(join(__dirname, '..', file)).href);

      for (const name of names) {
        ok(name in imported, `${specifier} does not expose ${name} as a named export`);
      }
    });
  }
});
