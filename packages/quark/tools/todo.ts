// Tool: todo — task management

import { z } from "zod"

const todos: Array<{ content: string; status: string; priority: string }> = []

export default {
  id: "todo",
  description: "Manage a task list. Use to track progress on complex tasks.",
  parameters: z.object({
    todos: z.array(z.object({
      content: z.string().describe("Task description"),
      status: z.enum(["pending", "in_progress", "completed", "cancelled"]),
      priority: z.enum(["high", "medium", "low"]),
    })).describe("The updated todo list"),
  }),
  async execute(args: { todos: Array<{ content: string; status: string; priority: string }> }) {
    todos.length = 0
    todos.push(...args.todos)

    const summary = todos.map((t, i) => {
      const icon = t.status === "completed" ? "✓" : t.status === "in_progress" ? "→" : t.status === "cancelled" ? "✗" : "○"
      return `${icon} [${t.priority}] ${t.content}`
    }).join("\n")

    return {
      title: "todo",
      output: summary || "(empty)",
      metadata: { count: todos.length },
    }
  },
}
