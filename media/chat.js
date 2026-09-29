// AIcad chat panel (webview side). Talks to the extension host only
// through postMessage; the message protocol is unchanged from earlier
// versions so the host code needs no changes to work with this UI.
(function () {
  "use strict";
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  const messagesEl = $("messages");
  const inputEl = $("input");
  const sendBtn = $("send");
  const modelEl = $("model");
  const modelWrap = $("modelWrap");
  const emptyEl = $("empty");
  const historyEl = $("history");
  const sessionList = $("sessionList");
  const hsearch = $("hsearch");
  const historyBtn = $("historyBtn");
  const jumpBtn = $("jump");
  const serverBtn = $("server");
  const connDot = $("connDot");
  const servedEl = $("served");
  const hintEl = $("hint");
  const modeSeg = $("mode");

  // ---------- icons (inline SVG, stroke = currentColor) ----------
  const ICON = {
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
    insert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12l7 7 7-7"/></svg>',
    file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>',
    folder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>',
    terminal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m4 17 6-6-6-6M12 19h8"/></svg>',
    diff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v14M5 10h14M5 21h14"/></svg>',
    spark: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 6.6L21 11l-6.6 2.4L12 20l-2.4-6.6L3 11l6.6-2.4z"/></svg>',
    warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>',
    cpu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3"/></svg>',
    token: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8 12h8M12 8v8"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>',
  };
  const TOOL_ICON = {
    read_file: "file", list_files: "folder", search_text: "search",
    edit_file: "edit", write_file: "edit", run_command: "terminal",
  };
  function svg(name) {
    const span = document.createElement("span");
    span.innerHTML = ICON[name] || "";
    return span.firstChild;
  }
  function iconButton(name, title, onClick) {
    const b = document.createElement("button");
    b.className = "icon";
    b.title = title;
    b.appendChild(svg(name));
    b.onclick = (e) => { e.stopPropagation(); onClick(b); };
    return b;
  }
  function flashCheck(btn) {
    btn.innerHTML = "";
    btn.appendChild(svg("check"));
    setTimeout(() => { btn.innerHTML = ""; btn.appendChild(svg("copy")); }, 1200);
  }

  // ---------- state ----------
  let history = [];        // {role, content}
  let sessionId = null;    // assigned on the first send of a conversation
  let mode = (vscode.getState() || {}).mode || "agent";
  let agentRun = false;    // the reply in progress is an agent run
  let streaming = false;
  let currentBody = null;  // element receiving deltas
  let currentWrap = null;  // its message container
  let currentText = "";
  let thinkingEl = null;
  let liveTurn = null;     // element showing the agent turn streaming in
  const toolEls = {};      // tool id -> card parts
  let stick = true;        // auto-scroll follows new content
  let allSessions = [];
  let attachments = [];    // {id, kind: "image" | "text", name, mime?, dataUrl?, text?}
  const attachEl = $("attach");
  const boxEl = $("box");

  // ---------- mode ----------
  function setMode(m) {
    mode = m;
    vscode.setState({ mode });
    for (const b of modeSeg.querySelectorAll("button")) b.classList.toggle("on", b.dataset.v === m);
    hintEl.textContent = m === "agent"
      ? "Agent can read, edit and run in this workspace · asks before changes"
      : "Chat only · Enter to send, Shift+Enter for newline";
    inputEl.placeholder = m === "agent" ? "Describe the task…" : "Ask anything…";
  }
  modeSeg.onclick = (e) => {
    const b = e.target.closest("button");
    if (b) setMode(b.dataset.v);
  };
  setMode(mode);

  // ---------- scrolling ----------
  messagesEl.addEventListener("scroll", () => {
    const gap = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
    stick = gap < 48;
    jumpBtn.classList.toggle("show", !stick);
  });
  function scroll(force) {
    if (force) stick = true;
    if (stick) messagesEl.scrollTop = messagesEl.scrollHeight;
    jumpBtn.classList.toggle("show", !stick);
  }
  jumpBtn.onclick = () => scroll(true);

  // ---------- markdown ----------
  const FENCE = /\n?```([^\n`]*)\n?/;
  const INLINE = new RegExp(
    "(`+)([\\s\\S]*?[^`])\\1(?!`)" +                   // 1,2 code
    "|\\*\\*([^*\\n]+?)\\*\\*|__([^_\\n]+?)__" +        // 3,4 bold
    "|(?<![\\w*])\\*([^*\\n]+?)\\*(?![\\w*])" +         // 5 italic *
    "|(?<![\\w_])_([^_\\n]+?)_(?![\\w_])" +             // 6 italic _
    "|~~([^~\\n]+?)~~" +                               // 7 strike
    "|\\[([^\\]\\n]+?)\\]\\(([^)\\s]+)\\)" +            // 8,9 link
    "|(https?:\\/\\/[^\\s<>)]+[^\\s<>).,;:!?'\"])",   // 10 bare url
    "g");

  function inline(el, text) {
    // Fresh instance per call: the recursion below would otherwise clobber
    // the shared regex's lastIndex mid-loop.
    const re = new RegExp(INLINE.source, "g");
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) el.appendChild(document.createTextNode(text.slice(last, m.index)));
      let node;
      if (m[2] !== undefined) { node = document.createElement("code"); node.textContent = m[2].trim(); }
      else if (m[3] !== undefined || m[4] !== undefined) { node = document.createElement("strong"); inline(node, m[3] ?? m[4]); }
      else if (m[5] !== undefined || m[6] !== undefined) { node = document.createElement("em"); inline(node, m[5] ?? m[6]); }
      else if (m[7] !== undefined) { node = document.createElement("s"); inline(node, m[7]); }
      else if (m[8] !== undefined) { node = document.createElement("a"); node.href = m[9]; node.title = m[9]; inline(node, m[8]); }
      else { node = document.createElement("a"); node.href = m[10]; node.textContent = m[10]; }
      el.appendChild(node);
      last = m.index + m[0].length;
    }
    if (last < text.length) el.appendChild(document.createTextNode(text.slice(last)));
  }

  const RE_H = /^(#{1,6})\s+(.*?)\s*#*$/;
  const RE_HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
  const RE_UL = /^\s*[-*+]\s+(.*)$/;
  const RE_OL = /^\s*\d+[.)]\s+(.*)$/;
  const RE_TASK = /^\[([ xX])\]\s+/;
  const RE_TSEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

  function blocks(el, md) {
    const lines = md.split("\n");
    let para = [];
    const flush = () => {
      if (!para.length) return;
      const p = document.createElement("p");
      inline(p, para.join("\n"));
      el.appendChild(p);
      para = [];
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let m;
      if (!line.trim()) { flush(); continue; }
      if ((m = RE_H.exec(line))) {
        flush();
        const h = document.createElement("h" + Math.min(4, m[1].length));
        inline(h, m[2]);
        el.appendChild(h);
      } else if (RE_HR.test(line)) {
        flush(); el.appendChild(document.createElement("hr"));
      } else if (line.startsWith(">")) {
        flush();
        const q = document.createElement("blockquote");
        const buf = [];
        while (i < lines.length && lines[i].startsWith(">")) buf.push(lines[i++].replace(/^>\s?/, ""));
        i--;
        inline(q, buf.join("\n"));
        el.appendChild(q);
      } else if (RE_UL.test(line) || RE_OL.test(line)) {
        flush();
        const ordered = RE_OL.test(line);
        const re = ordered ? RE_OL : RE_UL;
        const list = document.createElement(ordered ? "ol" : "ul");
        while (i < lines.length && (m = re.exec(lines[i]))) {
          const li = document.createElement("li");
          let body = m[1];
          const t = RE_TASK.exec(body);
          if (t) {
            const cb = document.createElement("input");
            cb.type = "checkbox"; cb.disabled = true; cb.checked = t[1] !== " ";
            li.appendChild(cb); li.appendChild(document.createTextNode(" "));
            body = body.slice(t[0].length);
          }
          // Continuation lines indented under the item stay in it.
          i++;
          while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !re.test(lines[i])) body += "\n" + lines[i++].trim();
          inline(li, body);
          list.appendChild(li);
        }
        i--;
        el.appendChild(list);
      } else if (line.trim().startsWith("|") && i + 1 < lines.length && RE_TSEP.test(lines[i + 1])) {
        flush();
        const table = document.createElement("table");
        const cells = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
        const addRow = (l, tag) => {
          const tr = document.createElement("tr");
          for (const c of cells(l)) { const td = document.createElement(tag); inline(td, c); tr.appendChild(td); }
          table.appendChild(tr);
        };
        addRow(line, "th");
        i += 2;
        while (i < lines.length && lines[i].trim().startsWith("|")) addRow(lines[i++], "td");
        i--;
        el.appendChild(table);
      } else {
        para.push(line);
      }
    }
    flush();
  }

  // Assistant text: fenced code blocks (with copy/insert) around markdown.
  function renderMarkdown(el, text) {
    el.textContent = "";
    el.classList.add("md");
    // Every fence (opening or closing) yields its info-string at an odd index
    // and toggles whether the following even-index chunk is code. A fence
    // still open while streaming leaves the final chunk as code.
    const parts = text.split(FENCE);
    let inCode = false, lang = "";
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 1) { lang = parts[i].trim(); inCode = !inCode; continue; }
      if (!parts[i] && !inCode) continue;
      if (inCode) el.appendChild(codeBlock(parts[i].replace(/\n$/, ""), lang));
      else blocks(el, parts[i]);
    }
  }

  function codeBlock(code, lang) {
    const wrap = document.createElement("div");
    wrap.className = "codeblock";
    const head = document.createElement("div");
    head.className = "cb-head";
    const l = document.createElement("span");
    l.className = "lang";
    l.textContent = lang || "text";
    head.appendChild(l);
    head.appendChild(iconButton("copy", "Copy code", (b) => {
      navigator.clipboard.writeText(code); flashCheck(b);
    }));
    head.appendChild(iconButton("insert", "Insert at cursor / replace selection", () =>
      vscode.postMessage({ type: "insert", code })));
    const pre = document.createElement("pre");
    highlight(pre, code, lang);
    wrap.appendChild(head); wrap.appendChild(pre);
    return wrap;
  }

  // ---------- syntax highlighting (small, language-agnostic) ----------
  const KEYWORDS = new Set(("abstract as async await break case catch class const continue debugger default delete do else enum " +
    "export extends false finally for from function get if implements import in instanceof interface let new null of package " +
    "private protected public readonly return set static super switch this throw true try type typeof undefined var void while " +
    "with yield def elif except lambda pass raise not and or is None True False global nonlocal assert del print self " +
    "fn pub mut impl struct trait match use mod crate where loop ref move unsafe dyn " +
    "func go chan defer map range select int int64 string bool float64 error nil var byte rune " +
    "echo then fi esac done local export exit " +
    "SELECT FROM WHERE INSERT INTO VALUES UPDATE DELETE JOIN LEFT RIGHT INNER OUTER ON AND OR NOT NULL CREATE TABLE ALTER DROP " +
    "INDEX PRIMARY KEY GROUP BY ORDER LIMIT HAVING AS DISTINCT UNION SET BEGIN COMMIT ROLLBACK " +
    "select from where insert into values update delete join left right inner outer on group by order limit having distinct union " +
    "begin commit rollback " +
    "final native synchronized transient volatile throws boolean char double float long short int void").split(" "));
  const HASH_LANGS = new Set(["py", "python", "sh", "bash", "shell", "zsh", "yaml", "yml", "rb", "ruby", "toml", "ini", "dockerfile", "makefile", "r", "perl", "conf"]);
  const SLASH_LANGS = new Set(["js", "javascript", "ts", "typescript", "tsx", "jsx", "java", "c", "cpp", "cs", "csharp", "go", "rust", "rs", "kotlin", "kt", "swift", "php", "scala", "dart", "json", "jsonc", "css", "scss", "less"]);

  function highlight(pre, code, lang) {
    lang = (lang || "").toLowerCase();
    const hash = HASH_LANGS.has(lang) || (!SLASH_LANGS.has(lang) && !lang);
    const slash = SLASH_LANGS.has(lang) || !lang;
    const sqlish = lang === "sql" || lang === "";
    const re = new RegExp(
      "(" + (slash ? "\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/|" : "") +
        (hash ? "#(?![0-9a-fA-F]{3,8}\\b)[^\\n]*|" : "") +
        (sqlish ? "--[^\\n]*|" : "") + "<!--[\\s\\S]*?-->)" +
      "|(\"(?:\\\\.|[^\"\\\\\\n])*\"|'(?:\\\\.|[^'\\\\\\n])*'|`(?:\\\\.|[^`\\\\])*`)" +
      "|\\b(0x[0-9a-fA-F]+|\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?)\\b" +
      "|\\b([A-Za-z_$][\\w$]*)\\b",
      "g");
    let last = 0, m;
    const push = (text, cls) => {
      if (!text) return;
      if (!cls) { pre.appendChild(document.createTextNode(text)); return; }
      const s = document.createElement("span");
      s.className = cls; s.textContent = text;
      pre.appendChild(s);
    };
    while ((m = re.exec(code))) {
      push(code.slice(last, m.index));
      if (m[1] !== undefined) push(m[1], "tk-c");
      else if (m[2] !== undefined) push(m[2], "tk-s");
      else if (m[3] !== undefined) push(m[3], "tk-n");
      else {
        const w = m[4];
        const next = code[m.index + w.length];
        if (KEYWORDS.has(w)) push(w, "tk-k");
        else if (next === "(") push(w, "tk-f");
        else if (/^[A-Z][a-z]/.test(w)) push(w, "tk-t");
        else push(w);
      }
      last = m.index + m[0].length;
    }
    push(code.slice(last));
  }

  // ---------- messages ----------
  function addMessage(role, text, extra) {
    if (emptyEl.parentNode) emptyEl.remove();
    const wrap = document.createElement("div");
    wrap.className = "msg " + role;
    const who = document.createElement("div");
    who.className = "who";
    const av = document.createElement("span");
    av.className = "avatar " + (role === "user" ? "you" : "ai");
    if (role === "user") av.textContent = "U"; else av.appendChild(svg("spark"));
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = role === "user" ? "You" : "AIcad";
    const actions = document.createElement("div");
    actions.className = "actions";
    actions.appendChild(iconButton("copy", "Copy message", (b) => {
      navigator.clipboard.writeText(wrap.raw ?? body.textContent); flashCheck(b);
    }));
    who.appendChild(av); who.appendChild(name); who.appendChild(actions);
    const body = document.createElement("div");
    body.className = "body";
    wrap.appendChild(who);
    if (extra && extra.images && extra.images.length) {
      const imgs = document.createElement("div");
      imgs.className = "imgs";
      for (const src of extra.images) {
        const img = document.createElement("img");
        img.src = src; img.alt = "attached image"; img.title = "Click to enlarge";
        img.onclick = () => img.classList.toggle("big");
        imgs.appendChild(img);
      }
      wrap.appendChild(imgs);
    }
    if (extra && extra.files && extra.files.length) {
      const files = document.createElement("div");
      files.className = "files";
      for (const n of extra.files) {
        const s = document.createElement("span");
        s.appendChild(svg("file")); s.appendChild(document.createTextNode(" " + n));
        files.appendChild(s);
      }
      wrap.appendChild(files);
    }
    wrap.appendChild(body);
    wrap.raw = text || "";
    messagesEl.appendChild(wrap);
    if (text) body.textContent = text;
    scroll();
    return { wrap, body };
  }

  function addNotice(text, action) {
    const div = document.createElement("div");
    div.className = "notice";
    div.appendChild(svg("warn"));
    const t = document.createElement("span");
    t.className = "text"; t.textContent = text;
    div.appendChild(t);
    if (action) {
      const b = document.createElement("button");
      b.className = "secondary"; b.textContent = action.label; b.onclick = action.run;
      div.appendChild(b);
    }
    messagesEl.appendChild(div);
    scroll();
  }

  // Text files ride along inside the prompt; images become image_url parts.
  function buildContent(typed) {
    const textFiles = attachments.filter((a) => a.kind === "text");
    const images = attachments.filter((a) => a.kind === "image");
    let text = typed;
    for (const f of textFiles) {
      text += (text ? "\n\n" : "") + "File `" + f.name + "`:\n```" + langOf(f.name) + "\n" + f.text + "\n```";
    }
    if (!text && images.length) text = "Look at the attached image" + (images.length > 1 ? "s" : "") + ".";
    const shown = { text: typed, images: images.map((i) => i.dataUrl), files: textFiles.map((f) => f.name) };
    if (!images.length) return { content: text, shown };
    const content = [{ type: "text", text }];
    for (const i of images) content.push({ type: "image_url", image_url: { url: i.dataUrl } });
    return { content, shown };
  }

  function send(text) {
    const typed = (text ?? inputEl.value).trim();
    if ((!typed && !attachments.length) || streaming) return;
    inputEl.value = ""; autosize();
    if (!sessionId) sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const { content, shown } = buildContent(typed);
    attachments = []; renderAttachments();
    history.push({ role: "user", content });
    addMessage("user", shown.text, shown);
    currentText = "";
    const a = addMessage("assistant", "");
    currentBody = a.body; currentWrap = a.wrap;
    currentWrap.classList.add("streaming");
    streaming = true;
    setSendState();
    agentRun = mode === "agent";
    vscode.postMessage({ type: agentRun ? "agentSend" : "send", messages: history, model: modelEl.value });
    scroll(true);
  }

  function setSendState() {
    sendBtn.innerHTML = "";
    sendBtn.classList.toggle("stop", streaming);
    sendBtn.title = streaming ? "Stop (Esc)" : "Send (Enter)";
    if (streaming) {
      const sq = document.createElement("span");
      sq.style.cssText = "width:10px;height:10px;background:currentColor;border-radius:2px;display:block";
      sendBtn.appendChild(sq);
    } else {
      sendBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
    }
  }

  // ---------- thinking / status line ----------
  let thinkingLabel = "", thinkingSince = 0, thinkingTimer = null, thinkingText = null, thinkingClock = null;
  function paintThinking() {
    if (!thinkingEl) return;
    const secs = Math.round((Date.now() - thinkingSince) / 1000);
    thinkingText.textContent = thinkingLabel;
    thinkingClock.textContent = secs + "s";
  }
  // restart = a new model call began, so the clock starts over.
  function setThinking(text, restart) {
    if (!text || !currentBody) {
      if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
      if (thinkingTimer) { clearInterval(thinkingTimer); thinkingTimer = null; }
      return;
    }
    if (!thinkingEl) {
      thinkingEl = document.createElement("div");
      thinkingEl.className = "thinking";
      const sp = document.createElement("span"); sp.className = "spinner";
      thinkingText = document.createElement("span");
      thinkingClock = document.createElement("span"); thinkingClock.className = "clock";
      thinkingEl.appendChild(sp); thinkingEl.appendChild(thinkingText); thinkingEl.appendChild(thinkingClock);
      thinkingSince = Date.now();
      thinkingTimer = setInterval(paintThinking, 1000);
    }
    if (restart) thinkingSince = Date.now();
    thinkingLabel = text;
    currentBody.appendChild(thinkingEl); // keep it below the newest content
    paintThinking();
    scroll();
  }

  // ---------- tool cards ----------
  const STATUS_TEXT = { pending: "needs approval", running: "running", done: "done", error: "failed", denied: "denied" };

  function addToolCard(card) {
    if (!currentBody) return;
    const el = document.createElement("div");
    const head = document.createElement("div");
    head.className = "thead";
    const ic = document.createElement("span");
    ic.className = "ticon";
    ic.appendChild(svg(TOOL_ICON[card.name] || "cpu"));
    const title = document.createElement("span");
    title.className = "ttitle";
    title.textContent = card.title;
    const status = document.createElement("span");
    status.className = "badge";
    head.appendChild(ic); head.appendChild(title); head.appendChild(status);
    el.appendChild(head);

    if (card.detail) {
      const pre = document.createElement("pre");
      pre.textContent = card.detail;
      el.appendChild(pre);
    }
    if (card.diff) {
      const pre = document.createElement("pre");
      const addLines = (text, cls, sign) => {
        if (!text) return;
        for (const line of text.split("\n")) {
          const span = document.createElement("span");
          span.className = cls;
          span.textContent = sign + " " + line;
          pre.appendChild(span);
        }
      };
      addLines(card.diff.removed, "del", "-");
      addLines(card.diff.added, "add", "+");
      el.appendChild(pre);
    }

    const parts = { el, status, actions: null, out: null };
    if (card.alwaysLabel) {
      const actions = document.createElement("div");
      actions.className = "tactions";
      const ask = document.createElement("div");
      ask.className = "ask";
      ask.textContent = card.name === "run_command"
        ? "Allow the agent to run this command?"
        : "Allow the agent to make this change?";
      const btns = document.createElement("div");
      btns.className = "btns";
      const feedback = document.createElement("input");
      feedback.placeholder = "Optional: tell the agent what to do instead, then press No";
      const answer = (decision) => vscode.postMessage({
        type: "approval", id: card.id, decision,
        feedback: decision === "deny" ? feedback.value.trim() : "",
      });
      const mk = (label, decision, cls) => {
        const b = document.createElement("button");
        b.className = cls;
        b.textContent = label;
        b.onclick = () => answer(decision);
        btns.appendChild(b);
        return b;
      };
      mk("Allow", "allow", "");
      mk("Deny", "deny", "secondary");
      if (card.canOpenDiff) {
        const d = document.createElement("button");
        d.className = "ghost";
        d.appendChild(svg("diff"));
        d.appendChild(document.createTextNode("Open diff"));
        d.onclick = () => vscode.postMessage({ type: "openDiff", id: card.id });
        btns.appendChild(d);
      }
      mk(card.alwaysLabel, "always", "secondary always");
      feedback.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); answer("deny"); }
      });
      actions.appendChild(ask); actions.appendChild(btns); actions.appendChild(feedback);
      el.appendChild(actions);
      parts.actions = actions;
    }
    toolEls[card.id] = parts;
    currentBody.appendChild(el);
    setToolStatus(card.id, card.status);
    scroll();
  }

  function setToolStatus(id, status, output) {
    const t = toolEls[id];
    if (!t) return;
    t.el.className = "tool " + status;
    t.status.textContent = "";
    if (status === "running") { const sp = document.createElement("span"); sp.className = "spinner"; t.status.appendChild(sp); }
    t.status.appendChild(document.createTextNode(STATUS_TEXT[status] || status));
    if (status !== "pending" && t.actions) { t.actions.remove(); t.actions = null; }
    if (output) {
      if (t.out) t.out.remove();
      // Short results read fine as a single line; longer ones fold away.
      if (output.length <= 60 && !output.includes("\n")) {
        t.out = document.createElement("div");
        t.out.className = "tline";
        t.out.textContent = output;
      } else {
        t.out = document.createElement("details");
        const summary = document.createElement("summary");
        summary.textContent = "Output";
        const pre = document.createElement("pre");
        pre.textContent = output;
        t.out.appendChild(summary); t.out.appendChild(pre);
        t.out.open = status === "error" || status === "denied";
      }
      t.el.appendChild(t.out);
    }
    scroll();
  }

  function finishStream(meta) {
    if (!streaming) return;
    setThinking(null);
    liveTurn = null;
    // A stopped run can leave cards mid-approval; they are no longer live.
    for (const id in toolEls) if (toolEls[id].actions) setToolStatus(id, "denied", "Stopped");
    history.push({ role: "assistant", content: currentText || (agentRun ? "(no text reply)" : "") });
    agentRun = false;
    streaming = false;
    setSendState();
    if (currentWrap) {
      currentWrap.classList.remove("streaming");
      currentWrap.raw = currentText;
      if (meta) {
        const m = document.createElement("div");
        m.className = "meta";
        if (meta.stopped) { m.textContent = "stopped"; }
        else {
          if (meta.model) { m.appendChild(svg("cpu")); m.appendChild(document.createTextNode(meta.model)); }
          if (meta.tokens) { m.appendChild(svg("token")); m.appendChild(document.createTextNode(meta.tokens.toLocaleString() + " tokens")); }
        }
        currentWrap.appendChild(m);
        if (meta.model) servedEl.textContent = meta.model + (meta.tokens ? " · " + meta.tokens.toLocaleString() + " tok" : "");
      }
    }
    currentBody = null; currentWrap = null;
    vscode.postMessage({ type: "saveSession", id: sessionId, messages: history });
    inputEl.focus();
  }

  function resetChat() {
    // Leaving mid-stream: stop it and keep the partial reply in its session.
    if (streaming) { vscode.postMessage({ type: "stop" }); finishStream({ stopped: true }); }
    history = []; sessionId = null;
    attachments = []; renderAttachments();
    for (const k in toolEls) delete toolEls[k];
    vscode.postMessage({ type: "chatReset" });
    messagesEl.innerHTML = ""; messagesEl.appendChild(emptyEl);
    setHistoryVisible(false);
    scroll(true);
    inputEl.focus();
  }

  // ---------- history ----------
  function setHistoryVisible(on) {
    document.body.classList.toggle("showHistory", on);
    historyBtn.classList.toggle("on", on);
    historyBtn.title = on ? "Back to chat" : "Chat history";
    if (on) { vscode.postMessage({ type: "listSessions" }); hsearch.value = ""; setTimeout(() => hsearch.focus(), 0); }
  }
  function relTime(ts) {
    const d = Date.now() - ts, m = Math.round(d / 60000), h = Math.round(d / 3600000), day = Math.round(d / 86400000);
    if (m < 1) return "just now";
    if (m < 60) return m + " min ago";
    if (h < 24) return h + " h ago";
    if (day < 7) return day + " d ago";
    return new Date(ts).toLocaleDateString();
  }
  function groupOf(ts) {
    const now = new Date(), d = new Date(ts);
    const sameDay = (a, b) => a.toDateString() === b.toDateString();
    if (sameDay(d, now)) return "Today";
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (sameDay(d, y)) return "Yesterday";
    if (now - d < 7 * 86400000) return "This week";
    return "Older";
  }
  function renderSessions() {
    const q = hsearch.value.trim().toLowerCase();
    const list = allSessions.filter((s) => !q || s.title.toLowerCase().includes(q));
    sessionList.innerHTML = "";
    if (!list.length) {
      const e = document.createElement("div");
      e.className = "empty";
      e.textContent = q ? "No conversations match." : "No saved conversations yet.";
      sessionList.appendChild(e);
      return;
    }
    let group = null;
    for (const s of list) {
      const g = groupOf(s.updatedAt);
      if (g !== group) {
        group = g;
        const h = document.createElement("div"); h.className = "hgroup"; h.textContent = g;
        sessionList.appendChild(h);
      }
      const row = document.createElement("div");
      row.className = "session" + (s.id === sessionId ? " active" : "");
      const info = document.createElement("div");
      info.className = "info";
      const title = document.createElement("div");
      title.className = "title"; title.textContent = s.title; title.title = s.title;
      const sub = document.createElement("div");
      sub.className = "sub"; sub.textContent = relTime(s.updatedAt) + " · " + s.count + " messages";
      info.appendChild(title); info.appendChild(sub);
      const del = iconButton("trash", "Delete this conversation", () => {
        if (s.id === sessionId) { resetChat(); setHistoryVisible(true); }
        vscode.postMessage({ type: "deleteSession", id: s.id });
      });
      del.classList.add("del");
      row.onclick = () => vscode.postMessage({ type: "loadSession", id: s.id });
      row.appendChild(info); row.appendChild(del);
      sessionList.appendChild(row);
    }
  }
  hsearch.addEventListener("input", renderSessions);

  // ---------- attachments ----------
  const MAX_SIDE = 1568;                // longest edge sent to the model
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
  const MAX_TEXT_BYTES = 200 * 1024;
  let attachSeq = 0;

  function langOf(name) {
    const ext = (name.split(".").pop() || "").toLowerCase();
    return /^[a-z0-9]{1,8}$/.test(ext) ? ext : "";
  }

  function renderAttachments() {
    attachEl.innerHTML = "";
    attachEl.hidden = attachments.length === 0;
    for (const a of attachments) {
      const chip = document.createElement("div");
      chip.className = "att";
      if (a.kind === "image") {
        const img = document.createElement("img");
        img.src = a.dataUrl; img.alt = a.name;
        chip.appendChild(img);
      } else {
        const fi = document.createElement("span");
        fi.className = "fi"; fi.appendChild(svg("file"));
        chip.appendChild(fi);
      }
      const nm = document.createElement("span");
      nm.className = "nm"; nm.textContent = a.name; nm.title = a.name;
      chip.appendChild(nm);
      const rm = document.createElement("button");
      rm.className = "icon rm"; rm.title = "Remove"; rm.textContent = "×";
      rm.onclick = () => { attachments = attachments.filter((x) => x.id !== a.id); renderAttachments(); };
      chip.appendChild(rm);
      attachEl.appendChild(chip);
    }
  }

  function pushAttachment(a) {
    a.id = ++attachSeq;
    attachments.push(a);
    renderAttachments();
    inputEl.focus();
  }

  // Screenshots are scaled down client-side: models gain nothing above
  // ~1.5k px on the long edge, and the gateway caps images at 5 MB.
  function shrinkImage(dataUrl, mime) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
        const tooBig = dataUrl.length * 0.75 > MAX_IMAGE_BYTES;
        if (scale === 1 && !tooBig) return resolve({ dataUrl, mime });
        const c = document.createElement("canvas");
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        const outMime = mime === "image/png" && !tooBig ? "image/png" : "image/jpeg";
        resolve({ dataUrl: c.toDataURL(outMime, 0.9), mime: outMime });
      };
      img.onerror = () => resolve({ dataUrl, mime });
      img.src = dataUrl;
    });
  }

  async function addBrowserFile(file) {
    const name = file.name || (file.type.startsWith("image/") ? "screenshot.png" : "pasted.txt");
    if (file.type.startsWith("image/")) {
      const raw = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result); r.onerror = rej;
        r.readAsDataURL(file);
      });
      const { dataUrl, mime } = await shrinkImage(raw, file.type);
      if (dataUrl.length * 0.75 > MAX_IMAGE_BYTES) {
        addNotice(name + " is still over 5 MB after resizing and was skipped.");
        return;
      }
      pushAttachment({ kind: "image", name, mime, dataUrl });
    } else if (file.size <= MAX_TEXT_BYTES) {
      const text = await file.text();
      if (text.includes("\u0000")) {
        addNotice(name + " looks binary and was skipped. Only images and text files can be attached.");
        return;
      }
      pushAttachment({ kind: "text", name, text });
    } else {
      addNotice(name + " is larger than 200 KB and was skipped.");
    }
  }

  $("attachBtn").onclick = () => vscode.postMessage({ type: "pickFiles" });
  inputEl.addEventListener("paste", (e) => {
    const files = [...((e.clipboardData && e.clipboardData.files) || [])];
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) addBrowserFile(f);
  });
  for (const ev of ["dragenter", "dragover"]) {
    boxEl.addEventListener(ev, (e) => { e.preventDefault(); boxEl.classList.add("drag"); });
  }
  boxEl.addEventListener("dragleave", () => boxEl.classList.remove("drag"));
  boxEl.addEventListener("drop", (e) => {
    e.preventDefault();
    boxEl.classList.remove("drag");
    for (const f of [...((e.dataTransfer && e.dataTransfer.files) || [])]) addBrowserFile(f);
  });

  // ---------- composer ----------
  function autosize() {
    inputEl.style.height = "auto";
    inputEl.style.height = Math.min(180, inputEl.scrollHeight) + "px";
  }
  inputEl.addEventListener("input", autosize);
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
    if (e.key === "Escape" && streaming) vscode.postMessage({ type: "stop" });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && document.body.classList.contains("showHistory")) setHistoryVisible(false);
  });
  sendBtn.onclick = () => { if (streaming) vscode.postMessage({ type: "stop" }); else send(); };
  setSendState();

  $("newChat").onclick = resetChat;
  $("refresh").onclick = () => { setModelsLoading(); vscode.postMessage({ type: "refreshModels" }); };
  historyBtn.onclick = () => setHistoryVisible(!document.body.classList.contains("showHistory"));
  serverBtn.onclick = () => vscode.postMessage({ type: "selectServer" });
  $("keyBtn").onclick = () => vscode.postMessage({ type: "setKey" });
  $("settingsBtn").onclick = () => vscode.postMessage({ type: "openSettings" });
  for (const chip of document.querySelectorAll(".chip[data-cmd]")) {
    chip.onclick = () => vscode.postMessage({ type: "quickAction", command: chip.dataset.cmd });
  }

  function setModelsLoading() {
    modelWrap.classList.add("loading");
    connDot.className = "dot busy";
  }

  // ---------- host messages ----------
  let doneMeta = null;
  window.addEventListener("message", (e) => {
    const msg = e.data;
    switch (msg.type) {
      case "models": {
        const prev = modelEl.value;
        modelEl.innerHTML = "";
        for (const id of msg.models) {
          const o = document.createElement("option");
          o.value = id; o.textContent = id;
          modelEl.appendChild(o);
        }
        const want = [prev, msg.selected, "auto"].find((v) => v && [...modelEl.options].some((o) => o.value === v));
        if (want) modelEl.value = want;
        modelWrap.classList.remove("loading");
        connDot.className = "dot ok";
        connDot.title = msg.models.length + " models available";
        break;
      }
      case "files":
        for (const f of msg.files) {
          if (f.kind === "image") {
            shrinkImage(f.dataUrl, f.mime).then((r) =>
              pushAttachment({ kind: "image", name: f.name, mime: r.mime, dataUrl: r.dataUrl }));
          } else {
            pushAttachment({ kind: "text", name: f.name, text: f.text });
          }
        }
        break;
      case "server":
        serverBtn.textContent = msg.host;
        serverBtn.title = "Gateway: " + msg.url + "\nClick to switch server";
        servedEl.textContent = "";
        break;
      case "userMessage":
        setHistoryVisible(false);
        if (msg.autoSend) send(msg.text);
        else { inputEl.value = msg.text; autosize(); inputEl.focus(); }
        break;
      case "delta":
        if (currentBody) {
          currentText += msg.text;
          currentWrap.raw = currentText;
          renderMarkdown(currentBody, currentText);
          scroll();
        }
        break;
      case "agentStatus":
        setThinking(msg.text, true);
        break;
      case "agentLive":
        if (currentBody) {
          if (msg.text) {
            if (!liveTurn) {
              liveTurn = document.createElement("div");
              liveTurn.className = "turn";
              currentBody.appendChild(liveTurn);
            }
            renderMarkdown(liveTurn, msg.text);
          }
          setThinking(msg.status, false);
        }
        break;
      case "agentText":
        if (currentBody) {
          setThinking(null);
          // The streamed preview becomes the final text of this turn.
          const seg = liveTurn || document.createElement("div");
          liveTurn = null;
          if (msg.text) {
            seg.className = "turn";
            renderMarkdown(seg, msg.text);
            currentBody.appendChild(seg);
            currentText += (currentText ? "\n\n" : "") + msg.text;
            currentWrap.raw = currentText;
          } else {
            seg.remove();
          }
          scroll();
        }
        break;
      case "agentTool":
        setThinking(null);
        addToolCard(msg.card);
        break;
      case "agentToolUpdate":
        setToolStatus(msg.id, msg.status, msg.output);
        break;
      case "done":
        doneMeta = { model: msg.model, tokens: msg.tokens };
        break;
      case "streamEnd":
        finishStream(msg.stopped ? { stopped: true } : doneMeta);
        doneMeta = null;
        break;
      case "reset":
        resetChat();
        break;
      case "showHistory":
        setHistoryVisible(true);
        break;
      case "sessions":
        allSessions = msg.sessions;
        renderSessions();
        break;
      case "sessionLoaded": {
        resetChat();
        sessionId = msg.id;
        history = msg.messages;
        for (const m of history) {
          const parts = typeof m.content === "string" ? null : m.content;
          const text = parts ? parts.filter((p) => p.type === "text").map((p) => p.text).join("") : m.content;
          const images = parts ? parts.filter((p) => p.type === "image_url").map((p) => p.image_url.url) : [];
          const a = addMessage(m.role, m.role === "user" ? text : "", { images });
          if (m.role !== "user") { renderMarkdown(a.body, text); a.wrap.raw = text; }
        }
        scroll(true);
        break;
      }
      case "needKey":
        finishStream(null);
        connDot.className = "dot err";
        addNotice("No API key set for this gateway.", { label: "Set API key", run: () => vscode.postMessage({ type: "setKey" }) });
        break;
      case "error":
        finishStream(null);
        if (msg.selectServer) {
          modelWrap.classList.remove("loading");
          connDot.className = "dot err";
          connDot.title = "Gateway unreachable";
        }
        addNotice(msg.message, msg.selectServer
          ? { label: "Change server", run: () => vscode.postMessage({ type: "selectServer" }) }
          : null);
        break;
    }
  });

  setModelsLoading();
  vscode.postMessage({ type: "ready" });
})();
