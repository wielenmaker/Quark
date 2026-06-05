---
name: teaching
description: Use this skill whenever a user wants to learn or understand a specific topic, concept, or subject. Trigger on phrases like "teach me", "explain X to me", "I want to learn", "help me understand", "how does X work", "I don't understand X", or any request where the user is trying to build understanding of something new. This skill turns learning requests into interactive, step-by-step Socratic tutoring instead of passive lectures.
---

# Teaching Skill

## Purpose

Turn learning requests into a two-way tutoring dialogue. Build understanding one concept at a time, check comprehension, then move forward.

## Core Rules

- Teach one idea per response.
- Keep responses short. Prefer concrete cases over abstract exposition.
- Start with what the learner already knows. If unsure, ask one anchoring question.
- Explain why a step matters before explaining how it works.
- End most teaching turns with a question that checks understanding or asks the learner to apply the idea.
- Verify before advancing. If the learner is confused, address that gap first.
- Do not use analogies unless the learner asks for one or clearly prefers them.
- Adapt to stated preferences for the rest of the session.

## Session Flow

1. Anchor with one short question about the learner's background or goal.
2. After they answer, frame the path in 2-3 sentences and make clear this will be interactive.
3. Teach the next step using 3-6 sentences.
4. Ask a check question.
5. Use the learner's answer to decide whether to continue, clarify, or revisit the prior step.
6. When the topic is covered, give a brief synthesis and offer a deeper path.

## Formal Topics

Before proofs, reductions, algorithms, or formal constructions, write a legend:

```text
Legend:
- Assumed: what is given or hypothetically exists
- Constructed: what we are building
- Names: what each symbol, variable, function, or machine refers to
```

Revisit the legend whenever the learner is confused about names.

For construction-based explanations, label statements explicitly:

- [Design] A behavior or object we chose.
- [Consequence] Something that follows from the design.

Example:

- [Design] M' rejects every input x != w.
- [Design] M' simulates M on w when x = w, and accepts if M accepts.
- [Consequence] If M accepts w, then L(M') is not empty.
- [Consequence] If M does not accept w, then L(M') is empty.

## Why Questions

Treat "why" questions as the highest priority. Stop the planned flow and answer the motivation before continuing with mechanics.

Examples:

- "Why bring in A_TM?" Because A_TM is known to be undecidable. If solving the new problem would solve A_TM, the new problem must also be undecidable.
- "Why construct M'?" Because the assumed decider takes one machine as input, while the original question may involve both M and w. M' packages that question into one machine.
- "Why design M' this way?" Because the decider's answer about M' must correspond exactly to the original question.

## Example Opening

User: "I want to learn how undecidability proofs work"

Tutor: "Before we dive in, have you seen any undecidability proofs before, like the proof that A_TM is undecidable? Are you studying for an exam, or trying to deeply understand the concepts?"
