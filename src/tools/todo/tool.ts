import { DynamicStructuredTool } from '@langchain/core/tools';
import { z } from 'zod';
import { TodoItem, TodoStatus, TodoPriority } from './types.js';

const TodoItemSchema = z.object({
  id: z.string(),
  content: z.string(),
  status: z.nativeEnum(TodoStatus),
  priority: z.nativeEnum(TodoPriority),
  created_at: z.number().optional().nullable(),
});

export function createTodoWriteTool(update: (todos: TodoItem[]) => void) {
return new DynamicStructuredTool({
  name: 'todo_write',
  description: 'Update the entire TODO list with the latest items.',
  schema: z.object({
    todos: z.array(TodoItemSchema),
  }),
  func: async ({ todos }: { todos: TodoItem[] }) => {
    update(todos);
    const unfinishedTodos = todos.filter(
      (todo) => todo.status !== TodoStatus.completed && todo.status !== TodoStatus.cancelled
    );

    let message = `Successfully updated the TODO list with ${todos.length} items.`;
    if (unfinishedTodos.length > 0) {
      message += ` ${unfinishedTodos.length} todo${unfinishedTodos.length === 1 ? ' is' : 's are'} not completed.`;
    } else {
      message += ' All todos are completed.';
    }

    return message;
  },
});
}

export const todoWriteTool = createTodoWriteTool(() => {});
