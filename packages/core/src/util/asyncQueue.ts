/**
 * Bounded single-consumer push/pull queue. Producer calls {@linkcode push};
 * consumer reads via {@linkcode iterate} (`for await`). When the queue fills,
 * the consumer is closed (slow-consumer eviction). {@linkcode close} ends
 * iteration after draining whatever is already queued.
 *
 * Single-consumer: at most one `iterate()` may be active. Starting a second
 * concurrent consumer is undefined behavior.
 */
export class AsyncQueue<T> {
    private readonly _queue: T[] = [];
    private _waiter?: (r: IteratorResult<T>) => void;
    private _closed = false;

    constructor(private readonly _capacity = Infinity) {}

    /**
     * Enqueues an item, or hands it directly to a waiting consumer.
     * Returns false (and closes the queue) if the capacity bound is hit.
     * Returns false if already closed.
     */
    push(item: T): boolean {
        if (this._closed) return false;
        if (this._waiter) {
            const w = this._waiter;
            this._waiter = undefined;
            w({ value: item, done: false });
            return true;
        }
        if (this._queue.length >= this._capacity) {
            this.close();
            return false;
        }
        this._queue.push(item);
        return true;
    }

    /**
     * Closes the queue. A waiting consumer is released with `done: true`.
     * Items already queued remain readable until drained.
     */
    close(): void {
        if (this._closed) return;
        this._closed = true;
        if (this._waiter) {
            const w = this._waiter;
            this._waiter = undefined;
            w({ value: undefined as never, done: true });
        }
    }

    /** True once {@linkcode close} has been called. */
    get closed(): boolean {
        return this._closed;
    }

    /**
     * Async iterable over pushed items. Yields until {@linkcode close} is called
     * and the queue is drained. Breaking out of the loop calls `close()`.
     */
    iterate(): AsyncIterableIterator<T> {
        const next = (): Promise<IteratorResult<T>> => {
            if (this._queue.length > 0) {
                return Promise.resolve({ value: this._queue.shift() as T, done: false });
            }
            if (this._closed) return Promise.resolve({ value: undefined as never, done: true });
            return new Promise(resolve => {
                this._waiter = resolve;
            });
        };
        const ret = (): Promise<IteratorResult<T>> => {
            this.close();
            return Promise.resolve({ value: undefined as never, done: true });
        };
        const it: AsyncIterableIterator<T> = { [Symbol.asyncIterator]: () => it, next, return: ret };
        return it;
    }
}
