# Synapse

> **Agent-driven project management — where humans and AI agents collaborate as equals.**

Synapse (神经突触) is a project management platform built on the principle that AI agents are first-class team members, not auxiliary tools. It combines the best architectural patterns from Claude Code's agent system with a role-based collaboration model where humans and agents share the same workflow positions.

## Core Concepts

### 🧠 Role Slots — Human ↔ Agent Hot-Swap
Every role (PM, Developer, QA, Product, Designer, DevOps) is an abstract slot that can be occupied by either a human user or an AI agent. Switch seamlessly based on availability, expertise, or workload.

### 📊 Code-First State
Project status is derived from real Git activity — commits, PRs, branches — not manual updates. Code is truth.

### ⚡ Zero-Alignment Protocol
Role-based information delivery eliminates alignment meetings. Each role receives structured, relevant updates automatically.

### 🔄 Event-Driven Agent Loop
Inherits Claude Code's proven agent loop pattern: stream → decide → execute → observe, with generator-based event flow for real-time responsiveness.

## Architecture

```
┌──────────────────────────────────────────────────┐
│  Web UI (React + Vite)                           │
├──────────────────────────────────────────────────┤
│  API Layer (Hono)                                │
├──────────────────────────────────────────────────┤
│  Synapse Core                                    │
│  ┌──────────┐ ┌──────────┐ ┌──────────────┐     │
│  │  Agent   │ │   Role   │ │  Workflow    │     │
│  │  Loop    │ │  System  │ │  Engine      │     │
│  └──────────┘ └──────────┘ └──────────────┘     │
│  ┌──────────┐ ┌──────────┐ ┌──────────────┐     │
│  │  Context │ │  Memory  │ │  Permission  │     │
│  │  Manager │ │  Store   │ │  Controller  │     │
│  └──────────┘ └──────────┘ └──────────────┘     │
├──────────────────────────────────────────────────┤
│  Integrations                                    │
│  Git Provider │ MCP Protocol │ Event Bus         │
├──────────────────────────────────────────────────┤
│  SQLite + Drizzle ORM                            │
└──────────────────────────────────────────────────┘
```

## Quick Start

```bash
# Install dependencies
npm install

# Start the development server
npm run dev

# In another terminal, start the web UI
npm run web:dev
```

## Project Structure

```
synapse/
├── src/
│   ├── core/           # Agent loop, event bus, decision engine
│   ├── roles/          # Role slot system, human/agent switching
│   ├── tools/          # Tool registry and built-in tools
│   ├── memory/         # Persistent memory with user/project scopes
│   ├── context/        # Context window management and compression
│   ├── integrations/   # Git, MCP, webhook integrations
│   ├── models/         # Database models and schemas
│   └── server.ts       # API server entry point
├── web/                # React frontend
├── config/             # Configuration files
└── package.json
```

## Design Principles (inherited from Claude Code)

1. **Generator-based event flow** — Agent loops yield events for streaming responses
2. **Two-layer context compression** — Snip old tool results, then auto-compact when threshold reached
3. **Permission-gated execution** — Tools require permission based on role and mode
4. **File-based memory** — Markdown files with YAML frontmatter, auto-indexed
5. **Multi-agent coordination** — Specialized agents with scoped tools and system prompts

## License

MIT
