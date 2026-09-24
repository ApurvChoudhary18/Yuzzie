/**
 * Prometheus metrics at `/metrics` (SPEC.md §15).
 *
 * The registry is per-server rather than global so two instances in one test
 * process do not fight over the same counters.
 */
import { Counter, Gauge, Histogram, Registry } from '@prometheus-io/client'

/** Label names are part of each metric's type so a typo is a compile error. */
export type HttpLabels = 'method' | 'route' | 'status'

export interface Metrics {
  readonly registry: Registry
  readonly events: Counter<'type'>
  readonly conflicts: Counter<string>
  readonly httpDuration: Histogram<HttpLabels>
  readonly wsConnections: Gauge<string>
  readonly eventLag: Histogram<string>
  readonly wsResets: Counter<string>
}

export function createMetrics(): Metrics {
  const registry = new Registry()

  const events = new Counter<'type'>({
    name: 'yuzie_events_total',
    help: 'Events appended to the log',
    labelNames: ['type'],
    registers: [registry],
  })

  const conflicts = new Counter<string>({
    name: 'yuzie_conflicts_total',
    help: 'Optimistic concurrency conflicts rejected with 409',
    registers: [registry],
  })

  const httpDuration = new Histogram<HttpLabels>({
    name: 'yuzie_http_duration_seconds',
    help: 'HTTP request duration',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [registry],
  })

  const wsConnections = new Gauge<string>({
    name: 'yuzie_ws_connections',
    help: 'Open WebSocket connections',
    registers: [registry],
  })

  // From commit to the frame being handed to a subscriber's socket; §18 Session 4
  // budgets 250 ms for the whole trip.
  const eventLag = new Histogram<string>({
    name: 'yuzie_event_lag_seconds',
    help: 'Time from an event being committed to it being sent to a subscriber',
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
    registers: [registry],
  })

  const wsResets = new Counter<string>({
    name: 'yuzie_ws_resets_total',
    help: 'Slow connections whose backlog was dropped and replaced by a snapshot',
    registers: [registry],
  })

  return { registry, events, conflicts, httpDuration, wsConnections, eventLag, wsResets }
}
