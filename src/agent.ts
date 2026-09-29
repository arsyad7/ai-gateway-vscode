import * as vscode from "vscode";
import { exec, type ChildProcess } from "node:child_process";
import * as path from "node:path";

/** Chat message sent to the gateway (OpenAI-compatible). */
/** OpenAI-style content parts; the gateway accepts these as-is. */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
};

export function messageText(m: ChatMessage): string {
  if (typeof m.content === "string") return m.content;
  return m.content
    .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");
}

export type ToolStatus = "pending" | "running" | "done" | "error" | "denied";

/** What the webview needs to draw one tool step. */
export type ToolCard = {
  id: string;
  name: string;
  /** One-line summary, e.g. "Edit src/app.ts". */
  title: string;
  /** Command text or other plain detail shown in a code block. */
  detail?: string;
  /** Removed/added lines for edits. */
  diff?: { removed: string; added: string };
  /** Label for the "always allow" button; absent = no approval needed. */
  alwaysLabel?: string;
  canOpenDiff?: boolean;
  status: ToolStatus;
};

export type ApprovalAnswer = {
  decision: "allow" | "always" | "deny";
  feedback?: string;
};

export type AgentUi = {
  /** The reply so far while it streams, plus what the model is doing. */
  live(text: string, status: string): void;
  /** Final text of one model turn (may be empty). */
  text(text: string): void;
  tool(card: ToolCard): void;
  toolUpdate(id: string, status: ToolStatus, output?: string): void;
  requestApproval(id: string): Promise<ApprovalAnswer>;
};

/** "Always allow" choices; they last until the conversation is reset. */
export class SessionPermissions {
  edits = false;
  readonly commands = new Set<string>();
  reset(): void {
    this.edits = false;
    this.commands.clear();
  }
}

export type CompleteFn = (
  messages: ChatMessage[],
  signal: AbortSignal,
  /** Called with the whole reply received so far. */
  onProgress: (rawSoFar: string) => void,
) => Promise<{ text: string; model: string; tokens: number }>;

const MAX_ITERATIONS = 25;
const MAX_READ_CHARS = 60_000;
const MAX_OUTPUT_CHARS = 20_000;
const COMMAND_TIMEOUT_MS = 120_000;
const EXCLUDE = "**/{node_modules,.git,dist,out,build,.next,.venv,__pycache__}/**";
const TOOL_CALL_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
export const PROPOSED_SCHEME = "aigw-proposed";

/** Serves proposed file contents to the diff editor. */
export class ProposedContent implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  set(id: string, text: string): void {
    this.contents.set(id, text);
  }
  clear(): void {
    this.contents.clear();
  }
  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.query) ?? "";
  }
}

function workspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) throw new Error("Open a folder first — Agent mode works on the workspace.");
  return folder.uri.fsPath;
}

/** Resolves a model-supplied path and refuses anything outside the workspace. */
function resolveInWorkspace(root: string, p: unknown): string {
  if (typeof p !== "string" || !p.trim()) throw new Error("'path' is required");
  const abs = path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path is outside the workspace: ${p}`);
  }
  return abs;
}

function relPath(root: string, abs: string): string {
  return path.relative(root, abs).replace(/\\/g, "/") || ".";
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n…[${text.length - max} chars truncated]…\n${text.slice(-half)}`;
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/** Current text with LF newlines (includes unsaved editor changes). */
async function readText(uri: vscode.Uri): Promise<{ text: string; crlf: boolean }> {
  const stat = await vscode.workspace.fs.stat(uri);
  if (stat.size > 2_000_000) throw new Error("file is larger than 2 MB");
  const doc = await vscode.workspace.openTextDocument(uri);
  return {
    text: doc.getText().replace(/\r\n/g, "\n"),
    crlf: doc.eol === vscode.EndOfLine.CRLF,
  };
}

async function writeText(uri: vscode.Uri, text: string, crlf: boolean): Promise<void> {
  const out = crlf ? text.replace(/\n/g, "\r\n") : text;
  if (await exists(uri)) {
    // Go through the editor model so open/dirty documents stay consistent.
    const doc = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit();
    const end = doc.lineAt(doc.lineCount - 1).range.end;
    edit.replace(uri, new vscode.Range(new vscode.Position(0, 0), end), out);
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error("VS Code rejected the edit");
    await doc.save();
  } else {
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(out));
  }
  vscode.window.showTextDocument(uri, { preview: true, preserveFocus: true }).then(
    undefined,
    () => undefined,
  );
}

/** Output-format guidance shared by chat and agent mode; the panel renders Markdown. */
export const FORMAT_RULES =
  "Formatting: the panel renders Markdown, so use it. Put code, commands, file contents and error text in fenced code blocks with a language tag (```ts, ```bash, …). Use inline code for identifiers, paths and flags. Use short headings or bullet lists to structure longer answers, bold to highlight key terms, and tables to compare options. Keep short answers short: no headings for a one-paragraph reply.";

function systemPrompt(root: string): string {
  const active = vscode.window.activeTextEditor?.document.uri.fsPath;
  const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
  return `You are AIcad, a coding agent working inside the user's VS Code workspace. You act through tools that the editor runs for you; the user sees every action and approves the ones that change files or run commands.

Workspace root: ${root}
Platform: ${process.platform} (run_command uses ${shell})${active ? `\nFile open in the editor: ${relPath(root, active)}` : ""}

Tools (paths are relative to the workspace root):
- read_file {"path", "offset"?, "limit"?} — read a text file. Lines come back as "<line number>\\t<text>"; that prefix is not part of the file.
- list_files {"pattern"?} — list files by glob (default "**/*").
- search_text {"query", "include"?} — case-insensitive regex search; "include" is a glob.
- edit_file {"path", "old_string", "new_string", "replace_all"?} — replace exact text. old_string must match the file exactly (whitespace included) and be unique unless replace_all is true.
- write_file {"path", "content"} — create a file or overwrite it completely.
- run_command {"command"} — run a shell command in the workspace root (${COMMAND_TIMEOUT_MS / 1000}s timeout).

To use a tool, write a block in exactly this form, then stop and wait:
<tool_call>{"name": "<tool>", "args": { ... }}</tool_call>
Several blocks in one turn are allowed. Results come back in the next message as [tool_result <tool>] sections. Never write a tool result yourself and never claim an action happened before you have seen its result.

How to work:
- Say in one short sentence what you are about to do before each tool call.
- Read a file before editing it. Prefer edit_file with small, targeted replacements over write_file.
- If the user denies an action, do not retry it unchanged — follow their feedback or ask.
- When the task is done, reply with a short summary and no tool_call block. Answer in the user's language.

${FORMAT_RULES}`;
}

type Call = { name: string; args: Record<string, unknown> };

const TOOL_VERBS: Record<string, string> = {
  read_file: "Preparing to read",
  list_files: "Preparing to list files",
  search_text: "Preparing a search",
  edit_file: "Writing an edit for",
  write_file: "Writing the contents of",
  run_command: "Preparing a command",
};

/** While a turn streams: the prose to show, and a status for the hidden part. */
function livePreview(full: string): { text: string; status: string } {
  const invented = full.indexOf("[tool_result");
  const raw = invented >= 0 ? full.slice(0, invented) : full;
  const open = raw.lastIndexOf("<tool_call>");
  const inCall = open >= 0 && raw.indexOf("</tool_call>", open) < 0;
  const text = (inCall ? raw.slice(0, open) : raw)
    .replace(TOOL_CALL_RE, "")
    .replace(/<[a-z_/]*$/, "") // half-received tag
    .trim();
  if (!inCall) return { text, status: "Writing…" };

  const partial = raw.slice(open);
  const name = /"name"\s*:\s*"([^"]+)"/.exec(partial)?.[1] ?? "";
  const target = /"(?:path|command|query)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(partial)?.[1] ?? "";
  const verb = TOOL_VERBS[name] ?? "Preparing an action";
  return {
    text,
    status: `${verb}${target ? " " + target : ""}… (${partial.length.toLocaleString()} chars so far)`,
  };
}

/** Splits a model turn into visible text and tool calls. */
function parseTurn(full: string): { text: string; kept: string; calls: Call[]; errors: string[] } {
  // Smaller models sometimes write a made-up "[tool_result …]" and carry on
  // from it. Cut the turn there so later calls wait for the real result.
  const invented = full.indexOf("[tool_result");
  const raw = invented >= 0 ? full.slice(0, invented) : full;
  const calls: Call[] = [];
  const errors: string[] = [];
  let lastEnd = -1;
  for (const m of raw.matchAll(TOOL_CALL_RE)) {
    lastEnd = (m.index ?? 0) + m[0].length;
    try {
      const parsed = JSON.parse(m[1]) as { name?: unknown; args?: unknown };
      if (typeof parsed.name !== "string") throw new Error("missing 'name'");
      calls.push({
        name: parsed.name,
        args: (parsed.args && typeof parsed.args === "object" ? parsed.args : {}) as Record<string, unknown>,
      });
    } catch (err) {
      errors.push(`Malformed <tool_call> JSON (${(err as Error).message}). Send it again as valid JSON.`);
    }
  }
  // Anything after the last call would be the model inventing results.
  const kept = lastEnd >= 0 ? raw.slice(0, lastEnd) : raw;
  return { text: kept.replace(TOOL_CALL_RE, "").trim(), kept, calls, errors };
}

export class AgentRunner {
  private child: ChildProcess | null = null;
  private readonly diffs = new Map<string, { uri: vscode.Uri; isNew: boolean }>();
  private seq = 0;

  constructor(
    private readonly proposed: ProposedContent,
    private readonly perms: SessionPermissions,
  ) {}

  /** Opens VS Code's diff editor for a pending edit. */
  async openDiff(id: string): Promise<void> {
    const d = this.diffs.get(id);
    if (!d) return;
    const right = vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: d.uri.path, query: id });
    const left = d.isNew
      ? vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: d.uri.path, query: "empty" })
      : d.uri;
    await vscode.commands.executeCommand(
      "vscode.diff",
      left,
      right,
      `${path.basename(d.uri.fsPath)} (proposed by agent)`,
      { preview: true },
    );
  }

  async run(
    history: ChatMessage[],
    complete: CompleteFn,
    ui: AgentUi,
    signal: AbortSignal,
  ): Promise<{ model: string; tokens: number }> {
    const root = workspaceRoot();
    const convo: ChatMessage[] = [{ role: "system", content: systemPrompt(root) }, ...history];
    let tokens = 0;
    let model = "";
    signal.addEventListener("abort", () => this.child?.kill());

    for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
      const res = await complete(convo, signal, (raw) => {
        const live = livePreview(raw);
        ui.live(live.text, live.status);
      });
      tokens += res.tokens;
      model = res.model || model;

      const turn = parseTurn(res.text);
      ui.text(turn.text);
      convo.push({ role: "assistant", content: turn.kept });
      if (!turn.calls.length && !turn.errors.length) return { model, tokens };

      const results = [...turn.errors.map((e) => `[tool_result error]\n${e}`)];
      for (const call of turn.calls) {
        if (signal.aborted) throw abortError();
        results.push(`[tool_result ${call.name}]\n${await this.execute(root, call, ui, signal)}`);
      }
      convo.push({ role: "user", content: results.join("\n\n") });
    }
    ui.text(`(stopped after ${MAX_ITERATIONS} steps — say "continue" to keep going)`);
    return { model, tokens };
  }

  private async execute(root: string, call: Call, ui: AgentUi, signal: AbortSignal): Promise<string> {
    const id = `t${Date.now().toString(36)}_${this.seq++}`;
    const fail = (title: string, err: unknown): string => {
      const msg = (err as Error).message ?? String(err);
      ui.tool({ id, name: call.name, title, status: "error" });
      ui.toolUpdate(id, "error", msg);
      return `error: ${msg}`;
    };
    const a = call.args;

    try {
      switch (call.name) {
        case "read_file": {
          const abs = resolveInWorkspace(root, a.path);
          ui.tool({ id, name: call.name, title: `Read ${relPath(root, abs)}`, status: "running" });
          const { text } = await readText(vscode.Uri.file(abs));
          const lines = text.split("\n");
          const offset = Math.max(1, Number(a.offset) || 1);
          const limit = Math.max(1, Number(a.limit) || 2000);
          const slice = lines.slice(offset - 1, offset - 1 + limit);
          const body = slice.map((l, i) => `${offset + i}\t${l}`).join("\n");
          ui.toolUpdate(id, "done", `${slice.length} of ${lines.length} lines`);
          return clip(body, MAX_READ_CHARS) || "(empty file)";
        }
        case "list_files": {
          const pattern = typeof a.pattern === "string" && a.pattern ? a.pattern : "**/*";
          ui.tool({ id, name: call.name, title: `List files ${pattern}`, status: "running" });
          const found = await vscode.workspace.findFiles(pattern, EXCLUDE, 500);
          const names = found.map((u) => relPath(root, u.fsPath)).sort();
          ui.toolUpdate(id, "done", `${names.length} files`);
          return names.join("\n") || "(no files matched)";
        }
        case "search_text": {
          const query = String(a.query ?? "");
          if (!query) throw new Error("'query' is required");
          ui.tool({ id, name: call.name, title: `Search "${query}"`, status: "running" });
          const out = await searchText(root, query, typeof a.include === "string" ? a.include : undefined);
          ui.toolUpdate(id, "done", `${out.count} matches`);
          return out.text;
        }
        case "edit_file":
        case "write_file":
          return await this.changeFile(root, id, call, ui);
        case "run_command":
          return await this.runCommand(root, id, call, ui, signal);
        default:
          return fail(`Unknown tool ${call.name}`, new Error(`unknown tool '${call.name}'`));
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") throw err;
      return fail(`${call.name} failed`, err);
    }
  }

  private async changeFile(root: string, id: string, call: Call, ui: AgentUi): Promise<string> {
    const a = call.args;
    const abs = resolveInWorkspace(root, a.path);
    const uri = vscode.Uri.file(abs);
    const rel = relPath(root, abs);
    const isNew = !(await exists(uri));

    // Work out the new content first, so invalid edits never reach the user.
    let next: string;
    let crlf = false;
    let diff: ToolCard["diff"];
    if (call.name === "edit_file") {
      if (isNew) throw new Error(`file does not exist: ${rel} (use write_file to create it)`);
      const oldStr = String(a.old_string ?? "").replace(/\r\n/g, "\n");
      const newStr = String(a.new_string ?? "").replace(/\r\n/g, "\n");
      if (!oldStr) throw new Error("'old_string' is required");
      if (oldStr === newStr) throw new Error("old_string and new_string are identical");
      const cur = await readText(uri);
      crlf = cur.crlf;
      const count = cur.text.split(oldStr).length - 1;
      if (count === 0) throw new Error("old_string was not found in the file — read the file and match it exactly");
      if (count > 1 && a.replace_all !== true) {
        throw new Error(`old_string occurs ${count} times — add surrounding context to make it unique, or set replace_all`);
      }
      next = cur.text.split(oldStr).join(newStr);
      diff = { removed: clip(oldStr, 4000), added: clip(newStr, 4000) };
    } else {
      if (typeof a.content !== "string") throw new Error("'content' (string) is required");
      next = a.content.replace(/\r\n/g, "\n");
      if (!isNew) crlf = (await readText(uri)).crlf;
      diff = { removed: "", added: clip(next, 4000) };
    }

    const title = `${isNew ? "Create" : call.name === "edit_file" ? "Edit" : "Overwrite"} ${rel}`;
    this.proposed.set(id, next);
    this.diffs.set(id, { uri, isNew });
    const needsApproval = !this.perms.edits;
    ui.tool({
      id,
      name: call.name,
      title,
      diff,
      canOpenDiff: true,
      alwaysLabel: needsApproval ? "Yes, allow all edits this session" : undefined,
      status: needsApproval ? "pending" : "running",
    });

    if (needsApproval) {
      const answer = await ui.requestApproval(id);
      if (answer.decision === "deny") return denied(id, ui, answer.feedback);
      if (answer.decision === "always") this.perms.edits = true;
      ui.toolUpdate(id, "running");
    }
    await writeText(uri, next, crlf);
    ui.toolUpdate(id, "done", isNew ? "file created" : "file updated");
    return `ok: ${title}`;
  }

  private async runCommand(root: string, id: string, call: Call, ui: AgentUi, signal: AbortSignal): Promise<string> {
    const command = String(call.args.command ?? "").trim();
    if (!command) throw new Error("'command' is required");
    const needsApproval = !this.perms.commands.has(command);
    ui.tool({
      id,
      name: call.name,
      title: "Run command",
      detail: command,
      alwaysLabel: needsApproval ? "Yes, and don't ask again for this exact command" : undefined,
      status: needsApproval ? "pending" : "running",
    });

    if (needsApproval) {
      const answer = await ui.requestApproval(id);
      if (answer.decision === "deny") return denied(id, ui, answer.feedback);
      if (answer.decision === "always") this.perms.commands.add(command);
      ui.toolUpdate(id, "running");
    }

    const result = await new Promise<string>((resolve) => {
      this.child = exec(
        command,
        { cwd: root, timeout: COMMAND_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => {
          this.child = null;
          const code = err ? ((err as { code?: number | string }).code ?? 1) : 0;
          const note = err && (err as { killed?: boolean }).killed ? " (killed: timeout or stopped)" : "";
          resolve(
            `exit code: ${code}${note}` +
              (stdout ? `\n--- stdout ---\n${stdout}` : "") +
              (stderr ? `\n--- stderr ---\n${stderr}` : ""),
          );
        },
      );
    });
    if (signal.aborted) throw abortError();
    const out = clip(result, MAX_OUTPUT_CHARS);
    ui.toolUpdate(id, result.startsWith("exit code: 0") ? "done" : "error", out);
    return out;
  }
}

function denied(id: string, ui: AgentUi, feedback?: string): string {
  ui.toolUpdate(id, "denied", feedback ? `Denied: ${feedback}` : "Denied");
  return feedback
    ? `The user denied this action and said: ${feedback}`
    : "The user denied this action. Do not retry it; ask what they want instead or continue another way.";
}

function abortError(): Error {
  const e = new Error("stopped");
  e.name = "AbortError";
  return e;
}

async function searchText(
  root: string,
  query: string,
  include: string | undefined,
): Promise<{ text: string; count: number }> {
  let re: RegExp;
  try {
    re = new RegExp(query, "i");
  } catch {
    re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
  }
  const files = await vscode.workspace.findFiles(include || "**/*", EXCLUDE, 3000);
  const hits: string[] = [];
  const decoder = new TextDecoder();
  for (const uri of files) {
    if (hits.length >= 200) break;
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > 512_000) continue;
      const text = decoder.decode(await vscode.workspace.fs.readFile(uri));
      if (text.includes("\u0000")) continue; // binary
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length && hits.length < 200; i++) {
        if (re.test(lines[i])) {
          hits.push(`${relPath(root, uri.fsPath)}:${i + 1}: ${lines[i].trim().slice(0, 240)}`);
        }
      }
    } catch {
      /* unreadable file: skip */
    }
  }
  return {
    count: hits.length,
    text: hits.length ? hits.join("\n") + (hits.length >= 200 ? "\n…(more matches not shown)" : "") : "(no matches)",
  };
}
