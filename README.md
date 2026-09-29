# AIcad (VS Code)

AIcad is a chat panel and an approval-gated coding agent for VS Code, backed by
your self-hosted AI gateway: streaming replies rendered as Markdown, a model
picker (including `auto` routing), a server picker, and right-click code actions.

## Setup
1. Pick the gateway with **AIcad: Select Server…** (Command Palette, the status bar item, or the server button in the chat panel). It lists servers from the `aicad.servers` setting, recently used URLs, and localhost, or lets you paste a new URL such as a Cloudflare tunnel. The active URL is stored in `aicad.url` (default `http://localhost:3000/api/v1`).
2. Run command **AIcad: Set API Key** and paste a `gw_live_…` key.
3. Open the AIcad icon in the activity bar and chat.

Right-click selected code for **Explain / Refactor / Ask About Selection**.

## Modes
- **Chat** answers questions and shows code you can insert into the editor.
- **Agent** reads, edits and runs commands in the workspace, asking before each change.

Upgrading from the "AI Gateway" builds keeps your API key, chat history and
settings: the old `aiGateway.*` keys are copied to `aicad.*` on first start.
