import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { create } from 'tar';

const root = dirname(dirname(fileURLToPath(import.meta.url))), { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const filename = `msync-${version}-node.tar.gz`;
mkdirSync(join(root, 'release'), { recursive: true });
await create({ cwd: root, file: join(root, 'release', filename), gzip: true, portable: true, prefix: 'msync' },
  ['dist', 'resources/music-bridge.js', 'package.json', 'package-lock.json', 'README.md']);
console.log(`已生成 release/${filename}；目标电脑安装 Node.js 后执行 npm ci --omit=dev 和 npm start。`);
