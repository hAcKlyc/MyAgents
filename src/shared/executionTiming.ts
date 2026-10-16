/** Backend event observation times, not provider/API latency measurements.
 * Missing timing on legacy/recovered content is unknown and must stay absent.
 */
export type ExecutionTiming = {
  startedAt: number;
  finishedAt?: number;
  lastActivityAt?: number;
  source: 'observed' | 'runtime';
};
