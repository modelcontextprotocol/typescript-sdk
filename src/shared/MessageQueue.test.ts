import { MessageQueue } from "./MessageQueue.js";

describe("MessageQueue", () => {
  test("should enqueue and dequeue items in FIFO order", () => {
    const queue = new MessageQueue<number>();
    queue.enqueue(1);
    queue.enqueue(2);
    queue.enqueue(3);

    expect(queue.dequeue()).toBe(1);
    expect(queue.dequeue()).toBe(2);
    expect(queue.dequeue()).toBe(3);
    expect(queue.dequeue()).toBeUndefined();
  });

  test("should maintain correct length", () => {
    const queue = new MessageQueue<number>();
    expect(queue.length).toBe(0);

    queue.enqueue(1);
    expect(queue.length).toBe(1);

    queue.enqueue(2);
    expect(queue.length).toBe(2);

    queue.dequeue();
    expect(queue.length).toBe(1);

    queue.clear();
    expect(queue.length).toBe(0);
  });

  test("should peek at the front item without removing it", () => {
    const queue = new MessageQueue<number>();
    queue.enqueue(1);
    queue.enqueue(2);

    expect(queue.peek()).toBe(1);
    expect(queue.length).toBe(2);
  });

  test("should clear all items", () => {
    const queue = new MessageQueue<number>();
    queue.enqueue(1);
    queue.enqueue(2);
    queue.enqueue(3);

    queue.clear();
    expect(queue.length).toBe(0);
    expect(queue.dequeue()).toBeUndefined();
  });
}); 