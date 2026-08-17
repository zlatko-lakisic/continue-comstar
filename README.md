# continue-comstar

![continue-comstar](comstar-banner.png)

A fork of [Continue](https://github.com/continuedev/continue) wired to
[agentic-orchestration](https://github.com/zlatko-lakisic/agentic-orchestration)
via [AO Reach](https://github.com/zlatko-lakisic/agentic-orchestration-reach).
Instead of calling an LLM provider directly, every inference request goes to your
orchestration daemon, which handles model selection, agent routing, tool use,
session memory, and the learning loop.

## What this is

continue-comstar is the editor face of the COMSTAR project. The orchestration daemon is the brain; this extension is its editor I/O. It captures context from the editor, forwards that context through AO Reach, and streams the response back into VS Code. The extension does not know which model answered, and it does not need to.

## Why

Continue is the best open-source code assistant shell. AO Reach gives it a backend with persistent memory, dynamic planning, and MCP tools—capabilities that a direct inference provider cannot match.

## Prerequisites

| Component                     | Requirement                                                                    |
| ----------------------------- | ------------------------------------------------------------------------------ |
| `agentic-orchestration`       | Daemon version 1.27.0 or newer, started with `AGENTIC_SERVE_SESSION_OVERLAY=1` |
| `agentic-orchestration-reach` | Reachable from the machine running VS Code                                     |
| VS Code                       | Version 1.85 or newer                                                          |

No third-party account is required. The extension needs an AO Reach authentication token, but it needs no model-provider API key unless your server-side overlays call a hosted service.

## Installation

```bash
# clone and build
git clone https://github.com/zlatko-lakisic/continue-comstar
cd continue-comstar
npm install
npm run build         # builds the VS Code extension
```

Install the generated `.vsix` from `extensions/vscode/`, or open the repository in VS Code and press F5 to run the extension in development mode.

## Configuration

Create or replace your Continue `config.yaml` with profiles like these:

```yaml
name: continue-comstar
version: 0.0.1
schema: v1

models:
  - name: COMSTAR Code
    provider: ao_reach
    baseUrl: wss://ao.lan
    apiKey: $AO_REACH_TOKEN
    sessionOverlay: comstar-code
    timeoutSeconds: 15
    streamingEnabled: true

  - name: COMSTAR Review
    provider: ao_reach
    baseUrl: wss://ao.lan
    apiKey: $AO_REACH_TOKEN
    sessionOverlay: comstar-code-review
    sessionId: continue-comstar-review
    timeoutSeconds: 30
    streamingEnabled: true
```

| Field              | Meaning                                                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| `baseUrl`          | Required WebSocket URL of the AO Reach endpoint, such as `wss://ao.lan` or `ws://192.168.1.50:8080` |
| `apiKey`           | Required AO Reach authentication token; if omitted inline, the provider reads `AO_REACH_TOKEN`      |
| `sessionOverlay`   | Required name of the server-side session overlay                                                    |
| `sessionId`        | Optional stable session identifier; by default it is `continue-comstar-{workspaceName}`             |
| `timeoutSeconds`   | Optional hard response deadline in seconds; the default is 15                                       |
| `streamingEnabled` | Optional streaming switch; the default is `true`, while `false` buffers the full response           |

Each entry is a selectable profile. The general coding profile maps to `comstar-code`, while the review profile maps to `comstar-code-review`. Adding or changing profiles is how users customise continue-comstar: the picker switches server-side overlays, not models, and the extension itself does not need to change.

## Session overlays

Session overlays are YAML files on the server that define the agent roster and MCP set for one session. See the [agentic-orchestration documentation](https://github.com/zlatko-lakisic/agentic-orchestration/tree/main/docs) for the overlay layout and server configuration.

A `comstar-code` overlay can combine a code-completion agent, a documentation-lookup agent, and filesystem access. The code assistant can be defined like this:

```yaml
# overlays/comstar-code/agent_providers/code_assistant.yaml
name: code_assistant
role: >
  You are a code assistant integrated into VS Code through the continue-comstar
  extension. You receive editor context — open files, selected code, terminal
  output, diagnostics — and answer with precise, working code. Never use markdown
  headers or bullet lists in your response unless the user explicitly asks for them.
  Never explain what you are about to do; just do it. Keep responses under 200 words
  unless a longer answer is clearly required.
mcp_providers:
  - filesystem
  - memory
  - math
  - time
max_turns: 1
timeout_seconds: 15
```

The same overlay directory can contain a `documentation_lookup` agent with access to the project documentation source. Model choice, agent personality, tool access, verbosity, and response length all live in this overlay, not in the extension configuration.

## Session memory

An AO Reach session persists across IDE restarts because it is keyed by the configured or derived `sessionId`. The orchestration daemon's SQLite knowledge base accumulates knowledge about the codebase over time. Users can clear a session on the server; the extension itself holds no persistent session state.

## Privacy

The extension sends no code to a cloud service. All routing goes only to the URL configured in `baseUrl`. If that URL is on your LAN, nothing leaves your network unless a server-side overlay calls an external API, which is entirely under your control.

## Part of the COMSTAR project

COMSTAR is a family of interfaces to the same `agentic-orchestration` backend: a voice-assistant terminal and now an editor extension. See the [COMSTAR project](https://github.com/zlatko-lakisic/comstar) for the wider set of interfaces.

## Licence

Apache-2.0, the same licence as upstream Continue and agentic-orchestration.
