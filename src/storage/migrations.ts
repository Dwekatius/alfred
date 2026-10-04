/**
 * Schema migrations. Applied in order inside a single transaction each.
 * Never edit an applied migration; append a new one.
 */
import { Database } from "./database.js";

interface Migration {
  version: number;
  name: string;
  sql: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial schema",
    sql: `
      CREATE TABLE meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE updates (
        update_id INTEGER PRIMARY KEY,
        received_at TEXT NOT NULL,
        message_ts INTEGER,
        kind TEXT NOT NULL,
        decision TEXT NOT NULL,
        job_id TEXT,
        control_id TEXT
      );

      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        owner_chat_id TEXT NOT NULL,
        session_file TEXT,
        created_at TEXT NOT NULL,
        archived_at TEXT,
        next_model_json TEXT
      );

      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        source_update_id INTEGER UNIQUE,
        source_message_id INTEGER,
        conversation_id TEXT NOT NULL REFERENCES conversations(id),
        task_text TEXT NOT NULL,
        task_label TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'task',
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        config_hash TEXT,
        model_json TEXT,
        lease_generation INTEGER NOT NULL DEFAULT 0,
        result_text TEXT,
        error_code TEXT,
        error_message TEXT,
        linked_job_id TEXT,
        stale INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX idx_jobs_state ON jobs(state);
      CREATE INDEX idx_jobs_created ON jobs(created_at);

      CREATE TABLE job_events (
        job_id TEXT NOT NULL REFERENCES jobs(id),
        seq INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        event_type TEXT NOT NULL,
        tool_name TEXT,
        observation_id TEXT,
        artifact_id TEXT,
        summary TEXT,
        PRIMARY KEY (job_id, seq)
      );

      CREATE TABLE approvals (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES jobs(id),
        owner_user_id TEXT NOT NULL,
        owner_chat_id TEXT NOT NULL,
        action_type TEXT NOT NULL,
        action_digest TEXT NOT NULL,
        preview TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        decision TEXT,
        decided_at TEXT,
        used_at TEXT,
        request_id TEXT
      );

      CREATE INDEX idx_approvals_job ON approvals(job_id);

      CREATE TABLE artifacts (
        id TEXT PRIMARY KEY,
        job_id TEXT,
        conversation_id TEXT,
        relative_path TEXT NOT NULL,
        kind TEXT NOT NULL,
        mime TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        width INTEGER,
        height INTEGER,
        checksum TEXT,
        capture_meta_json TEXT,
        upload_state TEXT NOT NULL DEFAULT 'none',
        created_at TEXT NOT NULL
      );

      CREATE INDEX idx_artifacts_job ON artifacts(job_id);

      CREATE TABLE outbox (
        id TEXT PRIMARY KEY,
        logical_key TEXT NOT NULL UNIQUE,
        owner_chat_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        artifact_id TEXT,
        state TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        telegram_message_id INTEGER,
        last_error TEXT,
        delivery_unknown INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX idx_outbox_state ON outbox(state, next_attempt_at);

      CREATE TABLE controls (
        id TEXT PRIMARY KEY,
        source_update_id INTEGER UNIQUE,
        job_id TEXT,
        command TEXT NOT NULL,
        created_at TEXT NOT NULL,
        applied_at TEXT
      );

      CREATE INDEX idx_controls_applied ON controls(applied_at);

      CREATE TABLE pairing (
        candidate_user_id TEXT PRIMARY KEY,
        candidate_chat_id TEXT NOT NULL,
        display_name TEXT,
        code_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        status TEXT NOT NULL
      );
    `,
  },
  {
    version: 2,
    name: "questions and job limits",
    sql: `
      CREATE TABLE questions (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL REFERENCES jobs(id),
        owner_user_id TEXT NOT NULL,
        owner_chat_id TEXT NOT NULL,
        question TEXT NOT NULL,
        options_json TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        status TEXT NOT NULL,
        answer TEXT,
        answered_at TEXT,
        telegram_message_id INTEGER
      );

      CREATE INDEX idx_questions_job ON questions(job_id, status);

      ALTER TABLE jobs ADD COLUMN tool_calls INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE jobs ADD COLUMN model_turns INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE jobs ADD COLUMN paused_at TEXT;
      ALTER TABLE jobs ADD COLUMN cancel_reason TEXT;
    `,
  },
  {
    version: 3,
    name: "job attachments",
    sql: `
      ALTER TABLE jobs ADD COLUMN attachments_json TEXT;
    `,
  },
  {
    version: 4,
    name: "dashboard telemetry",
    sql: `
      CREATE TABLE stream_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        job_id TEXT,
        kind TEXT NOT NULL,
        text TEXT NOT NULL
      );

      CREATE INDEX idx_stream_events_ts ON stream_events(timestamp);
      CREATE INDEX idx_stream_events_job ON stream_events(job_id);

      CREATE TABLE usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        job_id TEXT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0
      );

      CREATE INDEX idx_usage_events_ts ON usage_events(timestamp);
    `,
  },
  {
    version: 5,
    name: "stream block updates",
    sql: `
      ALTER TABLE stream_events ADD COLUMN updated_at TEXT;
      UPDATE stream_events SET updated_at = timestamp WHERE updated_at IS NULL;
      CREATE INDEX idx_stream_events_updated ON stream_events(updated_at);
    `,
  },
];

export function runMigrations(db: Database): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  );`);
  const appliedRows = db.prepare("SELECT version FROM schema_migrations").all() as Array<{ version: number }>;
  const applied = new Set(appliedRows.map((row) => row.version));
  let last = 0;
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) {
      last = Math.max(last, migration.version);
      continue;
    }
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)").run(migration.version, migration.name, new Date().toISOString());
    });
    last = migration.version;
  }
  return last;
}

export function latestMigrationVersion(): number {
  return MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
}
