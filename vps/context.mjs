export function localDurableContext(storage) {
  const pendingTasks = new Set();
  return {
    storage,
    pendingTasks,
    blockConcurrencyWhile: (fn) => fn(),
    waitUntil(promise) {
      const task = Promise.resolve(promise);
      pendingTasks.add(task);
      void task.finally(() => pendingTasks.delete(task)).catch(() => {});
    },
  };
}
