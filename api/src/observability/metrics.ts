/**
 * Minimal Prometheus registry (text exposition format 0.0.4), no dependency.
 * Counters and histograms live in process memory: they reset on restart and are
 * per replica, which is what Prometheus expects (it sums across scraped targets).
 */
type Labels = Record<string, string>;

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
const labelKey = (labels: Labels) => Object.keys(labels).sort().map((k) => `${k}="${esc(labels[k])}"`).join(',');
const fmt = (name: string, key: string, value: number) => `${name}${key ? `{${key}}` : ''} ${value}`;

interface Histogram { buckets: number[]; sum: number; count: number }

export class MetricsRegistry {
  private readonly help = new Map<string, { type: 'counter' | 'histogram' | 'gauge'; text: string }>();
  private readonly counters = new Map<string, Map<string, number>>();
  private readonly histograms = new Map<string, Map<string, Histogram>>();

  constructor() {
    this.describe('jpo_gateway_requests_total', 'counter', 'Chamadas ao AI Gateway');
    this.describe('jpo_gateway_calls_total', 'counter', 'Chamadas atendidas pelo gateway, por modelo e cache');
    this.describe('jpo_gateway_cache_hits_total', 'counter', 'Acertos de cache do gateway');
    this.describe('jpo_gateway_fallbacks_total', 'counter', 'Trocas de modelo por indisponibilidade');
    this.describe('jpo_gateway_call_duration_seconds', 'histogram', 'Latência das chamadas ao gateway');
    this.describe('jpo_tool_calls_total', 'counter', 'Chamadas de ferramentas por resultado (executed, replay, refused, error)');
    this.describe('jpo_tool_call_duration_seconds', 'histogram', 'Duração da execução das ferramentas');
    this.describe('jpo_rate_limited_total', 'counter', 'Requisições recusadas pelo rate limit');
    this.describe('jpo_http_requests_total', 'counter', 'Requisições HTTP por método, rota e status');
  }

  describe(name: string, type: 'counter' | 'histogram' | 'gauge', text: string) {
    this.help.set(name, { type, text });
  }

  inc(name: string, labels: Labels = {}, by = 1) {
    const series = this.counters.get(name) ?? new Map<string, number>();
    const key = labelKey(labels);
    series.set(key, (series.get(key) ?? 0) + by);
    this.counters.set(name, series);
  }

  observe(name: string, seconds: number, labels: Labels = {}) {
    const series = this.histograms.get(name) ?? new Map<string, Histogram>();
    const key = labelKey(labels);
    const h = series.get(key) ?? { buckets: BUCKETS.map(() => 0), sum: 0, count: 0 };
    BUCKETS.forEach((b, i) => { if (seconds <= b) h.buckets[i]++; });
    h.sum += seconds;
    h.count++;
    series.set(key, h);
    this.histograms.set(name, series);
  }

  value(name: string, labels: Labels = {}): number {
    return this.counters.get(name)?.get(labelKey(labels)) ?? 0;
  }

  /** Renders counters, histograms and the given gauges (computed at scrape time). */
  render(gauges: { name: string; help: string; series: { labels: Labels; value: number }[] }[] = []): string {
    const out: string[] = [];
    const head = (name: string) => {
      const h = this.help.get(name);
      if (h) out.push(`# HELP ${name} ${h.text}`, `# TYPE ${name} ${h.type}`);
    };
    for (const [name, series] of this.counters) {
      head(name);
      for (const [key, v] of series) out.push(fmt(name, key, v));
    }
    for (const [name, series] of this.histograms) {
      head(name);
      for (const [key, h] of series) {
        const sep = key ? `${key},` : '';
        BUCKETS.forEach((b, i) => out.push(`${name}_bucket{${sep}le="${b}"} ${h.buckets[i]}`));
        out.push(`${name}_bucket{${sep}le="+Inf"} ${h.count}`, fmt(`${name}_sum`, key, h.sum), fmt(`${name}_count`, key, h.count));
      }
    }
    for (const g of gauges) {
      out.push(`# HELP ${g.name} ${g.help}`, `# TYPE ${g.name} gauge`);
      for (const s of g.series) out.push(fmt(g.name, labelKey(s.labels), s.value));
    }
    return `${out.join('\n')}\n`;
  }
}

/** Process wide registry (like prom-client's default registry). */
export const metrics = new MetricsRegistry();

/** Seconds elapsed since a process.hrtime.bigint() start. */
export const secondsSince = (start: bigint): number => Number(process.hrtime.bigint() - start) / 1e9;
