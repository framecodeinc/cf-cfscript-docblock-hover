import * as vscode from 'vscode';

interface DocInfo {
  description: string;
  params: Record<string, string>;
  returns: string;
  extra: Record<string, string>;
}

interface ArgInfo {
  text: string;
  name: string;
}

interface FuncInfo {
  name: string;
  signature: string;
  args: ArgInfo[];
  doc: DocInfo;
  hasDoc: boolean;
}

interface IndexEntry {
  uri: vscode.Uri;
  funcs: FuncInfo[];
}

// Docblock opcional + modificadores + tipo de retorno opcional + function nombre(args)
const FUNC_RE = new RegExp(
  '^[ \\t]*(?:(\\/\\*\\*(?:(?!\\*\\/)[\\s\\S])*\\*\\/)\\s*)?' + // /** ... */ (sin cruzar otros comentarios)
  '((?:(?:public|private|package|remote|static|final|abstract)\\s+)*)' +
  '(?:([\\w.]+)\\s+)?' + // tipo de retorno
  'function\\s+(\\w+)\\s*\\(([^)]*)\\)',
  'gim'
);

function splitArgs(str: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (const ch of str) {
    if (quote) {
      cur += ch;
      if (ch === quote) { quote = null; }
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if ('([{'.includes(ch)) { depth++; }
    if (')]}'.includes(ch)) { depth--; }
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) { out.push(cur.trim()); }
  return out;
}

function parseDoc(raw: string | undefined): DocInfo {
  const result: DocInfo = { description: '', params: {}, returns: '', extra: {} };
  if (!raw) { return result; }

  const lines = raw
    .replace(/^\/\*\*/, '')
    .replace(/\*\/$/, '')
    .split(/\r?\n/)
    .map(l => l.replace(/^\s*\*\s?/, '').trimEnd());

  const desc: string[] = [];
  let append: (t: string) => void = t => { desc.push(t); };

  for (const line of lines) {
    const m = line.match(/^\s*@(\w+)\s*(.*)$/);
    if (!m) { append(line); continue; }

    const tag = m[1].toLowerCase();
    const rest = m[2];

    if (tag === 'param') {
      const pm = rest.match(/^(?:\{[^}]*\}\s*)?(\w+)\s*[-–—]?\s*(.*)$/);
      if (pm) {
        const key = pm[1].toLowerCase();
        result.params[key] = pm[2];
        append = t => { result.params[key] += ' ' + t; };
      }
    } else if (tag === 'return' || tag === 'returns') {
      result.returns = rest;
      append = t => { result.returns += ' ' + t; };
    } else if (tag === 'hint' || tag === 'description') {
      desc.push(rest);
      append = t => { desc.push(t); };
    } else {
      // Estilo ColdFusion: "@nombreParametro descripción"
      result.extra[tag] = rest;
      append = t => { result.extra[tag] += ' ' + t; };
    }
  }

  result.returns = result.returns.trim();
  for (const k of Object.keys(result.params)) {
    result.params[k] = result.params[k].trim();
  }
  result.description = desc.join('\n').trim();
  return result;
}

export function parseFunctions(text: string): FuncInfo[] {
  const funcs: FuncInfo[] = [];
  FUNC_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FUNC_RE.exec(text))) {
    const [, rawDoc, modifiers, returnType, name, rawArgs] = m;
    const args: ArgInfo[] = splitArgs(rawArgs).map(a => {
      const words = a.split('=')[0].trim().split(/\s+/);
      return { text: a, name: words[words.length - 1] };
    });
    const doc = parseDoc(rawDoc);

    // Parámetros documentados al estilo "@nombre descripción"
    for (const a of args) {
      const k = a.name.toLowerCase();
      if (!doc.params[k] && doc.extra[k]) { doc.params[k] = doc.extra[k].trim(); }
    }

    const mods = (modifiers || '').trim();
    funcs.push({
      name,
      signature: `${mods} ${returnType ? returnType + ' ' : ''}function ${name}(${args.map(a => a.text).join(', ')})`.trim(),
      args,
      doc,
      hasDoc: !!rawDoc
    });
  }
  return funcs;
}

function toMarkdown(fn: FuncInfo, fileLabel?: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendCodeblock(fn.signature, 'cfml');
  if (fn.doc.description) { md.appendMarkdown('\n' + fn.doc.description + '\n'); }
  for (const a of fn.args) {
    const d = fn.doc.params[a.name.toLowerCase()];
    if (d) { md.appendMarkdown(`\n*@param* \`${a.name}\` — ${d}\n`); }
  }
  if (fn.doc.returns) { md.appendMarkdown(`\n*@returns* — ${fn.doc.returns}\n`); }
  if (fileLabel) { md.appendMarkdown(`\n---\n*${fileLabel}*`); }
  return md;
}

// ---- Índice de CFCs del workspace ----
const index = new Map<string, IndexEntry>();
let indexReady: Promise<unknown> | undefined;

async function indexFile(uri: vscode.Uri): Promise<void> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    index.set(uri.toString(), {
      uri,
      funcs: parseFunctions(Buffer.from(bytes).toString('utf8'))
    });
  } catch {
    index.delete(uri.toString());
  }
}

function ensureIndex(): Promise<unknown> {
  indexReady ??= Promise.resolve(
    vscode.workspace.findFiles('**/*.cfc', '**/node_modules/**')
  ).then((uris: vscode.Uri[]) => Promise.all(uris.map(indexFile)));
  return indexReady;
}

export function activate(context: vscode.ExtensionContext): void {
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.cfc');
  watcher.onDidChange(indexFile);
  watcher.onDidCreate(indexFile);
  watcher.onDidDelete(uri => index.delete(uri.toString()));
  context.subscriptions.push(watcher);

  const selector: vscode.DocumentSelector = [
    { language: 'cfml' },
    { pattern: '**/*.{cfc,cfm,cfml}' }
  ];

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(selector, {
      async provideHover(document, position) {
        const range = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
        if (!range) { return undefined; }
        const word = document.getText(range).toLowerCase();

        // Solo si es llamada o declaración: nombre seguido de "("
        const after = document.lineAt(position.line).text.slice(range.end.character);
        if (!/^\s*\(/.test(after)) { return undefined; }

        // 1) Función del propio documento (cfc o <cfscript> dentro de cfm)
        const local = parseFunctions(document.getText())
          .filter(f => f.name.toLowerCase() === word);
        if (local.length) {
          return new vscode.Hover(local.map(f => toMarkdown(f)), range);
        }

        // 2) Métodos de otros CFC del workspace
        await ensureIndex();
        const found: vscode.MarkdownString[] = [];
        for (const { uri, funcs } of index.values()) {
          for (const f of funcs) {
            if (f.name.toLowerCase() === word && f.hasDoc) {
              found.push(toMarkdown(f, vscode.workspace.asRelativePath(uri)));
            }
          }
        }
        return found.length ? new vscode.Hover(found.slice(0, 5), range) : undefined;
      }
    })
  );
}

export function deactivate(): void {}
