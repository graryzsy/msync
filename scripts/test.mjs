import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// Enumerate explicitly so Windows cmd.exe and Unix shells run the same tests.
const files = readdirSync('tests').filter(file => file.endsWith('.test.ts')).sort().map(file => join('tests', file));
const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], { stdio: 'inherit' });
if (result.error) { console.error('无法启动测试进程。'); process.exitCode = 1; }
else process.exitCode = result.status ?? 1;
