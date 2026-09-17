/**
 * Siren 服务入口：单进程承载 REST / MCP / WebSocket / Health / Assets（规范第 3 节）。
 */
import { mkdir } from 'node:fs/promises';
import { assertProductionReadiness, loadConfig } from '@siren/voice-core';
import { buildApp } from './app.ts';
import { cleanupTmpDir, ensureTmpDir } from './tmp-files.ts';

async function bootstrap(): Promise<void> {
  try {
    process.loadEnvFile();
  } catch {
    // 无 .env 文件时忽略
  }

  const config = loadConfig();
  await mkdir(config.dataDir, { recursive: true });
  await ensureTmpDir(config.tmpDir);
  const cleaned = await cleanupTmpDir(config.tmpDir);
  if (cleaned.removed > 0) {
    // 交由 logger 输出（logger 在 buildApp 里创建，这里简单 console）
    console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', event: 'tmp_cleaned', removed: cleaned.removed }));
  }

  const readiness = assertProductionReadiness(config);
  // P1-4 fail closed：安全项（鉴权/签名/存储完整性）无条件阻断；
  // SIREN_ALLOW_MOCK_IN_PRODUCTION 只放宽 mock provider 一组
  if (readiness.security.length > 0) {
    throw new Error(`生产安全配置校验失败（SIREN_ALLOW_MOCK_IN_PRODUCTION 不能豁免这些项）：\n- ${readiness.security.join('\n- ')}`);
  }
  if (readiness.mock.length > 0 && !config.allowMockInProduction) {
    throw new Error(`生产配置校验失败：\n- ${readiness.mock.join('\n- ')}`);
  }

  const siren = await buildApp({ config });
  await siren.app.listen({ host: config.host, port: config.port });

  siren.logger.info('server_started', {
    host: config.host,
    port: config.port,
    env: config.env,
    providers: siren.providers.active,
    playground: `http://${config.host}:${config.port}/playground/`,
    mcp: `http://${config.host}:${config.port}/mcp`,
    warnings: siren.providers.warnings.length
  });
  for (const problem of [...readiness.security, ...readiness.mock]) {
    siren.logger.warn('config_warning', { message: problem });
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    siren.logger.info('server_stopped', { signal });
    await siren.dispose();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

bootstrap().catch((error) => {
  console.error(JSON.stringify({ ts: new Date().toISOString(), level: 'error', event: 'startup_failed', error_message: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
