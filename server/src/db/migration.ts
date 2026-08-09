import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveBinary } from 'dbmate';

import { repositoryRoot } from '../config/env.js';
import {
  applyBaselineCompatMigrations,
  assertNoLegacySchema,
  rebuildBaselineForeignKeys,
  tableExists
} from './schema-compat.js';
import { log } from '../services/log-service.js';
import { storageService } from '../services/storage-service.js';

export const BASELINE_MIGRATION_VERSION = '000001';
const SCHEMA_MIGRATIONS_TABLE_SQL = 'CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY)';
const APP_SCHEMA_TABLES = [
  'folders',
  'images',
  'places',
  'scan_runs',
  'app_settings',
  'folder_scan_state',
  'likes',
  'collections',
  'collection_items',
  'folder_share_links',
  'folder_share_passwords'
] as const;

export interface BaselineResult {
  baselineInserted: boolean;
  existingSchemaDetected: boolean;
}

export interface StartupMigrationResult {
  baselineInserted: boolean;
  databasePath: string;
  usedInMemoryDatabase: boolean;
}

export interface StartupMigrationOptions {
  databasePath?: string;
  migrationsDirectory?: string;
  spawnSyncImpl?: typeof spawnSync;
}

function defaultMigrationsDirectory(): string {
  return path.join(repositoryRoot, 'server', 'db', 'migrations');
}

function baselineMigrationPath(migrationsDirectory: string): string {
  return path.join(migrationsDirectory, `${BASELINE_MIGRATION_VERSION}_baseline.sql`);
}

function extractMigrationUpSql(migrationSql: string): string {
  const lines = migrationSql.split(/\r?\n/);
  const upLines: string[] = [];
  let inUpSection = false;

  for (const line of lines) {
    if (/^\s*--\s*migrate:up\b/i.test(line)) {
      inUpSection = true;
      continue;
    }

    if (/^\s*--\s*migrate:down\b/i.test(line)) {
      break;
    }

    if (inUpSection) {
      upLines.push(line);
    }
  }

  if (!inUpSection || upLines.length === 0) {
    throw new Error(`Baseline migration is missing an up section: ${migrationSql}`);
  }

  return upLines.join('\n').trim();
}

function applyBaselineSchema(database: DatabaseSync, migrationsDirectory: string): void {
  const migrationSql = fs.readFileSync(baselineMigrationPath(migrationsDirectory), 'utf8');
  database.exec(extractMigrationUpSql(migrationSql));
}

function buildSqliteDatabaseUrl(databasePath: string): string {
  return `sqlite:${pathToFileURL(databasePath).pathname}`;
}

function hasExistingAppSchema(database: DatabaseSync): boolean {
  return APP_SCHEMA_TABLES.some((tableName) => tableExists(database, tableName));
}

function migrationVersionExists(database: DatabaseSync, version: string): boolean {
  if (!tableExists(database, 'schema_migrations')) {
    return false;
  }

  const row = database
    .prepare('SELECT version FROM schema_migrations WHERE version = ? LIMIT 1')
    .get(version) as { version: string } | undefined;

  return row?.version === version;
}

export function baselineExistingDatabaseIfNeeded(databasePath: string, options: StartupMigrationOptions = {}): BaselineResult {
  const database = new DatabaseSync(databasePath);
  const migrationsDirectory = options.migrationsDirectory ?? defaultMigrationsDirectory();

  try {
    assertNoLegacySchema(database);

    const existingSchemaDetected = hasExistingAppSchema(database);
    if (!existingSchemaDetected || migrationVersionExists(database, BASELINE_MIGRATION_VERSION)) {
      return {
        baselineInserted: false,
        existingSchemaDetected
      };
    }

    applyBaselineCompatMigrations(database);
    applyBaselineSchema(database, migrationsDirectory);
    const rebuiltForeignKeys = rebuildBaselineForeignKeys(database);
    if (rebuiltForeignKeys) {
      applyBaselineSchema(database, migrationsDirectory);
    }
    database.exec(SCHEMA_MIGRATIONS_TABLE_SQL);
    database.prepare('INSERT OR IGNORE INTO schema_migrations(version) VALUES (?)').run(BASELINE_MIGRATION_VERSION);

    return {
      baselineInserted: true,
      existingSchemaDetected
    };
  } finally {
    database.close();
  }
}

function runDbmateUp(databasePath: string, options: StartupMigrationOptions = {}): void {
  const spawnSyncImpl = options.spawnSyncImpl ?? spawnSync;
  const result = spawnSyncImpl(
    resolveBinary(),
    [
      '--url',
      buildSqliteDatabaseUrl(databasePath),
      '--migrations-dir',
      options.migrationsDirectory ?? defaultMigrationsDirectory(),
      '--no-dump-schema',
      'up'
    ],
    {
      cwd: repositoryRoot,
      env: process.env,
      stdio: 'inherit'
    }
  );

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`Dbmate exited with status ${result.status ?? 'unknown'}`);
  }
}

export function runStartupMigrations(options: StartupMigrationOptions = {}): StartupMigrationResult {
  const databasePath = options.databasePath ?? storageService.getDatabasePath();
  if (databasePath === ':memory:') {
    log.info('Skipping Dbmate migrations because the configured database directory is unavailable');
    return {
      baselineInserted: false,
      databasePath,
      usedInMemoryDatabase: true
    };
  }

  const baselineResult = baselineExistingDatabaseIfNeeded(databasePath, options);
  runDbmateUp(databasePath, options);

  return {
    baselineInserted: baselineResult.baselineInserted,
    databasePath,
    usedInMemoryDatabase: false
  };
}
