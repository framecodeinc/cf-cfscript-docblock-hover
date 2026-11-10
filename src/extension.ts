import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------
interface DocInfo {
  description: string;
  params: Record<string, string>;
  returns: string;
  extra: Record<string, string>;
}

interface ArgInfo {
  text: string;
  name: string;
  type: string;
  required: boolean;
  defaultValue?: string;
}

interface FuncInfo {
  name: string;
  modifiers: string;
  returnType: string;
  args: ArgInfo[];
  doc: DocInfo;
  hasDoc: boolean;
  start: number; // offset de la palabra "function"
  end: number;   // offset del "}" de cierre (o del ")" si no hay cuerpo)
}

interface VarInfo {
  scope: string; // variables | this | application | session | request | server | local
  name: string;
  kind: 'assignment' | 'property' | 'var';
  value?: string;
  type?: string;
  doc: string;
  offset: number; // offset del inicio de la línea
  bare?: boolean; // asignación sin ámbito: <cfset page = ...> / page = ...;
}

interface ComponentInfo {
  extends?: string;
  implements?: string;
  description: string;
}

interface IndexEntry {
  uri: vscode.Uri;
  funcs: FuncInfo[];
  vars: VarInfo[];
  component?: ComponentInfo;
}

// Ámbitos que pueden compartirse entre archivos / estar fuera de funciones
const SHARED_SCOPES = ['variables', 'this', 'application', 'session', 'request', 'server'];
// Ámbitos en los que se detectan asignaciones: x.nombre = valor
const ASSIGN_SCOPES = [...SHARED_SCOPES, 'local'];
// Ámbitos sobre los que se muestra hover: x.nombre
const HOVER_SCOPES = [...ASSIGN_SCOPES, 'arguments'];

// ---------------------------------------------------------------------------
// Funciones: docblock + firma
// ---------------------------------------------------------------------------
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

function parseArg(text: string): ArgInfo {
  const eq = text.indexOf('=');
  const left = (eq >= 0 ? text.slice(0, eq) : text).trim();
  const defaultValue = eq >= 0 ? text.slice(eq + 1).trim() : undefined;
  const words = left.split(/\s+/);
  const name = words[words.length - 1];
  const rest = words.slice(0, -1);
  const required = rest.some(w => w.toLowerCase() === 'required');
  const type = rest.find(w => w.toLowerCase() !== 'required') || 'any';
  return { text, name, type, required, defaultValue };
}

function parseDoc(raw: string | undefined): DocInfo {
  const result: DocInfo = { description: '', params: {}, returns: '', extra: {} };
  if (!raw) { return result; }

  const lines = raw
    .replace(/^\/\*+/, '')
    .replace(/\*+\/$/, '')
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

/** Devuelve el offset del "}" que cierra la "{" de `open`, ignorando strings y comentarios. */
function findBodyEnd(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '/' && next === '/') {
      const nl = text.indexOf('\n', i);
      if (nl < 0) { return -1; }
      i = nl;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end < 0) { return -1; }
      i = end + 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) { j++; }
      i = j;
      continue;
    }
    if (ch === '{') { depth++; }
    else if (ch === '}') {
      depth--;
      if (depth === 0) { return i; }
    }
  }
  return -1;
}

export function parseFunctions(text: string): FuncInfo[] {
  const funcs: FuncInfo[] = [];
  FUNC_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FUNC_RE.exec(text))) {
    const [full, rawDoc, modifiers, returnType, name, rawArgs] = m;
    const args = splitArgs(rawArgs).map(parseArg);
    const doc = parseDoc(rawDoc);

    // Parámetros documentados al estilo "@nombre descripción"
    for (const a of args) {
      const k = a.name.toLowerCase();
      if (!doc.params[k] && doc.extra[k]) { doc.params[k] = doc.extra[k].trim(); }
    }

    // Rango de la función (para resolver arguments., local. y var)
    const afterDoc = rawDoc ? full.indexOf(rawDoc) + rawDoc.length : 0;
    const kw = full.slice(afterDoc).search(/\bfunction\s/i);
    const start = m.index + afterDoc + Math.max(kw, 0);
    const declEnd = m.index + full.length;
    const bm = /^[^{};]*\{/.exec(text.slice(declEnd, declEnd + 400));
    const bodyStart = bm ? declEnd + bm[0].length - 1 : -1;
    const bodyEnd = bodyStart >= 0 ? findBodyEnd(text, bodyStart) : -1;

    funcs.push({
      name,
      modifiers: (modifiers || '').trim().replace(/\s+/g, ' '),
      returnType: returnType || 'any',
      args,
      doc,
      hasDoc: !!rawDoc,
      start,
      end: bodyEnd >= 0 ? bodyEnd : declEnd
    });
  }
  return [...funcs, ...parseTagFunctions(text)];
}

// --- Funciones definidas con tags: <cffunction> + <cfargument> ---
const TAG_FUNC_RE = /(?:<!---((?:(?!--->)[\s\S])*)--->\s*)?<cffunction\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/gi;
const TAG_ARG_RE = /<cfargument\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/gi;

/** Limpia el texto de un comentario CFML <!--- ... ---> */
function cleanCfComment(s: string | undefined): string {
  return (s || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).join('\n').trim();
}

/** Valor de atributo como literal: números y booleanos tal cual, el resto entre comillas. */
function quoteAttr(v: string): string {
  return /^-?[\d.]+$|^(true|false|yes|no)$/i.test(v) ? v : `"${v}"`;
}

function parseTagFunctions(text: string): FuncInfo[] {
  const funcs: FuncInfo[] = [];
  const lower = text.toLowerCase();
  const re = new RegExp(TAG_FUNC_RE.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const attrs = parseAttrs(m[2]);
    if (!attrs['name']) { continue; }

    const start = m.index + m[0].toLowerCase().lastIndexOf('<cffunction');
    const declEnd = m.index + m[0].length;
    const close = lower.indexOf('</cffunction>', declEnd);
    const bodyText = text.slice(declEnd, close >= 0 ? close : declEnd);

    const params: Record<string, string> = {};
    const args: ArgInfo[] = [];
    const ar = new RegExp(TAG_ARG_RE.source, 'gi');
    let am: RegExpExecArray | null;
    while ((am = ar.exec(bodyText))) {
      const a = parseAttrs(am[1]);
      if (!a['name']) { continue; }
      const type = a['type'] || 'any';
      const required = /^(true|yes)$/i.test(a['required'] || '');
      const defaultValue = a['default'] !== undefined ? quoteAttr(a['default']) : undefined;
      args.push({
        text: `${required ? 'required ' : ''}${type} ${a['name']}${defaultValue !== undefined ? ' = ' + defaultValue : ''}`,
        name: a['name'], type, required, defaultValue
      });
      const h = a['hint'] || a['description'];
      if (h) { params[a['name'].toLowerCase()] = h; }
    }

    const description = [cleanCfComment(m[1]), attrs['hint'], attrs['description']]
      .filter(Boolean).join('\n').trim();
    funcs.push({
      name: attrs['name'],
      modifiers: attrs['access'] || '',
      returnType: attrs['returntype'] || 'any',
      args,
      doc: { description, params, returns: '', extra: {} },
      hasDoc: !!(description || Object.keys(params).length),
      start,
      end: close >= 0 ? close + '</cffunction>'.length : declEnd
    });
  }
  return funcs;
}

/** Función más interna que contiene el offset. */
function enclosingFunction(funcs: FuncInfo[], offset: number): FuncInfo | undefined {
  let best: FuncInfo | undefined;
  for (const f of funcs) {
    if (f.start <= offset && offset <= f.end && (!best || f.start > best.start)) { best = f; }
  }
  return best;
}

function formatArg(a: ArgInfo): string {
  const optional = !a.required && a.defaultValue === undefined;
  const def = a.defaultValue !== undefined ? ` = ${a.defaultValue}` : '';
  return `${a.name}${optional ? '?' : ''}: ${a.type}${def}`;
}

/** Firma al estilo TypeScript: function getUser(id: numeric, opts?: struct): struct */
export function formatSignature(fn: FuncInfo): string {
  return `function ${fn.name}(${fn.args.map(formatArg).join(', ')}): ${fn.returnType}`;
}

// ---------------------------------------------------------------------------
// Variables: variables.x / this.x / application.x / local.x / var x / property
// ---------------------------------------------------------------------------
const ASSIGN_RE = new RegExp(`^\\s*(${ASSIGN_SCOPES.join('|')})\\.(\\w+)\\s*=(?!=)\\s*(.*)$`, 'i');
const VAR_RE = /^\s*var\s+(?:([\w.]+)\s+)?(\w+)\s*(?=[=;]|\/\/|$)(.*)$/i;
const FOR_VAR_RE = /^\s*for\s*\(\s*var\s+(?:([\w.]+)\s+)?(\w+)\s*(?=[=;]|\bin\b)/i;
const PROPERTY_RE = /^\s*property\s+([^;]*);?/i;

/** Separa un comentario // final que no esté dentro de comillas. */
function splitTrailingComment(s: string): { code: string; comment: string } {
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) { quote = null; }
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === '/' && s[i + 1] === '/') {
      return { code: s.slice(0, i), comment: s.slice(i).replace(/^\/\/+\s?/, '').trim() };
    }
  }
  return { code: s, comment: '' };
}

function parseProperty(body: string): { name: string; type?: string; value?: string; hint?: string } | undefined {
  const attrs: Record<string, string> = {};
  const rest = body.replace(
    /(\w+)\s*=\s*("([^"]*)"|'([^']*)'|[^\s;]+)/g,
    (_m: string, key: string, raw: string, dq?: string, sq?: string) => {
      attrs[key.toLowerCase()] = dq ?? sq ?? raw;
      return ' ';
    }
  );
  const tokens = rest.trim().split(/\s+/).filter(Boolean);
  const name = attrs['name'] || tokens[tokens.length - 1];
  if (!name) { return undefined; }
  const type = attrs['type'] || (!attrs['name'] && tokens.length > 1 ? tokens[tokens.length - 2] : undefined);
  return { name, type, value: attrs['default'] !== undefined ? quoteAttr(attrs['default']) : undefined, hint: attrs['hint'] };
}

export function parseVariables(text: string): VarInfo[] {
  const vars: VarInfo[] = [];
  const rawLines = text.split('\n');
  const offsets: number[] = [];
  let acc = 0;
  for (const l of rawLines) { offsets.push(acc); acc += l.length + 1; }
  const lines = rawLines.map(l => l.replace(/\r$/, ''));
  let buffer: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();

    if (!t) { buffer = []; continue; }

    // Comentario de bloque (/** ... */ o /* ... */), posiblemente de varias líneas
    if (t.startsWith('/*')) {
      let chunk = t;
      let j = i;
      while (!chunk.includes('*/') && j + 1 < lines.length) {
        j++;
        chunk += '\n' + lines[j];
      }
      const d = parseDoc(chunk).description;
      buffer = d ? [d] : [];
      i = j;
      continue;
    }

    // Comentarios de línea consecutivos
    if (t.startsWith('//')) {
      buffer.push(t.replace(/^\/\/+\s?/, ''));
      continue;
    }

    // Comentario CFML: <!--- ... --->
    if (t.startsWith('<!---')) {
      let chunk = t;
      let j = i;
      while (!chunk.includes('--->') && j + 1 < lines.length) {
        j++;
        chunk += '\n' + lines[j];
      }
      const d = cleanCfComment(chunk.replace(/^<!-+/, '').replace(/-+>\s*$/, ''));
      buffer = d ? [d] : [];
      i = j;
      continue;
    }

    // <cfset var x = valor> / <cfset this.x = valor> / <cfset local.x = valor>
    const tm = line.match(/^\s*<cfset\s+(.*?)\s*\/?>\s*(?:<!---\s*(.*?)\s*--->)?\s*$/i);
    if (tm) {
      const inner = tm[1];
      const trailing = tm[2] || '';
      const docText = [buffer.join('\n'), trailing].filter(Boolean).join('\n').trim();
      const tv = inner.match(/^var\s+(?:([\w.]+)\s+)?(\w+)\s*(?:=(?!=)\s*(.*))?$/i);
      const ta = inner.match(new RegExp(`^(${ASSIGN_SCOPES.join('|')})\\.(\\w+)\\s*=(?!=)\\s*(.*)$`, 'i'));
      if (tv) {
        vars.push({
          scope: 'local', name: tv[2], kind: 'var', type: tv[1],
          value: (tv[3] || '').trim() || undefined, doc: docText, offset: offsets[i]
        });
      } else if (ta) {
        vars.push({
          scope: ta[1].toLowerCase(), name: ta[2], kind: 'assignment',
          value: ta[3].trim(), doc: docText, offset: offsets[i]
        });
      } else {
        const tb = inner.match(/^(\w+)\s*=(?!=)\s*(.*)$/);
        if (tb) {
          vars.push({
            scope: 'variables', name: tb[1], kind: 'assignment', bare: true,
            value: tb[2].trim(), doc: docText, offset: offsets[i]
          });
        }
      }
      buffer = [];
      continue;
    }

    // <cfproperty name="x" type="string" default="..." hint="...">
    const tpr = line.match(/^\s*<cfproperty\b(.*?)\/?>/i);
    if (tpr) {
      const a = parseAttrs(tpr[1]);
      if (a['name']) {
        vars.push({
          scope: 'variables', name: a['name'], kind: 'property', type: a['type'],
          value: a['default'] !== undefined ? quoteAttr(a['default']) : undefined,
          doc: [buffer.join('\n'), a['hint']].filter(Boolean).join('\n').trim(),
          offset: offsets[i]
        });
      }
      buffer = [];
      continue;
    }

    // <cfparam name="variables.x" default="valor" type="numeric">
    const tpa = line.match(/^\s*<cfparam\b(.*?)\/?>/i);
    if (tpa) {
      const a = parseAttrs(tpa[1]);
      const full = a['name'] || '';
      const dot = full.indexOf('.');
      const scoped = dot > 0 && ASSIGN_SCOPES.includes(full.slice(0, dot).toLowerCase());
      if (full && (scoped || dot < 0)) {
        vars.push({
          scope: scoped ? full.slice(0, dot).toLowerCase() : 'variables',
          name: scoped ? full.slice(dot + 1) : full,
          kind: 'assignment', type: a['type'],
          value: a['default'] !== undefined ? quoteAttr(a['default']) : undefined,
          doc: [buffer.join('\n'), a['hint']].filter(Boolean).join('\n').trim(),
          offset: offsets[i]
        });
      }
      buffer = [];
      continue;
    }

    // for (var i = 0; ...) / for (var k in struct)
    const fm = line.match(FOR_VAR_RE);
    if (fm) {
      const vm = line.slice(fm[0].length).match(/^=(?!=)\s*([^;]*)/);
      vars.push({
        scope: 'local', name: fm[2], kind: 'var', type: fm[1],
        value: vm ? vm[1].trim() : undefined, doc: '', offset: offsets[i]
      });
      buffer = [];
      continue;
    }

    // var x = valor; / var string x = valor; / var x;
    const vm = line.match(VAR_RE);
    if (vm) {
      const { code, comment } = splitTrailingComment(vm[3]);
      const value = code.replace(/^\s*=\s*/, '').replace(/;\s*$/, '').trim();
      vars.push({
        scope: 'local', name: vm[2], kind: 'var', type: vm[1],
        value: value || undefined,
        doc: [buffer.join('\n'), comment].filter(Boolean).join('\n').trim(),
        offset: offsets[i]
      });
      buffer = [];
      continue;
    }

    // this.x = valor; variables.x = valor; application.x = valor; local.x = valor ...
    const am = line.match(ASSIGN_RE);
    if (am) {
      const { code, comment } = splitTrailingComment(am[3]);
      vars.push({
        scope: am[1].toLowerCase(),
        name: am[2],
        kind: 'assignment',
        value: code.trim().replace(/;\s*$/, ''),
        doc: [buffer.join('\n'), comment].filter(Boolean).join('\n').trim(),
        offset: offsets[i]
      });
      buffer = [];
      continue;
    }

    // page = valor;  (sin ámbito; debe terminar en ; para no confundirlo con structs de varias líneas)
    const bm = line.match(/^\s*(\w+)\s*=(?!=)\s*(.*?)\s*;\s*(?:\/\/\s*(.*))?$/);
    if (bm) {
      vars.push({
        scope: 'variables', name: bm[1], kind: 'assignment', bare: true,
        value: bm[2],
        doc: [buffer.join('\n'), bm[3] || ''].filter(Boolean).join('\n').trim(),
        offset: offsets[i]
      });
      buffer = [];
      continue;
    }

    // property name="x" type="string" hint="...";  /  property string x;
    const pm = line.match(PROPERTY_RE);
    if (pm) {
      const p = parseProperty(pm[1]);
      if (p) {
        vars.push({
          scope: 'variables',
          name: p.name,
          kind: 'property',
          type: p.type,
          value: p.value,
          doc: [buffer.join('\n'), p.hint].filter(Boolean).join('\n').trim(),
          offset: offsets[i]
        });
      }
      buffer = [];
      continue;
    }

    buffer = [];
  }
  return vars;
}

function varMatches(v: VarInfo, scope: string, name: string): boolean {
  if (v.name.toLowerCase() !== name) { return false; }
  if (scope === 'local') { return v.kind === 'var' || v.scope === 'local'; }
  if (v.kind === 'var') { return false; }
  if (v.kind === 'property') { return scope === 'variables' || scope === 'this'; }
  return v.scope === scope;
}

function localVarsOf(vars: VarInfo[], fn: FuncInfo | undefined): VarInfo[] {
  if (!fn) { return []; }
  return vars.filter(v =>
    (v.kind === 'var' || v.scope === 'local') && v.offset >= fn.start && v.offset <= fn.end
  );
}

// ---------------------------------------------------------------------------
// Markdown del hover
// ---------------------------------------------------------------------------
function codeLanguage(): string {
  return vscode.workspace
    .getConfiguration('cfscriptDocblockHover')
    .get<string>('codeLanguage', 'cfscript-hover');
}

function toMarkdown(fn: FuncInfo, fileLabel?: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendCodeblock(formatSignature(fn), codeLanguage());
  if (fn.modifiers) { md.appendMarkdown(`*${fn.modifiers}*\n\n`); }
  if (fn.doc.description) { md.appendMarkdown(fn.doc.description + '\n'); }
  for (const a of fn.args) {
    const d = fn.doc.params[a.name.toLowerCase()];
    if (d) { md.appendMarkdown(`\n*@param* \`${a.name}\` — ${d}\n`); }
  }
  if (fn.doc.returns) { md.appendMarkdown(`\n*@returns* — ${fn.doc.returns}\n`); }
  if (fileLabel) { md.appendMarkdown(`\n---\n*${fileLabel}*`); }
  return md;
}

function toMarkdownParam(fn: FuncInfo, a: ArgInfo): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendCodeblock(`(parameter) ${formatArg(a)}`, codeLanguage());
  const d = fn.doc.params[a.name.toLowerCase()];
  if (d) { md.appendMarkdown(d + '\n'); }
  md.appendMarkdown(`\n*parameter of* \`${fn.name}\``);
  return md;
}

function toMarkdownVar(v: VarInfo, scope: string, fileLabel?: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  const val = v.value && v.value.length > 120 ? v.value.slice(0, 117) + '...' : v.value;
  let code: string;
  if (v.kind === 'property') {
    code = `${scope}.${v.name}: ${v.type || 'any'}${v.value !== undefined ? ` = ${v.value}` : ''}`;
  } else if (v.kind === 'var') {
    code = `var ${v.name}${v.type ? `: ${v.type}` : ''}${val ? ` = ${val}` : ''}`;
  } else if (v.bare) {
    code = `${v.name}${v.type ? `: ${v.type}` : ''}${val ? ` = ${val}` : ''}`;
  } else {
    code = `${scope}.${v.name}${v.type ? `: ${v.type}` : ''}${val ? ` = ${val}` : ''}`;
  }
  md.appendCodeblock(code, codeLanguage());
  if (v.kind === 'property') { md.appendMarkdown('*property*\n\n'); }
  if (v.doc) { md.appendMarkdown(v.doc + '\n'); }
  if (fileLabel) { md.appendMarkdown(`\n---\n*${fileLabel}*`); }
  return md;
}

// ---------------------------------------------------------------------------
// Componentes: docblock, extends, resolución y herencia
// ---------------------------------------------------------------------------
const COMPONENT_RE = new RegExp(
  '^[ \\t]*(?:(\\/\\*\\*(?:(?!\\*\\/)[\\s\\S])*\\*\\/)\\s*)?' + // /** ... */
  '(?:(?:abstract|final)\\s+)*component\\b([^{;]*)\\{',
  'im'
);
const CFCOMPONENT_RE = /(?:<!---((?:(?!--->)[\s\S])*)--->\s*)?<cfcomponent\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/i;

function parseAttrs(s: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  s.replace(
    /(\w+)\s*=\s*("([^"]*)"|'([^']*)'|[^\s;>]+)/g,
    (_m: string, key: string, raw: string, dq?: string, sq?: string) => {
      attrs[key.toLowerCase()] = dq ?? sq ?? raw;
      return '';
    }
  );
  return attrs;
}

export function parseComponent(text: string): ComponentInfo | undefined {
  const m = COMPONENT_RE.exec(text);
  if (m) {
    const attrs = parseAttrs(m[2] || '');
    const doc = parseDoc(m[1]).description;
    return {
      extends: attrs['extends'],
      implements: attrs['implements'],
      description: [doc, attrs['hint']].filter(Boolean).join('\n').trim()
    };
  }
  const t = CFCOMPONENT_RE.exec(text);
  if (t) {
    const attrs = parseAttrs(t[2]);
    return {
      extends: attrs['extends'],
      implements: attrs['implements'],
      description: [cleanCfComment(t[1]), attrs['hint']].filter(Boolean).join('\n').trim()
    };
  }
  return undefined;
}

function uriBase(u: vscode.Uri): string {
  const p = u.path;
  return p.slice(p.lastIndexOf('/') + 1).replace(/\.(cfc|cfm|cfml)$/i, '');
}

function uriDir(u: vscode.Uri): string {
  const p = u.path;
  return p.slice(0, p.lastIndexOf('/')).toLowerCase();
}

/** Busca componentes por nombre o ruta con puntos (app.models.Logger). Los mejores primero. */
function resolveComponents(ref: string, fromUri?: vscode.Uri, extra: IndexEntry[] = []): IndexEntry[] {
  const parts = ref.split('.').filter(Boolean);
  if (!parts.length) { return []; }
  const base = parts[parts.length - 1].toLowerCase();
  const suffix = '/' + parts.join('/').toLowerCase() + '.cfc';

  const seen = new Set<string>();
  const matches: IndexEntry[] = [];
  for (const e of [...extra, ...index.values()]) {
    const key = e.uri.toString();
    if (seen.has(key) || uriBase(e.uri).toLowerCase() !== base) { continue; }
    seen.add(key);
    matches.push(e);
  }

  const score = (e: IndexEntry): number =>
    (e.uri.path.toLowerCase().endsWith(suffix) ? 2 : 0) +
    (fromUri && uriDir(e.uri) === uriDir(fromUri) ? 1 : 0);

  matches.sort((a, b) => score(b) - score(a));
  // Si la ruta con puntos coincide exactamente, descarta el resto
  if (parts.length > 1 && matches.length && score(matches[0]) >= 2) {
    return matches.filter(e => score(e) >= 2);
  }
  return matches;
}

/** Componentes base (extends) del indicado, del más cercano al más lejano. */
export function inheritanceChain(entry: IndexEntry): IndexEntry[] {
  const chain: IndexEntry[] = [];
  const seen = new Set<string>([entry.uri.toString()]);
  let cur = entry;
  for (let i = 0; i < 10; i++) {
    const ext = cur.component?.extends;
    if (!ext) { break; }
    const base = resolveComponents(ext, cur.uri)[0];
    if (!base || seen.has(base.uri.toString())) { break; }
    seen.add(base.uri.toString());
    chain.push(base);
    cur = base;
  }
  return chain;
}

function toMarkdownComponent(e: IndexEntry, fileLabel?: string): vscode.MarkdownString {
  const name = uriBase(e.uri);
  const c = e.component;
  const md = new vscode.MarkdownString();
  md.appendCodeblock(`component ${name}${c?.extends ? ` extends ${c.extends}` : ''}`, codeLanguage());
  if (c?.description) { md.appendMarkdown(c.description + '\n'); }

  const init = [e, ...inheritanceChain(e)]
    .flatMap(x => x.funcs)
    .find(f => f.name.toLowerCase() === 'init');
  if (init) {
    md.appendCodeblock(`new ${name}(${init.args.map(formatArg).join(', ')})`, codeLanguage());
    for (const a of init.args) {
      const d = init.doc.params[a.name.toLowerCase()];
      if (d) { md.appendMarkdown(`\n*@param* \`${a.name}\` — ${d}\n`); }
    }
  }
  if (fileLabel) { md.appendMarkdown(`\n---\n*${fileLabel}*`); }
  return md;
}

// ---------------------------------------------------------------------------
// Índice de CFCs del workspace
// ---------------------------------------------------------------------------
export const index = new Map<string, IndexEntry>();
let indexReady: Promise<unknown> | undefined;

async function indexFile(uri: vscode.Uri): Promise<void> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(bytes).toString('utf8');
    index.set(uri.toString(), {
      uri,
      funcs: parseFunctions(text),
      vars: parseVariables(text),
      component: parseComponent(text)
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

// ---------------------------------------------------------------------------
// Activación
// ---------------------------------------------------------------------------
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
  const rel = (u: vscode.Uri) => vscode.workspace.asRelativePath(u);
  const byDoc = (a: VarInfo, b: VarInfo) => Number(!!b.doc) - Number(!!a.doc);

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(selector, {
      async provideHover(document, position) {
        const lineText = document.lineAt(position.line).text;
        const text = document.getText();
        const funcs = parseFunctions(text);
        const vars = parseVariables(text);
        const current: IndexEntry = { uri: document.uri, funcs, vars, component: parseComponent(text) };

        // N) new MiComponente() / extends="app.models.Base"
        const wide = document.getWordRangeAtPosition(position, /[A-Za-z_][\w.]*/);
        if (wide) {
          const wBefore = lineText.slice(0, wide.start.character);
          if (/\bnew\s+$/i.test(wBefore) || /\bextends\s*=\s*["']\s*$/i.test(wBefore)) {
            await ensureIndex();
            const matches = resolveComponents(document.getText(wide), document.uri, [current]);
            if (matches.length) {
              return new vscode.Hover(
                matches.slice(0, 3).map(e => toMarkdownComponent(e, e.uri === document.uri ? undefined : rel(e.uri))),
                wide
              );
            }
          }
        }

        const range = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*/);
        if (!range) { return undefined; }
        const word = document.getText(range).toLowerCase();
        const isCall = /^\s*\(/.test(lineText.slice(range.end.character));
        const before = lineText.slice(0, range.start.character);
        const fn = enclosingFunction(funcs, document.offsetAt(position));

        // A) Variable con ámbito: arguments.x, local.x, variables.x, this.x, application.x ...
        const sm = before.match(new RegExp(`\\b(${HOVER_SCOPES.join('|')})\\.$`, 'i'));
        if (sm && !isCall) {
          const scope = sm[1].toLowerCase();

          if (scope === 'arguments') {
            const p = fn?.args.find(a => a.name.toLowerCase() === word);
            return fn && p ? new vscode.Hover(toMarkdownParam(fn, p), range) : undefined;
          }

          const pool = scope === 'local' ? localVarsOf(vars, fn) : vars;
          const local = pool.filter(v => varMatches(v, scope, word)).sort(byDoc);
          if (local.length) {
            return new vscode.Hover(local.slice(0, 3).map(v => toMarkdownVar(v, scope)), range);
          }

          // Campos heredados de los componentes base (extends)
          if (scope === 'variables' || scope === 'this') {
            await ensureIndex();
            for (const e of inheritanceChain(current)) {
              const hits = e.vars.filter(v => varMatches(v, scope, word)).sort(byDoc);
              if (hits.length) {
                return new vscode.Hover(hits.slice(0, 3).map(v => toMarkdownVar(v, scope, rel(e.uri))), range);
              }
            }
            return undefined;
          }

          // Ámbitos compartidos: se pueden definir en otro CFC (p. ej. Application.cfc)
          if (scope !== 'local') {
            await ensureIndex();
            const found: vscode.MarkdownString[] = [];
            for (const { uri, vars: vs } of index.values()) {
              for (const v of vs.filter(x => x.doc && varMatches(x, scope, word)).sort(byDoc)) {
                found.push(toMarkdownVar(v, scope, rel(uri)));
              }
            }
            if (found.length) { return new vscode.Hover(found.slice(0, 3), range); }
          }
          return undefined;
        }

        // C) Identificador suelto dentro de una función: parámetro o variable local (var / local.x)
        if (!isCall && fn && !before.endsWith('.')) {
          const p = fn.args.find(a => a.name.toLowerCase() === word);
          if (p) { return new vscode.Hover(toMarkdownParam(fn, p), range); }

          const lv = localVarsOf(vars, fn).filter(v => varMatches(v, 'local', word)).sort(byDoc);
          if (lv.length) {
            return new vscode.Hover(toMarkdownVar(lv[0], lv[0].scope), range);
          }
        }

        // D) Identificador suelto: variable del ámbito variables (<cfset page = ...>, page = ...;, property)
        if (!isCall && !before.endsWith('.')) {
          const own = vars
            .filter(v => v.kind !== 'var' && v.scope === 'variables' && v.name.toLowerCase() === word)
            .sort(byDoc);
          if (own.length) {
            return new vscode.Hover(own.slice(0, 3).map(v => toMarkdownVar(v, 'variables')), range);
          }
          await ensureIndex();
          for (const e of inheritanceChain(current)) {
            const hits = e.vars
              .filter(v => v.kind !== 'var' && v.scope === 'variables' && v.name.toLowerCase() === word)
              .sort(byDoc);
            if (hits.length) {
              return new vscode.Hover(hits.slice(0, 3).map(v => toMarkdownVar(v, 'variables', rel(e.uri))), range);
            }
          }
        }

        // B) Función: nombre seguido de "(" (llamada o declaración)
        if (!isCall) { return undefined; }

        const isSuper = /\bsuper\.$/i.test(before);
        const own = !before.endsWith('.') || isSuper || /\b(this|variables)\.$/i.test(before);

        if (!isSuper) {
          const localFns = funcs.filter(f => f.name.toLowerCase() === word);
          if (localFns.length) {
            return new vscode.Hover(localFns.map(f => toMarkdown(f)), range);
          }
        }

        await ensureIndex();

        // Métodos heredados de los componentes base
        if (own) {
          const inherited: vscode.MarkdownString[] = [];
          for (const e of inheritanceChain(current)) {
            for (const f of e.funcs) {
              if (f.name.toLowerCase() === word) { inherited.push(toMarkdown(f, rel(e.uri))); }
            }
            if (inherited.length) { break; }
          }
          if (inherited.length) { return new vscode.Hover(inherited.slice(0, 3), range); }
        }

        // Cualquier otro CFC del workspace con ese método documentado
        const found: vscode.MarkdownString[] = [];
        for (const { uri, funcs: fs } of index.values()) {
          for (const f of fs) {
            if (f.name.toLowerCase() === word && f.hasDoc) {
              found.push(toMarkdown(f, rel(uri)));
            }
          }
        }
        return found.length ? new vscode.Hover(found.slice(0, 5), range) : undefined;
      }
    })
  );
}

export function deactivate(): void {}