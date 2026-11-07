# GitHub Copilot Instructions

Read and follow [AGENTS.md](../AGENTS.md) before working in this repository. It is the source of truth for shared project rules, architecture, code style, and commands.

## Session History

- Separate local persistence, cloud history sync, and remote session control.
  Working GitHub MCP or `gh` authentication does not prove that session export
  is working; a local session listing does not prove cloud upload.
- Investigate using the relevant session/runtime logs and effective settings.
  Never enable sync, remote control, or sharing, export chats, or delete/migrate
  session stores as an automatic repair. Do not copy live session databases.
- Use the privacy-aware checklist in
  the "Copilot tools, models, and session sync" section of [CONTRIBUTING.md](../CONTRIBUTING.md).
