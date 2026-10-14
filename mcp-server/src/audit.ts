import fs from 'node:fs';
import path from 'node:path';

/** Append-only JSONL audit log for every mutating operation. */
export class Audit {
  constructor(private readonly logFile: string) {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
  }

  log(entry: Record<string, unknown>): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    fs.appendFileSync(this.logFile, line, 'utf8');
  }
}
