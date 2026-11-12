import { randomUUID } from 'node:crypto';
import { errorMessage, MSyncError } from '../core/models.js';
import type { WebTask, WebTaskSummary } from '../shared/api.js';

/** Tasks belong to the service, so closing or refreshing a browser cannot cancel a sync. */
export class WebTasks {
  private tasks = new Map<string, WebTask>();
  private latest?: WebTask;
  start(label: string, work: () => unknown | Promise<unknown>): string {
    if (this.latest?.state === 'running') throw new MSyncError('已有任务正在进行，请等待完成');
    const task: WebTask = { id: randomUUID(), label, state: 'running', startedAt: new Date().toISOString() };
    this.latest = task; this.tasks.set(task.id, task);
    while (this.tasks.size > 4) this.tasks.delete(this.tasks.keys().next().value!);
    void Promise.resolve().then(work).then(value => { task.value = value; task.state = 'succeeded'; }, error => {
      task.error = errorMessage(error); task.state = 'failed';
    }).finally(() => { task.finishedAt = new Date().toISOString(); });
    return task.id;
  }
  get(id: string): WebTask | undefined { return this.tasks.get(id); }
  activity(): WebTaskSummary | null {
    if (!this.latest) return null;
    const { value: _value, ...summary } = this.latest; return summary;
  }
}
