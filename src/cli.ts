import { readFileSync } from 'node:fs';
import { StateStore } from './core/store.js';
import { createDemo } from './core/demo.js';
import { planSync } from './core/planner.js';
import { SyncCoordinator } from './core/coordinator.js';

async function main(): Promise<void> {
  const [command, path] = process.argv.slice(2);
  if (command === 'demo') {
    const demo = await createDemo();
    await demo.services.find(service => service.platform === 'appleMusic')!.simulate(false, 'track');
    const coordinator = new SyncCoordinator(demo.store), plan = await coordinator.preview(demo.services);
    console.log(JSON.stringify({ mode: 'offline-demo', remoteWrites: 0, operations: plan.operations }, null, 2));
    demo.store.close(); return;
  }
  if (command === 'inspect' && path) {
    const store = await StateStore.open(path); console.log(JSON.stringify(store.load(), null, 2)); store.close(); return;
  }
  if (command === 'plan' && path) {
    const input = JSON.parse(readFileSync(path, 'utf8')); console.log(JSON.stringify(planSync(input.state, input.snapshots), null, 2)); return;
  }
  console.log('MSync: demo | inspect <collections.sqlite> | plan <input.json>');
}
main().catch(() => { console.error('离线命令未完成，请检查输入文件和数据格式。'); process.exitCode = 1; });
