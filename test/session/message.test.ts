import { describe, test, expect } from "bun:test";
import { toModelMessages, formatConversation } from "../../src/session/message";
import type { MessageRow, PartRow } from "../../src/session/message";

describe("toModelMessages aborted message filtering", () => {
  test("filters out aborted assistant messages and their parts", () => {
    const messages: MessageRow[] = [
      {
        id: "m1",
        sessionId: "s1",
        providerId: "copilot",
        modelId: "gpt-5",
        role: "user",
        finish: null,
        cost: null,
        tokensIn: null,
        tokensOut: null,
        timeCreated: 1,
        timeCompleted: 1,
      },
      {
        // Aborted assistant message — should be filtered out
        id: "m2",
        sessionId: "s1",
        providerId: "copilot",
        modelId: "gpt-5",
        role: "assistant",
        finish: "aborted",
        cost: null,
        tokensIn: null,
        tokensOut: null,
        timeCreated: 2,
        timeCompleted: 2,
      },
      {
        id: "m3",
        sessionId: "s1",
        providerId: "copilot",
        modelId: "gpt-5",
        role: "user",
        finish: null,
        cost: null,
        tokensIn: null,
        tokensOut: null,
        timeCreated: 3,
        timeCompleted: 3,
      },
      {
        id: "m4",
        sessionId: "s1",
        providerId: "copilot",
        modelId: "gpt-5",
        role: "assistant",
        finish: "stop",
        cost: null,
        tokensIn: null,
        tokensOut: null,
        timeCreated: 4,
        timeCompleted: 4,
      },
    ];
    const parts: PartRow[] = [
      {
        id: "p1",
        messageId: "m1",
        sessionId: "s1",
        type: "text",
        data: JSON.stringify({ text: "Hello" }),
      },
      // Aborted message parts — should be filtered
      {
        id: "p2",
        messageId: "m2",
        sessionId: "s1",
        type: "text",
        data: JSON.stringify({ text: "partial aborted text" }),
      },
      {
        id: "p3",
        messageId: "m2",
        sessionId: "s1",
        type: "tool",
        data: JSON.stringify({
          tool: "read",
          callId: "call-aborted",
          status: "pending",
          input: { filePath: "/tmp/test" },
        }),
      },
      // Normal parts
      {
        id: "p4",
        messageId: "m3",
        sessionId: "s1",
        type: "text",
        data: JSON.stringify({ text: "Continue please" }),
      },
      {
        id: "p5",
        messageId: "m4",
        sessionId: "s1",
        type: "text",
        data: JSON.stringify({ text: "Normal response" }),
      },
    ];

    const result = toModelMessages(messages, parts);

    // Should produce 3 messages: m1 (user), m3 (user), m4 (assistant)
    // m2 (aborted) and its parts must be absent
    expect(result.length).toBe(3);
    expect(result[0]!.role).toBe("user");
    expect(result[1]!.role).toBe("user");
    expect(result[2]!.role).toBe("assistant");

    // Normal user content preserved
    expect((result[0]! as any).content).toBe("Hello");
    expect((result[1]! as any).content).toBe("Continue please");

    // Normal assistant content preserved
    const assistantContent = result[2]!.content as Array<Record<string, unknown>>;
    expect(assistantContent.length).toBe(1);
    expect(assistantContent[0]!.type).toBe("text");
    expect(assistantContent[0]!.text).toBe("Normal response");

    // Verify aborted text does not appear anywhere
    const allSerialized = JSON.stringify(result);
    expect(allSerialized).not.toContain("partial aborted text");
    expect(allSerialized).not.toContain("call-aborted");
  });

  test("normal messages still work as before when no aborted messages", () => {
    // Sanity check: the aborted filtering doesn't break normal message flow
    const messages: MessageRow[] = [
      {
        id: "u1",
        sessionId: "s1",
        providerId: null,
        modelId: null,
        role: "user",
        finish: null,
        cost: null,
        tokensIn: null,
        tokensOut: null,
        timeCreated: 1,
        timeCompleted: 1,
      },
      {
        id: "a1",
        sessionId: "s1",
        providerId: "copilot",
        modelId: "gpt-5",
        role: "assistant",
        finish: "stop",
        cost: null,
        tokensIn: null,
        tokensOut: null,
        timeCreated: 2,
        timeCompleted: 2,
      },
    ];
    const parts: PartRow[] = [
      { id: "pu1", messageId: "u1", sessionId: "s1", type: "text", data: JSON.stringify({ text: "hi" }) },
      { id: "pa1", messageId: "a1", sessionId: "s1", type: "text", data: JSON.stringify({ text: "hey" }) },
    ];

    const result = toModelMessages(messages, parts);
    expect(result.length).toBe(2);
    expect(result[0]!.role).toBe("user");
    expect(result[1]!.role).toBe("assistant");
  });
});

describe("toModelMessages reasoning replay", () => {
  test("preserves reasoning content in assistant messages", () => {
    const messages: MessageRow[] = [
      {
        id: "m1",
        sessionId: "s1",
        providerId: "copilot",
        modelId: "gpt-5",
        role: "assistant",
        status: "completed",
        createdAt: "",
        timeCompleted: null,
        tokensIn: null,
        tokensOut: null,
      },
    ];
    const parts: PartRow[] = [
      {
        id: "p1",
        messageId: "m1",
        sessionId: "s1",
        type: "reasoning",
        data: JSON.stringify({ text: "Let me think about this..." }),
      },
      {
        id: "p2",
        messageId: "m1",
        sessionId: "s1",
        type: "text",
        data: JSON.stringify({ text: "Here is the answer." }),
      },
    ];

    const result = toModelMessages(messages, parts);
    expect(result.length).toBe(1);
    expect(result[0]!.role).toBe("assistant");

    const content = result[0]!.content as Array<Record<string, unknown>>;
    expect(Array.isArray(content)).toBe(true);
    expect(content.length).toBe(2);

    // Check reasoning part
    const reasoningPart = content.find((p) => p.type === "reasoning");
    expect(reasoningPart).toBeDefined();
    expect(reasoningPart!.text).toBe("Let me think about this...");

    // Check text part
    const textPart = content.find((p) => p.type === "text");
    expect(textPart).toBeDefined();
    expect(textPart!.text).toBe("Here is the answer.");
  });

  test("handles assistant messages with only reasoning (no text)", () => {
    const messages: MessageRow[] = [
      {
        id: "m2",
        sessionId: "s1",
        providerId: "copilot",
        modelId: "gpt-5",
        role: "assistant",
        status: "completed",
        createdAt: "",
        timeCompleted: null,
        tokensIn: null,
        tokensOut: null,
      },
    ];
    const parts: PartRow[] = [
      {
        id: "p3",
        messageId: "m2",
        sessionId: "s1",
        type: "reasoning",
        data: JSON.stringify({ text: "Pure reasoning with no visible text." }),
      },
    ];

    const result = toModelMessages(messages, parts);
    expect(result.length).toBe(1);
    expect(result[0]!.role).toBe("assistant");

    const content = result[0]!.content as Array<Record<string, unknown>>;
    expect(Array.isArray(content)).toBe(true);
    expect(content.length).toBe(1);
    expect(content[0]!.type).toBe("reasoning");
    expect(content[0]!.text).toBe("Pure reasoning with no visible text.");
  });

  test("handles empty reasoning part text", () => {
    const messages: MessageRow[] = [
      {
        id: "m3",
        sessionId: "s1",
        providerId: "copilot",
        modelId: "gpt-5",
        role: "assistant",
        status: "completed",
        createdAt: "",
        timeCompleted: null,
        tokensIn: null,
        tokensOut: null,
      },
    ];
    const parts: PartRow[] = [
      {
        id: "p4",
        messageId: "m3",
        sessionId: "s1",
        type: "reasoning",
        data: JSON.stringify({ text: "" }),
      },
    ];

    const result = toModelMessages(messages, parts);

    // Empty reasoning text filters out the part, produces no assistant content,
    // so no assistant message is emitted at all
    const assistantMessages = result.filter((m) => m.role === "assistant");
    expect(assistantMessages.length).toBe(0);
  });

  test("reasoning preserved alongside tool calls", () => {
    const messages: MessageRow[] = [
      {
        id: "m4",
        sessionId: "s1",
        providerId: "copilot",
        modelId: "gpt-5",
        role: "assistant",
        status: "completed",
        createdAt: "",
        timeCompleted: null,
        tokensIn: null,
        tokensOut: null,
      },
    ];
    const parts: PartRow[] = [
      {
        id: "p5",
        messageId: "m4",
        sessionId: "s1",
        type: "reasoning",
        data: JSON.stringify({ text: "I need to read the file first." }),
      },
      {
        id: "p6",
        messageId: "m4",
        sessionId: "s1",
        type: "tool",
        data: JSON.stringify({
          tool: "read",
          callId: "call-1",
          status: "completed",
          input: { filePath: "/tmp/test" },
          output: "file contents",
        }),
      },
    ];

    const result = toModelMessages(messages, parts);

    // Should produce: 1 assistant message + 1 tool result message
    expect(result.length).toBe(2);
    expect(result[0]!.role).toBe("assistant");
    expect(result[1]!.role).toBe("tool");

    const assistantContent = result[0]!.content as Array<
      Record<string, unknown>
    >;
    expect(Array.isArray(assistantContent)).toBe(true);

    // Should have reasoning AND tool-call parts
    const reasoningPart = assistantContent.find((p) => p.type === "reasoning");
    const toolCallPart = assistantContent.find((p) => p.type === "tool-call");

    expect(reasoningPart).toBeDefined();
    expect(reasoningPart!.text).toBe("I need to read the file first.");
    expect(toolCallPart).toBeDefined();
    expect(toolCallPart!.toolName).toBe("read");
  });
});

describe("formatConversation", () => {
  test("renders user and assistant text messages", () => {
    const messages: MessageRow[] = [
      {
        id: "m1",
        sessionId: "s1",
        role: "user",
        providerId: null,
        modelId: null,
        finish: null,
        cost: null,
        tokensIn: null,
        tokensOut: null,
        timeCreated: 1,
        timeCompleted: 1,
      },
      {
        id: "m2",
        sessionId: "s1",
        role: "assistant",
        providerId: "copilot",
        modelId: "gpt-5",
        finish: "stop",
        cost: null,
        tokensIn: null,
        tokensOut: null,
        timeCreated: 2,
        timeCompleted: 2,
      },
    ];
    const parts: PartRow[] = [
      { id: "p1", messageId: "m1", sessionId: "s1", type: "text", data: JSON.stringify({ text: "Hello" }) },
      { id: "p2", messageId: "m2", sessionId: "s1", type: "text", data: JSON.stringify({ text: "Hi there" }) },
    ];

    expect(formatConversation(messages, parts)).toBe("User: Hello\n\nAssistant: Hi there");
  });

  test("includes tool-call names when includeToolCalls is true", () => {
    const messages: MessageRow[] = [
      {
        id: "m1",
        sessionId: "s1",
        role: "assistant",
        providerId: "copilot",
        modelId: "gpt-5",
        finish: "tool-calls",
        cost: null,
        tokensIn: null,
        tokensOut: null,
        timeCreated: 1,
        timeCompleted: 1,
      },
    ];
    const parts: PartRow[] = [
      { id: "p1", messageId: "m1", sessionId: "s1", type: "text", data: JSON.stringify({ text: "I will read the file." }) },
      {
        id: "p2",
        messageId: "m1",
        sessionId: "s1",
        type: "tool",
        data: JSON.stringify({
          tool: "read",
          callId: "call-1",
          status: "completed",
          input: { path: "src/app.ts" },
          output: "secret output",
        }),
      },
    ];

    const result = formatConversation(messages, parts, { includeToolCalls: true });
    expect(result).toContain("Assistant: I will read the file.");
    expect(result).toContain("→ read");
    expect(result).not.toContain("secret output");
  });

  test("excludes reasoning and step markers by default", () => {
    const messages: MessageRow[] = [
      {
        id: "m1",
        sessionId: "s1",
        role: "assistant",
        providerId: "copilot",
        modelId: "gpt-5",
        finish: "stop",
        cost: null,
        tokensIn: null,
        tokensOut: null,
        timeCreated: 1,
        timeCompleted: 1,
      },
    ];
    const parts: PartRow[] = [
      { id: "p1", messageId: "m1", sessionId: "s1", type: "reasoning", data: JSON.stringify({ text: "thinking" }) },
      { id: "p2", messageId: "m1", sessionId: "s1", type: "text", data: JSON.stringify({ text: "Done" }) },
      { id: "p3", messageId: "m1", sessionId: "s1", type: "step-finish", data: JSON.stringify({ reason: "stop" }) },
    ];

    const result = formatConversation(messages, parts);
    expect(result).toBe("Assistant: Done");
  });

  test("skips aborted messages", () => {
    const messages: MessageRow[] = [
      {
        id: "m1",
        sessionId: "s1",
        role: "assistant",
        providerId: "copilot",
        modelId: "gpt-5",
        finish: "aborted",
        cost: null,
        tokensIn: null,
        tokensOut: null,
        timeCreated: 1,
        timeCompleted: 1,
      },
      {
        id: "m2",
        sessionId: "s1",
        role: "user",
        providerId: null,
        modelId: null,
        finish: null,
        cost: null,
        tokensIn: null,
        tokensOut: null,
        timeCreated: 2,
        timeCompleted: 2,
      },
    ];
    const parts: PartRow[] = [
      { id: "p1", messageId: "m1", sessionId: "s1", type: "text", data: JSON.stringify({ text: "aborted text" }) },
      { id: "p2", messageId: "m2", sessionId: "s1", type: "text", data: JSON.stringify({ text: "Retry" }) },
    ];

    expect(formatConversation(messages, parts)).toBe("User: Retry");
  });

  test("uses custom prefixes and separator for markdown export", () => {
    const messages: MessageRow[] = [
      {
        id: "m1",
        sessionId: "s1",
        role: "user",
        providerId: null,
        modelId: null,
        finish: null,
        cost: null,
        tokensIn: null,
        tokensOut: null,
        timeCreated: 1,
        timeCompleted: 1,
      },
      {
        id: "m2",
        sessionId: "s1",
        role: "assistant",
        providerId: "copilot",
        modelId: "gpt-5",
        finish: "stop",
        cost: null,
        tokensIn: null,
        tokensOut: null,
        timeCreated: 2,
        timeCompleted: 2,
      },
    ];
    const parts: PartRow[] = [
      { id: "p1", messageId: "m1", sessionId: "s1", type: "text", data: JSON.stringify({ text: "Hello" }) },
      { id: "p2", messageId: "m2", sessionId: "s1", type: "text", data: JSON.stringify({ text: "Hi" }) },
    ];

    const result = formatConversation(messages, parts, {
      userPrefix: "## User",
      assistantPrefix: "## Assistant",
      separator: "\n\n",
      prefixSeparator: "\n\n",
    });
    expect(result).toBe("## User\n\nHello\n\n## Assistant\n\nHi");
  });
});
