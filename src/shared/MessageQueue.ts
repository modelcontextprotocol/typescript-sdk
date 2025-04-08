/**
 * Simple Queue implementation for efficient FIFO operations
 */
export class MessageQueue<T> {
  private _head: number = 0;
  private _tail: number = 0;
  private _items: { [key: number]: T } = {};

  /**
   * Adds an item to the end of the queue
   */
  enqueue(item: T): void {
    this._items[this._tail] = item;
    this._tail++;
  }

  /**
   * Removes and returns the first item from the queue
   */
  dequeue(): T | undefined {
    if (this._head === this._tail) {
      return undefined;
    }
    const item = this._items[this._head];
    delete this._items[this._head];
    this._head++;
    return item;
  }

  /**
   * Returns the first item without removing it
   */
  peek(): T | undefined {
    return this._items[this._head];
  }

  /**
   * Returns the number of items in the queue
   */
  get length(): number {
    return this._tail - this._head;
  }

  /**
   * Removes all items from the queue
   */
  clear(): void {
    this._head = 0;
    this._tail = 0;
    this._items = {};
  }
} 