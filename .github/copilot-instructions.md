# GitHub Copilot Instructions

Read and follow [AGENTS.md](../AGENTS.md) before working in this repository. It is the source of truth for shared project rules, architecture, code style, and commands.

## Tool Discovery and MCP

- Use tools actually exposed by the current host, not names copied from a
  previous session, another client, or an example. Tool prefixes and schemas
  can differ between VS Code, Copilot CLI, and subagents.
- When a needed tool is deferred, discover it with the host's tool-search
  facility before calling it. Read the returned schema and use its exact name
  and arguments. Reuse loaded tools without searching again.
- If no discovery facility exists, use the exposed tool inventory; do not
  invent a discovery tool. A deferred tool is not a disconnected MCP server.
- Prefer built-in workspace tools for local files and native `git` for local
  repository operations. Follow the shared GitHub routing rules, subject to
  the current host's tool policy. Do not probe multiple equivalent MCP servers
  when one working provider can complete the operation.
- Request only needed fields and small pages. For targeted GitHub queries use
  search tools; use list tools for simple enumeration. Inspect saved oversized
  output with bounded searches and ranges, not another full dump.
- On failure, distinguish unknown tool/schema errors from authentication,
  permissions, server connectivity, and rate limits. Correct the specific
  cause; do not repeat an unchanged failed call. If MCP is unavailable, use
  an authorized CLI fallback and report the limitation.
- Before retrying a failed write through another tool, check whether it already
  succeeded. Never bypass approvals, repository permissions, or organization
  policy to make a tool work.

## Models and Delegation

- Follow the efficient-agent rules in [AGENTS.md](../AGENTS.md). Use the host's
  existing lightweight exploration or execution role when independent work
  warrants delegation; a role name alone does not guarantee a cheaper model.
- Leave delegation model, effort, and context overrides unset unless the user
  explicitly requests them. Inspect actual model usage when diagnosing cost;
  Auto routing and model availability are host/account settings, not something
  an instruction file can guarantee.

## Session History

- Separate local persistence, cloud history sync, and remote session control.
  Working GitHub MCP or `gh` authentication does not prove that session export
  is working; a local session listing does not prove cloud upload.
- Investigate using the relevant session/runtime logs and effective settings.
  Never enable sync, remote control, or sharing, export chats, or delete/migrate
  session stores as an automatic repair. Do not copy live session databases.
- Use the privacy-aware checklist in
  [Contributing](../CONTRIBUTING.md#copilot-tools-models-and-session-sync).

## VS Code Testing

- Run the smallest relevant selection of Rust and UI/internationalization tests
  via the VS Code Test Explorer when available.
- If it is unavailable or discovery fails, use the matching focused script in
  [AGENTS.md](../AGENTS.md), not the full suite by default. Outside VS Code, use
  those scripts directly. Report the exact checks and results.
