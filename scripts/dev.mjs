import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const tsc = join(dirname(require.resolve('typescript/package.json')), 'bin/tsc');
const build = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.main.json'], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);
const vite = spawn(process.execPath, [join(dirname(require.resolve('vite/package.json')), 'bin/vite.js')], { stdio: 'inherit' });
let electron;
const cleanup = () => { vite.kill(); electron?.kill(); };
process.once('SIGINT', cleanup); process.once('SIGTERM', cleanup);
try {
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch('http://127.0.0.1:5173')).ok) { ready = true; break; } } catch {}
    if (vite.exitCode !== null) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error('开发服务器未启动');
  electron = spawn(require('electron'), ['.', ...(process.argv.includes('--demo') ? ['--msync-demo'] : [])], { stdio: 'inherit', env: { ...process.env, MSYNC_DEV_URL: 'http://127.0.0.1:5173' } });
  electron.once('exit', code => { cleanup(); process.exitCode = code ?? 0; });
} catch (error) { cleanup(); console.error(error.message); process.exitCode = 1; }
