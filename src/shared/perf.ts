export type PerfMetrics = Record<string, number>;
export type PerfMeta = Record<string, string | number | boolean>;

export interface PerfReport {
  phase: 'cold-launch' | 'open-overlay' | 'deliver';
  ts: string;
  meta?: PerfMeta;
  metrics: PerfMetrics;
}

export interface OverlayPaintedPerf {
  metrics: PerfMetrics;
  sentEpochMs: number;
}

export interface DeliverPerf {
  metrics: PerfMetrics;
  sentEpochMs: number;
}

export function roundMs(ms: number): number {
  return Math.round(ms * 100) / 100;
}

export function epochMs(): number {
  return performance.timeOrigin + performance.now();
}

/** Tiny monotonic stopwatch for collecting phase breakdown timings (in ms). */
export class PerfTimer {
  readonly t0: number;
  readonly metrics: PerfMetrics = {};

  constructor(start = performance.now()) {
    this.t0 = start;
  }

  mark(name: string, from = this.t0): number {
    const ms = roundMs(performance.now() - from);
    this.metrics[name] = ms;
    return ms;
  }

  set(name: string, ms: number): void {
    this.metrics[name] = roundMs(ms);
  }

  async async<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      this.mark(name, start);
    }
  }

  sync<T>(name: string, fn: () => T): T {
    const start = performance.now();
    try {
      return fn();
    } finally {
      this.mark(name, start);
    }
  }

  merge(extra: PerfMetrics | undefined, prefix = ''): void {
    if (!extra) return;
    for (const [k, v] of Object.entries(extra)) {
      this.metrics[prefix ? `${prefix}.${k}` : k] = roundMs(v);
    }
  }
}

export function formatPerfReport(report: PerfReport): string {
  const metaStr = report.meta
    ? ` (${Object.entries(report.meta)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ')})`
    : '';
  const lines = [`[perf] ${report.phase}${metaStr} @ ${report.ts}`];
  for (const [k, v] of Object.entries(report.metrics)) {
    lines.push(`  ${k}: ${v.toFixed(2)} ms`);
  }
  lines.push(`  JSON: ${JSON.stringify(report)}`);
  return lines.join('\n');
}
