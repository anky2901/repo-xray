import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import { ScanResult, Finding } from '@repo-xray/types';

export interface ScanSummary {
  id: string;
  repoId: string;
  startedAt: string;
  completedAt?: string;
  mode: string;
  status: string;
}

export interface ScanDiff {
  addedFindings: Finding[];
  removedFindings: Finding[];
  scoresDelta: Record<string, number>;
  error?: string;
}

interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
}

// Each migration is atomic. Add new entries to grow the schema safely.
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS scans (
          id TEXT PRIMARY KEY,
          repo_id TEXT NOT NULL,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          mode TEXT NOT NULL,
          status TEXT NOT NULL,
          result JSON
        );

        CREATE TABLE IF NOT EXISTS findings (
          id TEXT PRIMARY KEY,
          scan_id TEXT NOT NULL,
          module_id TEXT NOT NULL,
          severity TEXT NOT NULL,
          confidence INTEGER NOT NULL,
          title TEXT NOT NULL,
          data JSON NOT NULL,
          FOREIGN KEY (scan_id) REFERENCES scans(id)
        );

        CREATE INDEX IF NOT EXISTS idx_findings_scan ON findings(scan_id);
        CREATE INDEX IF NOT EXISTS idx_scans_repo ON scans(repo_id);
        CREATE INDEX IF NOT EXISTS idx_findings_severity ON findings(severity);
        CREATE INDEX IF NOT EXISTS idx_scans_started_at ON scans(started_at);
      `);
    },
  },
  {
    version: 2,
    name: 'add_schema_version_table',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_version (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        );
      `);
    },
  },
];

export class ScanStore {
  private db: Database.Database;

  constructor(dbPath: string = '.xray-reports/xray.db') {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('foreign_keys = ON');
    this.runMigrations();
  }

  private runMigrations(): void {
    // Bootstrap: ensure schema_version exists before querying it.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    const currentVersionRow = this.db
      .prepare('SELECT MAX(version) as v FROM schema_version')
      .get() as { v: number | null };
    const currentVersion = currentVersionRow.v ?? 0;

    const pending = MIGRATIONS.filter((m) => m.version > currentVersion);
    for (const migration of pending) {
      const apply = this.db.transaction(() => {
        migration.up(this.db);
        this.db
          .prepare('INSERT OR REPLACE INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)')
          .run(migration.version, migration.name, 'schema-managed');
      });
      apply();
    }
  }

  close(): void {
    this.db.close();
  }

  saveScan(result: ScanResult): void {
    const stmtScan = this.db.prepare(`
      INSERT OR REPLACE INTO scans (id, repo_id, started_at, completed_at, mode, status, result)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const stmtFinding = this.db.prepare(`
      INSERT OR REPLACE INTO findings (id, scan_id, module_id, severity, confidence, title, data)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const transaction = this.db.transaction((res: ScanResult) => {
      stmtScan.run(
        res.scanId,
        res.repoId,
        res.meta.runtime.startedAt,
        res.meta.runtime.completedAt,
        res.mode,
        'completed',
        JSON.stringify(res)
      );

      for (const finding of res.findings) {
        stmtFinding.run(
          finding.id,
          res.scanId,
          finding.module,
          finding.severity,
          finding.confidence,
          finding.title,
          JSON.stringify(finding)
        );
      }
    });

    transaction(result);
  }

  getScan(id: string): ScanResult | null {
    const row = this.db.prepare('SELECT result FROM scans WHERE id = ?').get(id) as { result: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.result) as ScanResult;
  }

  listScans(repoId: string): ScanSummary[] {
    const rows = this.db
      .prepare('SELECT id, repo_id, started_at, completed_at, mode, status FROM scans WHERE repo_id = ? ORDER BY started_at DESC')
      .all(repoId);
    return rows.map((r: unknown) => {
      const row = r as { id: string; repo_id: string; started_at: string; completed_at?: string; mode: string; status: string };
      return {
        id: row.id,
        repoId: row.repo_id,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        mode: row.mode,
        status: row.status,
      };
    });
  }

  compareScans(idA: string, idB: string): ScanDiff {
    const scanA = this.getScan(idA);
    const scanB = this.getScan(idB);

    if (!scanA || !scanB) {
      return {
        addedFindings: [],
        removedFindings: [],
        scoresDelta: {},
        error: `Scan not found: ${!scanA ? idA : idB}`,
      };
    }

    const idsInA = new Set(scanA.findings.map((f) => f.id));
    const idsInB = new Set(scanB.findings.map((f) => f.id));

    const addedFindings = scanB.findings.filter((f) => !idsInA.has(f.id));
    const removedFindings = scanA.findings.filter((f) => !idsInB.has(f.id));

    const scoresDelta: Record<string, number> = {};
    const aScores = scanA.scores as unknown as Record<string, number>;
    const bScores = scanB.scores as unknown as Record<string, number>;
    for (const key of Object.keys(aScores)) {
      if (typeof bScores[key] === 'number') {
        scoresDelta[key] = bScores[key] - aScores[key];
      }
    }

    return { addedFindings, removedFindings, scoresDelta };
  }
}
