import { rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
rmSync('dist', { recursive: true, force: true });
const result = spawnSync(process.execPath, [join(dirname(require.resolve('typescript/package.json')), 'bin/tsc'), '-p', 'tsconfig.main.json'], { stdio: 'inherit' });
process.exitCode = result.status ?? 1;
