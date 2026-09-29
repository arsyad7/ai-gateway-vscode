import * as vscode from "vscode";
import { getHtml } from "./webview";
import {
  AgentRunner,
  FORMAT_RULES,
  PROPOSED_SCHEME,
  ProposedContent,
  SessionPermissions,
  messageText,
  type ApprovalAnswer,
  type ChatMessage,
} from "./agent";

const IMAGE_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_BYTES = 200 * 1024;

/** A file the user attached, ready for the webview. */
type AttachedFile =
  | { kind: "image"; name: string; mime: string; dataUrl: string }
  | { kind: "text"; name: string; text: string };

/** Saved chats keep the text but not image bytes (globalState is small). */
function stripImages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    if (typeof m.content === "string") return m;
    const text = messageText(m);
    const images = m.content.filter((p) => p.type === "image_url").length;
    return {
      role: m.role,
      content: images ? `${text}\n[${images} image${images === 1 ? "" : "s"} not saved]` : text,
    };
  });
}

/** A saved conversation, persisted in globalState. */
type Session = {
  id: string;
  title: string;
  updatedAt: number;
  messages: ChatMessage[];
};

const SECRET_KEY = "aicad.apiKey";
const SESSIONS_KEY = "aicad.sessions";
const RECENT_URLS_KEY = "aicad.recentUrls";
const MAX_SESSIONS = 50;
const QUICK_ACTIONS = new Set([
  "aicad.explainSelection",
  "aicad.refactorSelection",
  "aicad.askSelection",
]);
const MAX_RECENT_URLS = 8;
const DEFAULT_URL = "http://localhost:3000/api/v1";

/** A named gateway from the aicad.servers setting. */
type ServerEntry = { name?: string; url: string };

/** Chat mode has no tools; without this, models role-play tool calls. */
const CHAT_SYSTEM =
  "You are AIcad, a coding assistant in a VS Code chat panel, in chat-only mode: you have no tools and cannot read, create or edit files or run commands. Never write tool or function calls. When the user wants a change made, show the code in fenced code blocks (they can insert it into the editor) and mention that switching the panel from Chat to Agent mode lets you make the edit yourself. Answer in the user's language.\n\n" +
  FORMAT_RULES;

function gatewayUrl(): string {
  return vscode.workspace
    .getConfiguration("aicad")
    .get<string>("url", DEFAULT_URL)
    .replace(/\/$/, "");
}

/**
 * Cleans up a user-entered gateway address. A bare origin such as
 * "https://foo.trycloudflare.com" gets the /api/v1 path appended so people
 * can paste a tunnel URL as-is. Returns null when it is not a valid URL.
 */
function normalizeUrl(raw: string): string | null {
  let u = raw.trim().replace(/\/+$/, "");
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = "http://" + u;
  let parsed: URL;
  try {
    parsed = new URL(u);
  } catch {
    return null;
  }
  if (parsed.pathname === "/" || parsed.pathname === "") u += "/api/v1";
  return u;
}

function hostLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function setGatewayUrl(context: vscode.ExtensionContext, url: string): Promise<void> {
  await vscode.workspace
    .getConfiguration("aicad")
    .update("url", url, vscode.ConfigurationTarget.Global);
  const recent = context.globalState.get<string[]>(RECENT_URLS_KEY, []);
  await context.globalState.update(
    RECENT_URLS_KEY,
    [url, ...recent.filter((u) => u !== url)].slice(0, MAX_RECENT_URLS),
  );
}

/**
 * Quick pick of gateway servers: the aicad.servers setting, recently
 * used URLs, localhost, or a freshly typed URL. Returns true when a server
 * was chosen and saved as the active aicad.url.
 */
async function selectServer(context: vscode.ExtensionContext): Promise<boolean> {
  const current = gatewayUrl();
  type Item = vscode.QuickPickItem & { url?: string; custom?: boolean };
  const items: Item[] = [];
  const seen = new Set<string>();
  const add = (url: string, label: string) => {
    if (seen.has(url)) return;
    seen.add(url);
    items.push({
      label,
      description: url === current ? "current" : undefined,
      detail: url,
      url,
    });
  };

  const servers = vscode.workspace.getConfiguration("aicad").get<ServerEntry[]>("servers", []);
  for (const s of servers) {
    const url = normalizeUrl(s.url ?? "");
    if (url) add(url, `$(server) ${s.name || hostLabel(url)}`);
  }
  for (const u of context.globalState.get<string[]>(RECENT_URLS_KEY, [])) {
    add(u, `$(history) ${hostLabel(u)}`);
  }
  add(DEFAULT_URL, "$(home) localhost");
  items.push({ label: "$(add) Enter a new URL…", custom: true, alwaysShow: true });

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: `Gateway server (current: ${current})`,
    matchOnDetail: true,
    ignoreFocusOut: true,
  });
  if (!pick) return false;

  let url = pick.url;
  if (pick.custom) {
    const raw = await vscode.window.showInputBox({
      prompt: "Gateway URL, e.g. https://my-tunnel.trycloudflare.com (the /api/v1 path is added when missing)",
      value: current,
      ignoreFocusOut: true,
      validateInput: (v) => (normalizeUrl(v) ? null : "Enter a valid http(s) URL"),
    });
    if (!raw) return false;
    url = normalizeUrl(raw) ?? undefined;
  }
  if (!url) return false;

  await setGatewayUrl(context, url);
  vscode.window.showInformationMessage(`AIcad: using ${url}`);
  return true;
}

/** How hard the model reasons before each agent step; "" = model default. */
function agentEffort(): string {
  const v = vscode.workspace.getConfiguration("aicad").get<string>("agentEffort", "low");
  return v === "default" ? "" : v;
}

function defaultModel(): string {
  return vscode.workspace.getConfiguration("aicad").get<string>("model", "auto");
}

/** Copies settings, the API key and saved chats from the old "aiGateway.*" keys. */
async function migrateLegacyKeys(context: vscode.ExtensionContext): Promise<void> {
  const MIGRATED = "aicad.migrated";
  if (context.globalState.get<boolean>(MIGRATED)) return;
  const legacy = "ai" + "Gateway"; // split so the rename below leaves it alone
  const oldCfg = vscode.workspace.getConfiguration(legacy);
  const newCfg = vscode.workspace.getConfiguration("aicad");
  for (const key of ["url", "servers", "model", "agentEffort"]) {
    const oldValue = oldCfg.inspect(key)?.globalValue;
    if (oldValue !== undefined && newCfg.inspect(key)?.globalValue === undefined) {
      await newCfg.update(key, oldValue, vscode.ConfigurationTarget.Global);
    }
  }
  const oldKey = await context.secrets.get(legacy + ".apiKey");
  if (oldKey && !(await context.secrets.get(SECRET_KEY))) {
    await context.secrets.store(SECRET_KEY, oldKey);
  }
  for (const [oldKeyName, newKeyName] of [
    [legacy + ".sessions", SESSIONS_KEY],
    [legacy + ".recentUrls", RECENT_URLS_KEY],
  ]) {
    const value = context.globalState.get(oldKeyName);
    if (value !== undefined && context.globalState.get(newKeyName) === undefined) {
      await context.globalState.update(newKeyName, value);
    }
  }
  await context.globalState.update(MIGRATED, true);
}

export async function activate(context: vscode.ExtensionContext) {
  await migrateLegacyKeys(context);
  const proposed = new ProposedContent();
  const provider = new ChatViewProvider(context, proposed);

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, proposed),
    vscode.window.registerWebviewViewProvider("aicadChat", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),

    vscode.commands.registerCommand("aicad.setApiKey", async () => {
      const key = await vscode.window.showInputBox({
        prompt: "Gateway API key (gw_live_…) — stored in VS Code Secret Storage",
        password: true,
        ignoreFocusOut: true,
      });
      if (key) {
        await context.secrets.store(SECRET_KEY, key.trim());
        vscode.window.showInformationMessage("AIcad: API key saved.");
        provider.refreshModels();
      }
    }),

    vscode.commands.registerCommand("aicad.selectServer", async () => {
      const before = gatewayUrl();
      if ((await selectServer(context)) && gatewayUrl() === before) {
        // Same URL re-chosen: no config change event fires, so refresh here.
        provider.refreshModels();
      }
    }),

    vscode.commands.registerCommand("aicad.newChat", () => provider.newChat()),
    vscode.commands.registerCommand("aicad.showHistory", () => provider.showHistory()),
    vscode.commands.registerCommand("aicad.refreshModels", () => provider.refreshModels()),

    vscode.commands.registerCommand("aicad.explainSelection", () =>
      provider.sendSelectionPrompt(
        "Explain what this code does, briefly and clearly:",
      ),
    ),
    vscode.commands.registerCommand("aicad.refactorSelection", () =>
      provider.sendSelectionPrompt(
        "Refactor this code to be cleaner and more idiomatic. Return the improved code in a fenced block, then a short list of what changed:",
      ),
    ),
    vscode.commands.registerCommand("aicad.askSelection", async () => {
      const question = await vscode.window.showInputBox({
        prompt: "What do you want to ask about the selected code?",
        ignoreFocusOut: true,
      });
      if (question) provider.sendSelectionPrompt(question);
    }),
  );

  // Status bar: shows which gateway is active; click to switch.
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = "aicad.selectServer";
  const updateStatus = () => {
    const url = gatewayUrl();
    status.text = `$(plug) ${hostLabel(url)}`;
    status.tooltip = `AIcad: ${url}\nClick to switch server`;
  };
  updateStatus();
  status.show();

  context.subscriptions.push(
    status,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("aicad.url")) {
        updateStatus();
        provider.postServer();
        provider.refreshModels();
      }
    }),
  );
}

export function deactivate() {}

class ChatViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | null = null;
  private abort: AbortController | null = null;
  private pendingPrompt: string | null = null;
  private webviewReady = false;
  private readonly perms = new SessionPermissions();
  private readonly runner: AgentRunner;
  /** Approval cards waiting for the user's answer, by tool id. */
  private readonly approvals = new Map<string, (a: ApprovalAnswer) => void>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly proposed: ProposedContent,
  ) {
    this.runner = new AgentRunner(proposed, this.perms);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.webviewReady = false;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    view.webview.html = getHtml(view.webview, this.context.extensionUri);

    view.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case "ready":
          this.webviewReady = true;
          this.postServer();
          this.refreshModels();
          if (this.pendingPrompt) {
            const p = this.pendingPrompt;
            this.pendingPrompt = null;
            this.post({ type: "userMessage", text: p, autoSend: true });
          }
          break;
        case "send":
          await this.streamChat(msg.messages as ChatMessage[], msg.model as string);
          break;
        case "agentSend":
          await this.runAgent(msg.messages as ChatMessage[], msg.model as string);
          break;
        case "approval":
          this.approvals.get(msg.id as string)?.({
            decision: msg.decision as ApprovalAnswer["decision"],
            feedback: (msg.feedback as string) || undefined,
          });
          this.approvals.delete(msg.id as string);
          break;
        case "openDiff":
          this.runner.openDiff(msg.id as string);
          break;
        case "chatReset":
          // "Always allow" choices only last for one conversation.
          this.perms.reset();
          this.proposed.clear();
          break;
        case "stop":
          this.abort?.abort();
          break;
        case "insert": {
          const editor = vscode.window.activeTextEditor;
          if (!editor) {
            vscode.window.showWarningMessage("No active editor to insert into.");
            return;
          }
          editor.edit((b) => b.replace(editor.selection, msg.code as string));
          break;
        }
        case "setKey":
          vscode.commands.executeCommand("aicad.setApiKey");
          break;
        case "selectServer":
          vscode.commands.executeCommand("aicad.selectServer");
          break;
        case "pickFiles": {
          const uris = await vscode.window.showOpenDialog({
            canSelectMany: true,
            openLabel: "Attach",
            filters: {
              "Images and text": [...Object.keys(IMAGE_EXT), "txt", "md", "json", "csv", "log", "ts", "js", "tsx", "jsx", "py", "go", "rs", "java", "cs", "html", "css", "yml", "yaml", "xml", "sh", "sql"],
              "All files": ["*"],
            },
          });
          if (!uris?.length) return;
          const files: AttachedFile[] = [];
          for (const uri of uris) {
            const name = uri.path.split("/").pop() ?? "file";
            const ext = name.split(".").pop()?.toLowerCase() ?? "";
            const bytes = await vscode.workspace.fs.readFile(uri);
            const mime = IMAGE_EXT[ext];
            if (mime) {
              if (bytes.byteLength > MAX_IMAGE_BYTES) {
                vscode.window.showWarningMessage(`${name} is larger than 5 MB and was skipped.`);
                continue;
              }
              files.push({
                kind: "image",
                name,
                mime,
                dataUrl: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`,
              });
            } else {
              if (bytes.byteLength > MAX_TEXT_BYTES || bytes.includes(0)) {
                vscode.window.showWarningMessage(`${name} is not a text file under 200 KB and was skipped.`);
                continue;
              }
              files.push({ kind: "text", name, text: Buffer.from(bytes).toString("utf8") });
            }
          }
          if (files.length) this.post({ type: "files", files });
          break;
        }
        case "openSettings":
          vscode.commands.executeCommand("workbench.action.openSettings", "aicad");
          break;
        case "quickAction":
          // Only this extension's own editor commands may be triggered from the panel.
          if (QUICK_ACTIONS.has(msg.command as string)) {
            vscode.commands.executeCommand(msg.command as string);
          }
          break;
        case "refreshModels":
          this.refreshModels();
          break;
        case "listSessions":
          this.postSessions();
          break;
        case "saveSession":
          await this.saveSession(msg.id as string, msg.messages as ChatMessage[]);
          break;
        case "loadSession": {
          const s = this.sessions().find((x) => x.id === msg.id);
          if (s) this.post({ type: "sessionLoaded", id: s.id, messages: s.messages });
          break;
        }
        case "deleteSession":
          await this.context.globalState.update(
            SESSIONS_KEY,
            this.sessions().filter((x) => x.id !== msg.id),
          );
          this.postSessions();
          break;
      }
    });
  }

  newChat(): void {
    this.show();
    this.post({ type: "reset" });
  }

  showHistory(): void {
    this.show();
    this.post({ type: "showHistory" });
  }

  private show(): void {
    vscode.commands.executeCommand("aicadChat.focus");
  }

  private sessions(): Session[] {
    return this.context.globalState.get<Session[]>(SESSIONS_KEY, []);
  }

  /** Sends the session list (without message bodies) to the webview. */
  private postSessions(): void {
    this.post({
      type: "sessions",
      sessions: this.sessions().map((s) => ({
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
        count: s.messages.length,
      })),
    });
  }

  private async saveSession(id: string, messages: ChatMessage[]): Promise<void> {
    if (!id || !messages.length) return;
    const firstUser = messages.find((m) => m.role === "user");
    const first = firstUser ? messageText(firstUser) : "";
    const title = first.replace(/\s+/g, " ").trim().slice(0, 80) || "Untitled";
    const rest = this.sessions().filter((s) => s.id !== id);
    // Newest first; the oldest sessions fall off the end.
    const next = [
      { id, title, updatedAt: Date.now(), messages: stripImages(messages) },
      ...rest,
    ].slice(
      0,
      MAX_SESSIONS,
    );
    await this.context.globalState.update(SESSIONS_KEY, next);
  }

  /** Sends a prompt built from the current editor selection into the chat. */
  sendSelectionPrompt(instruction: string): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      vscode.window.showWarningMessage("Select some code first.");
      return;
    }
    const lang = editor.document.languageId;
    const code = editor.document.getText(editor.selection);
    const prompt = `${instruction}\n\n\`\`\`${lang}\n${code}\n\`\`\``;

    this.show();
    if (this.view && this.webviewReady) {
      this.post({ type: "userMessage", text: prompt, autoSend: true });
    } else {
      // View not resolved yet — deliver once the webview reports ready.
      this.pendingPrompt = prompt;
    }
  }

  async refreshModels(): Promise<void> {
    const key = await this.context.secrets.get(SECRET_KEY);
    if (!key) {
      this.post({ type: "needKey" });
      return;
    }
    try {
      const res = await fetch(`${gatewayUrl()}/models`, {
        headers: { authorization: `Bearer ${key}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { data: { id: string }[] };
      this.post({
        type: "models",
        models: json.data.map((m) => m.id),
        selected: defaultModel(),
      });
    } catch (err) {
      this.post({
        type: "error",
        message: `Cannot reach gateway at ${gatewayUrl()} (${(err as Error).message}). Make sure the gateway is running, or switch to another server.`,
        selectServer: true,
      });
    }
  }

  /** Tells the webview which gateway is active (shown in the toolbar). */
  postServer(): void {
    const url = gatewayUrl();
    this.post({ type: "server", url, host: hostLabel(url) });
  }

  private post(message: unknown): void {
    this.view?.webview.postMessage(message);
  }

  /** Agent mode: the loop runs here so tools act on this workspace. */
  private async runAgent(messages: ChatMessage[], model: string): Promise<void> {
    const key = await this.context.secrets.get(SECRET_KEY);
    if (!key) {
      this.post({ type: "needKey" });
      return;
    }
    this.abort?.abort();
    const controller = new AbortController();
    this.abort = controller;
    const denyPending = () => {
      for (const resolve of this.approvals.values()) resolve({ decision: "deny" });
      this.approvals.clear();
    };
    controller.signal.addEventListener("abort", denyPending);

    try {
      const result = await this.runner.run(
        messages,
        async (convo, signal, onProgress) => {
          this.post({ type: "agentStatus", text: "Waiting for the model" });
          const res = await fetch(`${gatewayUrl()}/chat/completions`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
            body: JSON.stringify({
              model: model || defaultModel(),
              messages: convo,
              stream: true,
              ...(agentEffort() ? { reasoning_effort: agentEffort() } : {}),
            }),
            signal,
          });
          if (!res.ok || !res.body) {
            const body = (await res.json().catch(() => null)) as {
              error?: { message?: string };
            } | null;
            throw new Error(body?.error?.message ?? `Gateway error (HTTP ${res.status})`);
          }

          let text = "";
          let servedBy = "";
          let tokens = 0;
          let lastPaint = 0;
          await readSse(res.body, (json) => {
            if (json.error) throw new Error(json.error.message ?? "gateway stream error");
            servedBy = json.model ?? servedBy;
            tokens = json.usage?.total_tokens ?? tokens;
            const thinking = json.gateway_progress?.thinking_tokens;
            if (thinking !== undefined && !text) {
              // The model reasons privately before it writes; show that it is
              // working rather than a silent wait.
              this.post({
                type: "agentLive",
                text: "",
                status: `Reasoning before it answers (${thinking.toLocaleString()} tokens so far)`,
              });
            }
            const delta = json.choices?.[0]?.delta?.content;
            if (!delta) return;
            text += delta;
            // Repainting the whole reply per token is wasteful on long edits.
            if (Date.now() - lastPaint > 120) {
              lastPaint = Date.now();
              onProgress(text);
            }
          });
          return { text, model: servedBy, tokens };
        },
        {
          live: (text, status) => this.post({ type: "agentLive", text, status }),
          text: (text) => this.post({ type: "agentText", text }),
          tool: (card) => this.post({ type: "agentTool", card }),
          toolUpdate: (id, status, output) =>
            this.post({ type: "agentToolUpdate", id, status, output }),
          requestApproval: (id) =>
            new Promise<ApprovalAnswer>((resolve) => this.approvals.set(id, resolve)),
        },
        controller.signal,
      );
      this.post({ type: "done", model: result.model, tokens: result.tokens });
      this.post({ type: "streamEnd" });
    } catch (err) {
      if ((err as Error).name === "AbortError" || controller.signal.aborted) {
        this.post({ type: "streamEnd", stopped: true });
      } else {
        this.post({ type: "error", message: (err as Error).message });
      }
    } finally {
      denyPending();
      if (this.abort === controller) this.abort = null;
    }
  }

  private async streamChat(messages: ChatMessage[], model: string): Promise<void> {
    const key = await this.context.secrets.get(SECRET_KEY);
    if (!key) {
      this.post({ type: "needKey" });
      return;
    }
    this.abort?.abort();
    const controller = new AbortController();
    this.abort = controller;

    try {
      const res = await fetch(`${gatewayUrl()}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: model || defaultModel(),
          messages: [{ role: "system", content: CHAT_SYSTEM }, ...messages],
          stream: true,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        this.post({
          type: "error",
          message: body?.error?.message ?? `Gateway error (HTTP ${res.status})`,
        });
        return;
      }
      if (!res.body) {
        this.post({ type: "error", message: "Empty response body" });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let servedBy = "";

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx).replace(/\r$/, "");
          buffer = buffer.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            const json = JSON.parse(payload);
            if (json.error) {
              this.post({ type: "error", message: json.error.message });
              continue;
            }
            servedBy = json.model ?? servedBy;
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) this.post({ type: "delta", text: delta });
            if (json.usage) {
              this.post({
                type: "done",
                model: servedBy,
                tokens: json.usage.total_tokens,
              });
            }
          } catch {
            /* ignore partial frames */
          }
        }
      }
      this.post({ type: "streamEnd" });
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        this.post({ type: "streamEnd", stopped: true });
      } else {
        this.post({ type: "error", message: (err as Error).message });
      }
    } finally {
      if (this.abort === controller) this.abort = null;
    }
  }
}

type SseChunk = {
  error?: { message?: string };
  model?: string;
  choices?: { delta?: { content?: string } }[];
  usage?: { total_tokens?: number };
  /** Gateway extension: hidden reasoning progress. */
  gateway_progress?: { thinking_tokens?: number };
};

/** Reads an OpenAI-style SSE body, handing each JSON frame to `onJson`. */
async function readSse(
  body: ReadableStream<Uint8Array>,
  onJson: (json: SseChunk) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, idx).replace(/\r$/, "");
      buffer = buffer.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let json: SseChunk;
      try {
        json = JSON.parse(payload) as SseChunk;
      } catch {
        continue; // partial frame
      }
      onJson(json);
    }
  }
}

