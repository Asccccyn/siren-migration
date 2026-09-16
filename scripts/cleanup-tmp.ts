/**
 * 手动清理临时目录：node/tsx scripts/cleanup-tmp.ts
 * 服务启动时也会自动执行一次（规范第 33 节）。
 */
import { loadConfig } from '@siren/voice-core';
import { cleanupTmpDir } from '../apps/server/src/tmp-files.ts';

try {
  process.loadEnvFile();
} catch {
  // 无 .env
}
const config = loadConfig();
const result = await cleanupTmpDir(config.tmpDir);
console.log(JSON.stringify({ event: 'tmp_cleaned', removed: result.removed, dir: config.tmpDir }));
