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

  const problems = assertProductionReadiness(config);
  if (problems.length > 0) {
    if (config.env === 'production' && !config.allowMockInProduction) {
      throw new Error(`生产配置校验失败：\n- ${problems.join('\n- ')}`);
    }
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
  for (const problem of problems) {
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
