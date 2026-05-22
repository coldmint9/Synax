# Synax

> AI-powered code intelligence platform with a multi-agent runtime, interactive code graph, and auto-generated design wiki.

![version](https://img.shields.io/badge/version-0.1.0-blue?style=flat-square)
![license](https://img.shields.io/badge/license-MIT-22c55e?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6?style=flat-square&logo=typescript&logoColor=white)
![React](https://img.shields.io/badge/React-19-61dafb?style=flat-square&logo=react&logoColor=black)
![Electron](https://img.shields.io/badge/Electron-42-47848f?style=flat-square&logo=electron&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-20+-339933?style=flat-square&logo=node.js&logoColor=white)

---

## ✨ Features

| | Feature | Description |
|---|---|---|
| 🤖 | **Multi-Agent Runtime** | Concurrent sub-agent tree with streaming tool calls, permission management, and pause/resume sessions |
| 🗺️ | **Code Graph** | tree-sitter powered multi-language parsing — visualize symbol relationships as an interactive React Flow graph |
| 📚 | **Design Wiki** | Auto-generated codebase documentation with snapshots, patches, and incremental refresh tasks |
| 🔌 | **Multi-Provider LLM** | Anthropic, OpenAI, Google, Groq, Mistral, xAI, Perplexity and more — swap models without changing code |
| 💾 | **Context Management** | Token counting, automatic compression, memory search, and a sync bus for real-time session state |
| 🖥️ | **Desktop App** | Cross-platform Electron app that bundles the API server — zero external dependencies to run |

---

## 🚀 Quick Start

### Prerequisites

- Node.js 20+
- API key for at least one LLM provider (Anthropic, OpenAI, etc.)

### Installation

```bash
# Clone the repository
git clone https://github.com/coldmint9/synapse.git && cd synapse

npm install

cp .env.example .env  # add your LLM provider API keys
```

### Development

```bash
npm run dev          # API + Web together
npm run dev:api      # API only  →  http://localhost:3210
npm run dev:web      # Web only  →  http://localhost:5173
npm run dev:desktop  # Electron desktop app
```

### Build & Test

```bash
npm run build        # API  → server-dist/
npm run web:build    # Web  → web/dist/
npm run test         # All API tests (Vitest)
```

---

## 🏗️ Architecture

Monorepo with three layers. API and Web run standalone; Electron bundles both for desktop distribution.

```
┌──────────────────────────────────────────────────────────────┐
│                           Synx                               │
│  ┌─────────────────┐   ┌──────────────────┐  ┌───────────┐  │
│  │    web/          │   │     api/          │  │ electron/ │  │
│  │  React 19        │   │  Hono + SQLite    │  │  Desktop  │  │
│  │  Zustand         │◄──│  Agent Runtime    │  │  Wrapper  │  │
│  │  React Flow      │   │  LLM Runtime      │  │           │  │
│  │  TailwindCSS     │   │  Wiki / Analyzer  │  │           │  │
│  └─────────────────┘   └────────┬─────────┘  └───────────┘  │
│              ┌──────────────────┼──────────────────┐         │
│              ▼                  ▼                  ▼         │
│         Anthropic            OpenAI             Google       │
│           Groq               Mistral              xAI        │
└──────────────────────────────────────────────────────────────┘
```

---

## 🔌 Supported LLM Providers

Anthropic · OpenAI · Google · Groq · Mistral · xAI · Perplexity · Together AI · Cohere · DeepInfra · OpenRouter

---

## 🛠️ Tech Stack

TypeScript · React 19 · Hono · SQLite + Drizzle ORM · Vercel AI SDK · tree-sitter · Electron · Vite · TailwindCSS · Zustand · React Flow · Vitest · Pino

---

## 🤝 Contributing

Contributions are welcome. Open an issue first to discuss what you'd like to change, then submit a PR.

```bash
git checkout -b feat/your-feature
npm run test
# open a PR against main
```

---

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.
