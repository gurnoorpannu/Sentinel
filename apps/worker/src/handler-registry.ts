import type { JsonValue, Task } from '@sentinel/contracts';

export type TaskHandler = (task: Task) => Promise<JsonValue>;

export class UnknownTaskHandlerError extends Error {
  constructor(handler: string) {
    super(`No task handler is registered for "${handler}"`);
    this.name = 'UnknownTaskHandlerError';
  }
}

export class HandlerRegistry {
  private readonly handlers = new Map<string, TaskHandler>();

  register(name: string, handler: TaskHandler): this {
    if (this.handlers.has(name)) {
      throw new Error(`Task handler "${name}" is already registered`);
    }
    this.handlers.set(name, handler);
    return this;
  }

  async execute(task: Task): Promise<JsonValue> {
    const handlerName =
      task.executionMode === 'compensation' ? task.compensationHandler : task.handler;
    if (!handlerName) {
      throw new UnknownTaskHandlerError('missing-compensation-handler');
    }
    const handler = this.handlers.get(handlerName);
    if (!handler) {
      throw new UnknownTaskHandlerError(handlerName);
    }
    return await handler(task);
  }
}
