/** GET /health（规范第 14 节） */
import type { FastifyInstance } from 'fastify';

export interface HealthDeps {
  version: string;
  providers: { asr: string; asyncTts: string; realtimeTts: string; coreBridge: string; storage: string };
  fillerEnabled: boolean;
  activeCalls: () => number;
  uptimeStart: number;
}

export function registerHealthRoute(app: FastifyInstance, deps: HealthDeps): void {
  app.get('/health', async () => ({
    status: 'ok',
    service: 'siren',
    version: deps.version,
    uptime_s: Math.round((Date.now() - deps.uptimeStart) / 1000),
    providers: deps.providers,
    filler_enabled: deps.fillerEnabled,
    active_calls: deps.activeCalls()
  }));
}
