# Chapter 1: Why Quark

I am a big fan of coding agents. Over the past two years I’ve pushed them as far as I can — through Codex, Claude Code, Opencode, and Amp. Each one taught me something. Each one also frustrated me in a way that eventually became impossible to ignore.

## 1.1 The Landscape I Was Stuck In

**Claude Code** and **Codex** are good tools, but they’re closed-source, tightly coupled to their respective providers, and store your conversation data on someone else’s infrastructure. I don’t get to see how they work under the hood, and I don’t get to experiment with the harness itself. The system prompt is baked into the binary — I understand the team put a lot of effort into tuning it, but one prompt cannot serve every workflow.

**Opencode** is open-source, which I respect. But the UI feels clunky, and the config files are JSON — highly error-prone. A quick change shouldn’t take five minutes of hunting down a missing closing bracket. When you’re tweaking agent behavior daily, config ergonomics matter. JSON is tedious; I wanted YAML.

**Amp** is the best coding agent harness I’ve ever used. You give it a task and the system autonomously explores, discovers, and solves the problem with minimal hand-holding. It’s the closest thing to how I believe an agent should operate. But Amp is expensive, closed-source, and locks you into their opinionated model selection. You can’t switch models mid-session. You can’t bring your own provider. And your conversations live on their infrastructure — data I want to own, because I intend to use it later for fine-tuning small models or running RL.

So here I was: the good tools are closed-source and provider-locked. The open-source tools aren’t fun to use, aren’t easily hackable, and don’t slot cleanly into a research pipeline. I needed something that did all of these things at once.

## 1.2 The Deadly Simple Goal

I made Quark to solve exactly this problem. The goal is simple:

1. **Model freedom** — switch between providers and models freely, between turns if I want to. No lock-in.
2. **Hackable** — plug it into my research pipeline at work with minimal changes to existing code. CLI-first, headless mode, SDK-embeddable.
3. **Data ownership** — my conversations, my data, on my disk. No one else’s infrastructure (Yes, the prompts still hit a provider’s server — but the conversation history lives on my disk, not locked inside someone else’s infrastructure.)

## 1.3 What Quark Is (And Isn’t)

Quark is an **agent harness**. The model is a pluggable component — the harness owns everything else: the agent loop, the tools, the memory, the guardrails. My belief is that you can push LLM performance far without retraining models, if you build the right harness around them.

Quark is not trying to be a thin wrapper over an API. It’s feature-rich: a packaged coding agent with a beautiful TUI, a CLI for quick one-offs, headless and SDK entry points, and web-facing surfaces that can grow toward remote control and a desktop environment. But more than features, it’s an **experiment platform** — a place where I can test ideas about agent architecture, context management, and human-agent collaboration.

## 1.4 The Philosophy This Book Will Unpack

Building Quark taught me that an agent is more than prompt engineering. The architecture decisions — how you structure the loop, how you isolate context, how you model state — compound into real differences in capability.

In the chapters ahead, I’ll walk through each of those decisions:

- How the **agent loop** works from first principles (Chapter 2)
- Why **profiles** matter — keeping agent context uncontaminated by irrelevant tools and skills (Chapter 3)
- How the **TUI** projects the agent event stream into a fast, debuggable interface (Chapter 4)
- How **agent skills** and **permissions** extend the agent without bloating the prompt (Chapter 5)
- How the **CLI** ties everything together into a distributable tool (Chapter 6)

This isn’t a tutorial. It’s a technical deep-dive into how a coding agent gets built from scratch — the problems I hit, the tradeoffs I made, and the code that emerged. If you’re curious about what’s actually inside these tools, or if you want to build one yourself, this is for you.

Welcome to Quark.
