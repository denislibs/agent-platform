import type { Task, TaskRepository } from '@agent/core';
import { ApiError } from './errors';

/** Задача пользователя; чужая, несуществующая и с кривым id — одинаково 404 (ничего не говорит о существовании). */
export async function ownTask(tasks: TaskRepository, id: string, userId: string): Promise<Task> {
  const task = await tasks.get(id);
  if (!task || task.userId !== userId) throw new ApiError(404, 'not_found', 'task not found');
  return task;
}
