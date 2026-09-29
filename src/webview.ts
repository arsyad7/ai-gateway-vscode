import * as vscode from "vscode";

/** HTML shell for the chat panel; the styling and behaviour live in media/. */
export function getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const media = (file: string) =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", file));
  const csp = webview.cspSource;

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src ${csp}; img-src ${csp} data:; script-src 'nonce-${nonce}';">
<link rel="stylesheet" href="${media("chat.css")}">
</head>
<body>
  <header id="top">
    <div class="seg" id="mode" title="Chat only answers. Agent can read and edit files and run commands in this workspace, asking before each change.">
      <button data-v="chat">Chat</button>
      <button data-v="agent">Agent</button>
    </div>
    <div class="model" id="modelWrap">
      <select id="model" title="Model alias to request ('auto' lets the gateway pick)"><option value="auto">auto</option></select>
    </div>
    <div class="tools">
      <button class="icon" id="refresh" title="Reload the model list from the gateway">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>
      </button>
      <button class="icon" id="historyBtn" title="Chat history">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>
      </button>
      <button class="icon" id="newChat" title="New conversation">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
      </button>
    </div>
  </header>

  <section id="history">
    <input id="hsearch" class="hsearch" type="search" placeholder="Search conversations…">
    <div id="sessionList"></div>
  </section>

  <main id="messages">
    <div id="empty">
      <div class="logo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 18 12 5l5 13M9 13.5h6"/></svg></div>
      <h2>AIcad</h2>
      <p>Chat answers questions. Agent reads, edits and runs things in this workspace, asking before each change. Requests go through your own gateway and follow its routing and credit limits.</p>
      <div class="chips">
        <button class="chip" data-cmd="aicad.explainSelection">Explain selection</button>
        <button class="chip" data-cmd="aicad.refactorSelection">Refactor selection</button>
        <button class="chip" data-cmd="aicad.askSelection">Ask about selection…</button>
      </div>
      <div class="hint"><kbd>Enter</kbd> send &nbsp;·&nbsp; <kbd>Shift</kbd>+<kbd>Enter</kbd> newline &nbsp;·&nbsp; <kbd>Esc</kbd> stop &nbsp;·&nbsp; <kbd>Ctrl</kbd>+<kbd>V</kbd> paste a screenshot</div>
    </div>
  </main>
  <button id="jump" title="Jump to latest">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12l7 7 7-7"/></svg>
  </button>

  <footer id="composer">
    <div class="box" id="box">
      <div id="attach" class="attach" hidden></div>
      <textarea id="input" rows="1" placeholder="Ask anything…"></textarea>
      <div class="cbar">
        <button class="icon" id="attachBtn" title="Attach an image or text file (you can also paste a screenshot or drop files here)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.4 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
        </button>
        <span class="hint" id="hint"></span>
        <button id="send" title="Send"></button>
      </div>
    </div>
    <div id="statusbar">
      <span class="dot" id="connDot" title="Gateway status"></span>
      <button class="link" id="server" title="Switch gateway server">…</button>
      <span id="served" title="Model that served the last reply"></span>
      <button class="icon" id="keyBtn" title="Set API key">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="15" r="4"/><path d="M10.9 12.1 21 2M15 8l3 3M18 5l3 3"/></svg>
      </button>
      <button class="icon" id="settingsBtn" title="Extension settings">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>
      </button>
    </div>
  </footer>
<script nonce="${nonce}" src="${media("chat.js")}"></script>
</body>
</html>`;
}
