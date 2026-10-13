/** 已停用：旧脚本的整场统计不能证明目标轮成功，禁止继续作为实机验收依据。 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function main(): number {
  process.stderr.write(
    'repro-session-abort 已停用；不会读取配置、音频或连接服务。\n' +
    '请使用离线回归 tests/voice-interrupt-client-flow.test.ts 和 tests/voice-interrupt-session.test.ts。\n'
  );
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
