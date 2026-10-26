import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SignalEvent } from '../shared/research.ts';

export class SignalRegistry {
  private queue = Promise.resolve();
  constructor(private directory: string) {}
  async list(): Promise<SignalEvent[]> {
    await this.queue;
    return this.read();
  }
  private async read(): Promise<SignalEvent[]> {
    try { return JSON.parse(await readFile(path.join(this.directory, 'signals.json'), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  }
  async register(events: SignalEvent[]) {
    const work = this.queue.then(async () => {
      const map = new Map((await this.read()).map(s => [s.id, s]));
      for (const event of events) if (!map.has(event.id)) map.set(event.id, event);
      await mkdir(this.directory, { recursive: true });
      const target = path.join(this.directory, 'signals.json');
      await writeFile(`${target}.tmp`, JSON.stringify([...map.values()].slice(-2000), null, 2), { mode: 0o600 });
      await rename(`${target}.tmp`, target);
    });
    this.queue = work.catch(() => {});
    await work;
  }
}
