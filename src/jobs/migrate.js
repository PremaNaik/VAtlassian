import { executeDDL, executeQuery } from '../lib/db.js';
import { MIGRATIONS } from '../db/migrations.js';

function migrationStatements(sql) {
  return sql
    .split(';')
    .map(statement => statement.trim())
    .filter(Boolean);
}

function isDml(statement) {
  return /^\s*(DELETE|INSERT|UPDATE|REPLACE)\b/i.test(statement);
}

export async function run({
  ddl = executeDDL,
  query = executeQuery,
  migrations = MIGRATIONS,
  now = Date.now
} = {}) {
  const bootstrap = migrations.find(
    migration => migration.id === 'v001_config'
  );

  if (!bootstrap) {
    throw new Error('Missing config bootstrap migration');
  }

  // Ensure the migration ledger table exists before reading it.
  const bootstrapResult = await ddl(bootstrap.sql);

  if (!bootstrapResult?.result) {
    return {
      ok: false,
      applied: 0,
      failedAt: bootstrap.id,
      reason: 'BOOTSTRAP_FAILED'
    };
  }

  const ledgerResult = await query(
    `SELECT cfg_key
     FROM va_config
     WHERE cfg_key LIKE 'schema.%'`
  );

  if (!ledgerResult?.result) {
    return {
      ok: false,
      applied: 0,
      reason: 'MIGRATION_LEDGER_UNREADABLE'
    };
  }

  const completed = new Set(
    (ledgerResult.data ?? []).map(row =>
      row.cfg_key.slice('schema.'.length)
    )
  );

  let applied = 0;

  for (const migration of migrations) {
    if (!migration?.id || typeof migration.sql !== 'string') {
      return {
        ok: false,
        applied,
        reason: 'INVALID_MIGRATION'
      };
    }

    if (completed.has(migration.id)) continue;

    if (migration.id === bootstrap.id) {
      // The bootstrap table has already been created above.
      if (!bootstrapResult.result) {
        return {
          ok: false,
          applied,
          failedAt: migration.id
        };
      }
    } else {
      const statements = migrationStatements(migration.sql);

      for (const statement of statements) {
        const result = isDml(statement)
          ? await query(statement)
          : await ddl(statement);

        if (!result?.result) {
          console.error('Migration statement failed:', {
            migration: migration.id,
            operation: statement.match(/^\s*([a-z]+)/i)?.[1] ?? 'UNKNOWN'
          });

          return {
            ok: false,
            applied,
            failedAt: migration.id,
            reason: 'MIGRATION_STATEMENT_FAILED'
          };
        }
      }
    }

    const recorded = await query(
      `INSERT INTO va_config
        (cfg_key, cfg_value, updated_at, updated_by)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         cfg_value = VALUES(cfg_value),
         updated_at = VALUES(updated_at),
         updated_by = VALUES(updated_by)`,
      [
        `schema.${migration.id}`,
        'applied',
        now(),
        'system:migrate'
      ]
    );

    if (!recorded?.result) {
      return {
        ok: false,
        applied,
        failedAt: migration.id,
        reason: 'MIGRATION_RECORD_FAILED'
      };
    }

    applied += 1;
  }

  return {
    ok: true,
    applied
  };
}

export const handler = run;