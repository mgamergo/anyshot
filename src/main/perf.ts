import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';
import { formatPerfReport, type PerfReport } from '../shared/perf';

function perfLogPath(): string {
  if (app && typeof app.isPackaged === 'boolean' && !app.isPackaged) {
    return join(app.getAppPath(), 'perf-log.txt');
  }
  return join(process.cwd(), 'perf-log.txt');
}

/** Logs a readable timing breakdown to stdout and appends it to perf-log.txt when ANYSHOT_PERF=1. */
export function logPerf(report: PerfReport): void {
  if (process.env.ANYSHOT_PERF !== '1') return;
  const text = formatPerfReport(report);
  console.log(text);
  if (process.env.VITEST) return;
  try {
    appendFileSync(perfLogPath(), `${text}\n\n`, 'utf8');
  } catch (error) {
    console.warn('[perf] failed to write perf-log.txt', error);
  }
}
