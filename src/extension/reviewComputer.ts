import { Worker } from 'node:worker_threads';
import { computeReview, ReviewInput } from '../core/reviewWorker';

type Result = ReturnType<typeof computeReview>;

// Large comparisons run away from the extension host's command/event loop.
export class ReviewComputer {
  private worker?: Worker;
  private sequence = 0;
  private readonly pending = new Map<number, { resolve(result: Result): void; reject(error: Error): void }>();
  constructor(private readonly path: string) {}
  async compute(input: ReviewInput): Promise<Result> {
    if (Math.max(input.doc.text.length, input.local.length) < 200_000 && input.doc.comments.length < 300) return computeReview(input);
    if (!this.worker) {
      const worker = this.worker = new Worker(this.path);
      worker.on('message', ({ id, result, error }) => {
        const pending = this.pending.get(id); this.pending.delete(id);
        if (error) pending?.reject(new Error(error)); else pending?.resolve(result);
      });
      worker.on('error', error => { this.fail(error); if (this.worker === worker) this.worker = undefined; });
      worker.on('exit', () => { if (this.worker === worker) { this.worker = undefined; this.fail(new Error('Comment worker stopped. Refresh to retry.')); } });
    }
    const id = ++this.sequence;
    return new Promise<Result>((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.worker!.postMessage({ id, input }); });
  }
  private fail(error: Error) { this.pending.forEach(pending => pending.reject(error)); this.pending.clear(); }
  dispose() { const worker = this.worker; this.worker = undefined; this.fail(new Error('Comment view closed.')); void worker?.terminate(); }
}
