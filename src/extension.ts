import * as vscode from 'vscode';
import * as https from 'https';

/**
 * Represents documentation parsed from a function DocBlock.
 */
interface DocInfo {
  description: string;
  params: Record<string, string>;
  returns: string;
  extra: Record<string, string>;
}
/**
 * Describes a parsed function argument and its declaration metadata.
 */
interface ArgInfo {
  text: string;
  name: string;
  type: string;
  required: boolean;
  defaultValue?: string;
}
/**
 * Stores a parsed function signature, documentation, and source-code range.
 */
interface FuncInfo {
  name: string;
  modifiers: string;
  returnType: string;
  args: ArgInfo[];
  doc: DocInfo;
  hasDoc: boolean;
  start: number; // Offset of the "function" keyword
  end: number;   // Offset of the closing "}" (or ")" if there is no body)
}
/**
 * Stores a parsed variable or property declaration and its documentation.
 */
interface VarInfo {
  scope: string; // variables | this | application | session | request | server | local
  name: string;
  kind: 'assignment' | 'property' | 'var';
  value?: string;
  type?: string;
  doc: string;
  offset: number; // Offset of the beginning of the line
  bare?: boolean; // Unscoped assignment: <cfset page = ...> / page = ...;

}
/**
 * Contains component-level metadata such as inheritance and implemented interfaces.
 */
interface ComponentInfo {
  extends?: string;
  implements?: string;
  description: string;
}
/**
 * Represents the parsed metadata indexed for a single CFC document.
 */
interface IndexEntry {
  uri: vscode.Uri;
  funcs: FuncInfo[];
  vars: VarInfo[];
  component?: ComponentInfo;
}

/**
 * Scopes that can be shared across files or exist outside functions
 */
const SHARED_SCOPES = ['variables', 'this', 'application', 'session', 'request', 'server'];
/**
 * Scopes in which assignments are detected: x.name = value
 */
const ASSIGN_SCOPES = [...SHARED_SCOPES, 'local', 'url', 'form', 'cookie', 'client'];
/**
 * Scopes for which hover documentation is displayed: x.name
 */
const HOVER_SCOPES = [...ASSIGN_SCOPES, 'arguments', 'cgi'];

// ---------------------------------------------------------------------------
/**
 * Functions: docblocks and signatures
 */
const FUNC_RE = new RegExp(
  '^[ \\t]*(?:(\\/\\*\\*(?:(?!\\*\\/)[\\s\\S])*\\*\\/)\\s*)?' + // /** ... */ (The optional preceding documentation comment must not cross another comment.)
  '((?:(?:public|private|package|remote|static|final|abstract)\\s+)*)' +
  '(?:([\\w.]+)\\s+)?' + // Return type
  'function\\s+(\\w+)\\s*\\(([^)]*)\\)',
  'gim'
);
/**
 * Splits a function argument list while preserving commas inside nested expressions and quoted strings.
 */
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
/**
 * Parses a CFML function argument declaration into its name, type, required flag, and default value.
 */
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
/**
 * Parses a JSDoc-style comment and extracts its description, parameter documentation, return description, and additional tags.
 */
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
      // ColdFusion style: "@parameterName description"
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

/**
 * Returns the offset of the "}" that closes the "{" at `open`, ignoring strings and comments.
 */
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
/**
 * Parses CFScript function declarations and their preceding DocBlocks.
 */
export function parseFunctions(text: string): FuncInfo[] {
  const funcs: FuncInfo[] = [];
  FUNC_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FUNC_RE.exec(text))) {
    const [full, rawDoc, modifiers, returnType, name, rawArgs] = m;
    const args = splitArgs(rawArgs).map(parseArg);
    const doc = parseDoc(rawDoc);

    // Parameters documented in the "@name description" style
    for (const a of args) {
      const k = a.name.toLowerCase();
      if (!doc.params[k] && doc.extra[k]) { doc.params[k] = doc.extra[k].trim(); }
    }

    // Function range (used to resolve arguments., local., and var)
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

/**
 * Functions defined with tags: <cffunction> ---
 */
const TAG_FUNC_RE = /(?:<!---((?:(?!--->)[\s\S])*)--->\s*)?<cffunction\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/gi;
/**
 * Functions defined with tags: <cfargument> ---
 */
const TAG_ARG_RE = /<cfargument\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/gi;

/**
 * Removes the delimiters and whitespace from a CFML comment (<!--- ... --->).
 */
function cleanCfComment(s: string | undefined): string {
  return (s || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).join('\n').trim();
}

/**
 * Formats an attribute value as a literal: numbers and booleans remain unquoted; all other values are quoted.
 */
function quoteAttr(v: string): string {
  return /^-?[\d.]+$|^(true|false|yes|no)$/i.test(v) ? v : `"${v}"`;
}
/**
 * Extracts function signatures and documentation from <cffunction> and <cfargument> tags.
 */
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

/**
 * Returns the innermost function containing the specified offset.
 */
function enclosingFunction(funcs: FuncInfo[], offset: number): FuncInfo | undefined {
  let best: FuncInfo | undefined;
  for (const f of funcs) {
    if (f.start <= offset && offset <= f.end && (!best || f.start > best.start)) { best = f; }
  }
  return best;
}
/**
 * Formats a parsed argument as a readable type-annotated parameter declaration.
 */
function formatArg(a: ArgInfo): string {
  const optional = !a.required && a.defaultValue === undefined;
  const def = a.defaultValue !== undefined ? ` = ${a.defaultValue}` : '';
  return `${a.name}${optional ? '?' : ''}: ${a.type}${def}`;
}
/**
 * Formats a TypeScript-style signature, for example: function getUser(id: numeric, opts?: struct): struct.
 */
export function formatSignature(fn: FuncInfo): string {
  return `function ${fn.name}(${fn.args.map(formatArg).join(', ')}): ${fn.returnType}`;
}

/**
 * Variables: variables.x / this.x / application.x / local.x / var x / property
 */
const ASSIGN_RE = new RegExp(`^\\s*(${ASSIGN_SCOPES.join('|')})\\.(\\w+)\\s*=(?!=)\\s*(.*)$`, 'i');
/**
 * Variables: var x
 */
const VAR_RE = /^\s*var\s+(?:([\w.]+)\s+)?(\w+)\s*(?=[=;]|\/\/|$)(.*)$/i;
/**
 * Variables: var in for
 */
const FOR_VAR_RE = /^\s*for\s*\(\s*var\s+(?:([\w.]+)\s+)?(\w+)\s*(?=[=;]|\bin\b)/i;
/**
 * Variables: property
 */
const PROPERTY_RE = /^\s*property\s+([^;]*);?/i;

/**
 * Separates a trailing slash-slash comment that is not inside a quoted string.
 */
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
/**
 * Parses a CFML property declaration and returns its name, type, default value, and hint.
 */
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
/**
 * Extracts documented variables and properties from CFScript and tag-based CFML declarations.
 */
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

    // Block comments, including documentation comments (/** ... */ o /* ... */), may span multiple lines.
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

    // Consecutive line comments
    if (t.startsWith('//')) {
      buffer.push(t.replace(/^\/\/+\s?/, ''));
      continue;
    }

    // CFML comment: <!--- ... --->
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

    // page = value; (unscoped; must end with ; to avoid confusing it with multiline structs)
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
/**
 * Determines whether a parsed variable matches the requested scope and identifier.
 */
function varMatches(v: VarInfo, scope: string, name: string): boolean {
  if (v.name.toLowerCase() !== name) { return false; }
  if (scope === 'local') { return v.kind === 'var' || v.scope === 'local'; }
  if (v.kind === 'var') { return false; }
  if (v.kind === 'property') { return scope === 'variables' || scope === 'this'; }
  return v.scope === scope;
}
/**
 * Returns local variables declared within the specified function body.
 */
function localVarsOf(vars: VarInfo[], fn: FuncInfo | undefined): VarInfo[] {
  if (!fn) { return []; }
  return vars.filter(v =>
    (v.kind === 'var' || v.scope === 'local') && v.offset >= fn.start && v.offset <= fn.end
  );
}

/**
 * Hover Markdown
 */
function codeLanguage(): string {
  return vscode.workspace
    .getConfiguration('cfscriptDocblockHover')
    .get<string>('codeLanguage', 'cfscript-hover');
}
/**
 * Builds hover Markdown for a user-defined function, including its signature and DocBlock details.
 */
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
/**
 * Builds hover Markdown for a function parameter and its documentation.
 */
function toMarkdownParam(fn: FuncInfo, a: ArgInfo): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendCodeblock(`(parameter) ${formatArg(a)}`, codeLanguage());
  const d = fn.doc.params[a.name.toLowerCase()];
  if (d) { md.appendMarkdown(d + '\n'); }
  md.appendMarkdown(`\n*parameter of* \`${fn.name}\``);
  return md;
}
/**
 * Builds hover Markdown for a variable or property, including its declaration and description.
 */
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

/**
 * Components: docblocks, extends, resolution, and inheritance
 */
const COMPONENT_RE = new RegExp(
  '^[ \\t]*(?:(\\/\\*\\*(?:(?!\\*\\/)[\\s\\S])*\\*\\/)\\s*)?' + // /** ... */
  '(?:(?:abstract|final)\\s+)*component\\b([^{;]*)\\{',
  'im'
);
/**
 * <cfcomponent>
 */
const CFCOMPONENT_RE = /(?:<!---((?:(?!--->)[\s\S])*)--->\s*)?<cfcomponent\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/i;
/**
 * Parses quoted and unquoted attributes from a CFML tag or component declaration.
 */
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
/**
 * Parses component-level documentation and inheritance metadata from a CFC source file.
 */
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
/**
 * Returns a component file name without its directory or CFML extension.
 */
function uriBase(u: vscode.Uri): string {
  const p = u.path;
  return p.slice(p.lastIndexOf('/') + 1).replace(/\.(cfc|cfm|cfml)$/i, '');
}
/**
 * Returns the normalized directory path containing the specified document.
 */
function uriDir(u: vscode.Uri): string {
  const p = u.path;
  return p.slice(0, p.lastIndexOf('/')).toLowerCase();
}

/**
 * Finds components by name or dotted path (app.models.Logger), with the best matches first.
 */
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
  // If the dotted path matches exactly, discard the remaining matches
  if (parts.length > 1 && matches.length && score(matches[0]) >= 2) {
    return matches.filter(e => score(e) >= 2);
  }
  return matches;
}

/**
 * Returns the base components (extends) of the specified component, from nearest to farthest.
 */
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
/**
 * Builds hover Markdown for a component and its constructor, including inherited initialization details.
 */
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

/**
 * Native scopes (url, form, cgi, etc.): brief descriptions provided by the extension
 */
const SCOPE_INFO = new Map<string, string>([
  ['url', 'Parameters passed in the URL query string of the current request.'],
  ['form', 'Fields submitted by an HTML form using the POST method.'],
  ['cgi', 'Read-only variables provided by the web server and the current request.'],
  ['cookie', 'Cookies sent by the browser with the current request.'],
  ['client', 'Client variables persisted between requests for each visitor (requires clientManagement).'],
  ['session', 'Data kept for each visitor session (requires sessionManagement).'],
  ['application', 'Data shared by all requests of the application.'],
  ['server', 'Data shared by all applications of the CFML server instance.'],
  ['request', 'Data available during a single request, across pages, custom tags and components.'],
  ['variables', 'Default scope of a page, and private scope of a component.'],
  ['this', 'Public scope of a component instance (also used for settings in Application.cfc).'],
  ['local', 'Variables local to the current function.'],
  ['arguments', 'Arguments passed to the current function.']
]);
/**
 * CGI vars.
 */
const CGI_VARS = new Map<string, string>([
  ['http_host', 'Host name (and port) requested by the client.'],
  ['server_name', 'Host name of the server.'],
  ['server_port', 'Port on which the request was received.'],
  ['server_port_secure', '1 if the request was made over HTTPS, otherwise 0.'],
  ['server_protocol', 'Name and version of the protocol of the request (e.g. HTTP/1.1).'],
  ['server_software', 'Name and version of the web server software.'],
  ['https', '"on" if the request was made over HTTPS, otherwise "off".'],
  ['remote_addr', 'IP address of the client (or of the last proxy).'],
  ['remote_host', 'Host name of the client, when available.'],
  ['remote_user', 'Authenticated user name, if any.'],
  ['request_method', 'HTTP method of the request (GET, POST, ...).'],
  ['query_string', 'Query string of the request (the part after the "?").'],
  ['script_name', 'Virtual path of the template being executed.'],
  ['path_info', 'Extra path information that follows the script name.'],
  ['path_translated', 'File-system path of the requested resource.'],
  ['context_path', 'Context path of the web application.'],
  ['content_type', 'Content type of the request body.'],
  ['content_length', 'Length in bytes of the request body.'],
  ['http_user_agent', 'User-Agent header sent by the browser.'],
  ['http_referer', 'URL of the page that linked to the current one.'],
  ['http_accept_language', 'Languages accepted by the client (Accept-Language header).'],
  ['http_cookie', 'Raw Cookie header sent by the client.'],
  ['http_x_forwarded_for', 'Client IP behind proxies or load balancers. Can be spoofed by the client.']
]);

/**
 * cfscript statements equivalent to tags (include "x.cfm"; location(url="x"); param name="x"; ...)
 */
const SCRIPT_STATEMENTS = new Map<string, string>([
  ['include', 'cfinclude'],
  ['abort', 'cfabort'],
  ['exit', 'cfexit'],
  ['location', 'cflocation'],
  ['lock', 'cflock'],
  ['param', 'cfparam'],
  ['savecontent', 'cfsavecontent'],
  ['thread', 'cfthread'],
  ['throw', 'cfthrow'],
  ['rethrow', 'cfrethrow'],
  ['transaction', 'cftransaction'],
  ['import', 'cfimport']
]);
/**
 * Const with cfscript statements separates with |
 */
const SCRIPT_ALT = [...SCRIPT_STATEMENTS.keys()].join('|');

/**
 * Application.cfc settings that may not be listed as cfapplication attributes in CFDocs
 */
const APP_SETTINGS = new Map<string, string>([
  ['mappings', 'Struct that maps logical paths to directories (e.g. { "/lib": expandPath("./lib") }), used to resolve include, createObject, new and extends.'],
  ['customtagpaths', 'Directories (list or array) searched for custom tags.'],
  ['datasource', 'Default datasource for queries that do not specify one.'],
  ['datasources', 'Struct of datasource definitions available to the application.'],
  ['javasettings', 'Java settings, such as loadPaths, to load JAR files and classes for this application.'],
  ['restsettings', 'Settings for the REST services exposed by this application, such as cfclocation.'],
  ['ormenabled', 'Enables ORM (Hibernate) for the application.'],
  ['ormsettings', 'ORM configuration: datasource, cfclocation, dbcreate, and others.'],
  ['invokeimplicitaccessor', 'Whether property getters and setters are invoked when properties are accessed with dot notation.'],
  ['enablenullsupport', 'Enables null support, so null values are kept instead of being converted to empty strings.'],
  ['sameformfieldsasarray', 'Returns form fields that share a name as an array instead of a comma-delimited list.']
]);
/**
 * Const with URL scopes.
 */
const SCOPES_URL = 'https://cfdocs.org/scopes';
/**
 * Builds hover Markdown describing a native CFML scope.
 */
function toMarkdownScope(scope: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendCodeblock(`(scope) ${scope}`, codeLanguage());
  md.appendMarkdown((SCOPE_INFO.get(scope) || '') + '\n');
  md.appendMarkdown(`\n---\n*Scopes:* [cfdocs.org/scopes](${SCOPES_URL})`);
  return md;
}

/**
 * Provides hover documentation for a request-scope member: url.page, form.name, cgi.http_host, etc.
 */
export function nativeScopeMember(scope: string, name: string): vscode.MarkdownString | undefined {
  let desc: string | undefined;
  switch (scope) {
    case 'cgi': desc = CGI_VARS.get(name.toLowerCase()) ?? 'Variable provided by the web server for this request.'; break;
    case 'url': desc = 'Parameter received in the URL query string. Its value comes from the request.'; break;
    case 'form': desc = 'Field submitted by an HTML form (POST). Its value comes from the request.'; break;
    case 'cookie': desc = 'Cookie sent by the browser with this request.'; break;
    case 'client': desc = 'Client variable persisted between requests (requires clientManagement).'; break;
    default: return undefined;
  }
  const md = new vscode.MarkdownString();
  md.appendCodeblock(`(${scope}) ${name}`, codeLanguage());
  md.appendMarkdown(desc + '\n');
  md.appendMarkdown(`\n---\n*Scopes:* [cfdocs.org/scopes](${SCOPES_URL})`);
  return md;
}

/**
 * Represents a parameter or tag attribute from a CFDocs entry.
 */
interface CfDocsParam {
  name: string;
  description?: string;
  required?: boolean;
  default?: unknown;
  type?: string;
  values?: unknown[];
}
/**
 * Represents the documentation metadata for a native CFML function or tag retrieved from CFDocs.
 */
interface CfDocsEntry {
  name: string;
  type?: string; // function | tag
  syntax?: string;
  script?: string;
  member?: string;
  returns?: string;
  description?: string;
  discouraged?: string;
  params?: CfDocsParam[];
  engines?: Record<string, { minimum_version?: string; notes?: string; docs?: string }>;
}
/**
 * CFDocs default base URL.
 */
const CFDOCS_DEFAULT_BASE = 'https://raw.githubusercontent.com/foundeo/cfdocs/master/data/en/';
/**
 * Days to reload CFDocs cache.
 */
const DAY_MS = 86400000;
/**
 * Const with Keywords.
 */
const NOT_FUNCTIONS = new Set([
  'if', 'else', 'elseif', 'for', 'while', 'do', 'switch', 'case', 'catch', 'try', 'finally',
  'function', 'return', 'new', 'throw', 'and', 'or', 'not', 'in', 'is', 'eq', 'neq', 'lt', 'gt', 'lte', 'gte'
]);
/**
 * VSCode storage utility.
 */
let storage: vscode.Memento | undefined;
/**
 * Time to wait reload CFDocs cache.
 */
let offlineUntil = 0;
/**
 * Map CfDocsEntry information.
 */
const cfdocsMemory = new Map<string, Promise<CfDocsEntry | null>>();
/**
 * Reads the CFDocs enablement setting and the configured documentation data URL.
 */
function cfdocsSettings(): { enabled: boolean; base: string } {
  const cfg = vscode.workspace.getConfiguration('cfscriptDocblockHover');
  const base = cfg.get<string>('cfdocs.baseUrl', CFDOCS_DEFAULT_BASE);
  return {
    enabled: cfg.get<boolean>('cfdocs.enabled', true),
    base: base.endsWith('/') ? base : base + '/'
  };
}
/**
 * Retrieves a URL over HTTPS and returns the HTTP status code and response body.
 */
function httpGet(url: string, timeoutMs = 4000): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'cf-cfscript-docblock-hover' } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

/**
 * Parses JSON while tolerating trailing commas, which appear in some CFDocs files.
 */
export function parseJsonLoose(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(text.replace(/,(\s*[}\]])/g, '$1'));
  }
}
/**
 * Loads a CFDocs entry from the configured data source, using persistent caching and temporary offline backoff.
 */
async function loadCfDocs(key: string): Promise<CfDocsEntry | null> {
  const storeKey = `cfdocs.v1.${key}`;
  const cached = storage?.get<{ t: number; d: CfDocsEntry | null }>(storeKey);
  if (cached && Date.now() - cached.t < (cached.d ? 7 : 1) * DAY_MS) { return cached.d; }
  if (Date.now() < offlineUntil) { cfdocsMemory.delete(key); return null; }

  try {
    const res = await httpGet(`${cfdocsSettings().base}${key}.json`);
    if (res.status === 200) {
      const d = parseJsonLoose(res.body) as CfDocsEntry;
      d.name = d.name || key;
      await storage?.update(storeKey, { t: Date.now(), d });
      return d;
    }
    if (res.status === 404) {
      await storage?.update(storeKey, { t: Date.now(), d: null });
      return null;
    }
  } catch {
    offlineUntil = Date.now() + 60000; // No network connection or invalid response: do not retry for one minute
  }
  cfdocsMemory.delete(key); // Do not cache this result; retry later
  return null;
}
/**
 * Retrieves a CFDocs entry by name, reusing an in-flight or cached lookup where possible.
 */
async function getCfDocs(name: string): Promise<CfDocsEntry | null> {
  const key = name.toLowerCase();
  if (!/^[a-z0-9_]+$/.test(key)) { return null; }
  let p = cfdocsMemory.get(key);
  if (!p) {
    p = loadCfDocs(key);
    cfdocsMemory.set(key, p);
  }
  return p;
}
/**
 * Normalizes whitespace and truncates a documentation string to a single line.
 */
function oneLine(s: string | undefined, max = 240): string {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}
/**
 * Converts a CFDocs default value into a displayable CFML literal.
 */
function cfdocsDefault(d: unknown): string | undefined {
  if (d === undefined || d === null || d === '') { return undefined; }
  return typeof d === 'string' ? quoteAttr(d) : String(d);
}
/**
 * Formats a CFDocs parameter as a readable type-annotated signature fragment.
 */
function cfdocsParamLine(p: CfDocsParam): string {
  const def = cfdocsDefault(p.default);
  const optional = !p.required && def === undefined;
  return `${p.name}${optional ? '?' : ''}: ${p.type || 'any'}${def !== undefined ? ` = ${def}` : ''}`;
}

/**
 * Formats a TypeScript-style signature, for example: function arrayAppend(array: array, value: any, merge?: boolean): boolean.
 */
export function cfdocsSignature(e: CfDocsEntry): string {
  return `function ${e.name}(${(e.params ?? []).map(cfdocsParamLine).join(', ')}): ${e.returns || 'void'}`;
}
/**
 * Returns the configured CFML engine names and their minimum supported versions for a CFDocs entry.
 */
function cfdocsEngines(e: CfDocsEntry): string {
  const engines = (e.engines ?? {}) as Record<string, { minimum_version?: string } | undefined>;
  const labels: Record<string, string> = { coldfusion: 'ColdFusion', lucee: 'Lucee', boxlang: 'BoxLang' };
  const wanted = vscode.workspace
    .getConfiguration('cfscriptDocblockHover')
    .get<string[]>('cfdocs.engines', ['coldfusion', 'lucee', 'boxlang'])
    .map(x => x.toLowerCase());
  return Object.keys(labels)
    .filter(k => wanted.includes(k) && engines[k])
    .map(k => `${labels[k]}${engines[k]?.minimum_version ? ` ${engines[k]?.minimum_version}+` : ''}`)
    .join(' · ');
}
/**
 * Appends engine compatibility information and the source link to a CFDocs hover.
 */
function cfdocsFooter(md: vscode.MarkdownString, e: CfDocsEntry): void {
  const engines = cfdocsEngines(e);
  const url = `https://cfdocs.org/${e.name.toLowerCase()}`;
  md.appendMarkdown(`\n---\n${engines ? `*${engines}* · ` : ''}*CFDocs:* [${url.replace('https://', '')}](${url})`);
}
/**
 * Builds hover Markdown for a native CFML function or tag documented by CFDocs.
 */
function toMarkdownCfDocs(e: CfDocsEntry, scriptForm = false): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  const isTag = e.type === 'tag';
  if (isTag && scriptForm && e.script) {
    md.appendCodeblock(e.script, codeLanguage());
  } else if (isTag) {
    md.appendCodeblock(e.syntax || `<${e.name}>`, 'html');
  } else {
    md.appendCodeblock(cfdocsSignature(e), codeLanguage());
  }
  if (e.discouraged) { md.appendMarkdown(`⚠️ *Discouraged:* ${oneLine(e.discouraged)}\n\n`); }
  if (e.description) { md.appendMarkdown(oneLine(e.description, 400) + '\n'); }
  if (!isTag && e.member) { md.appendMarkdown(`\n*member:* \`${e.member}\`\n`); }

  const params = e.params ?? [];
  const shown = params.slice(0, isTag ? 15 : 10);
  for (const p of shown) {
    const meta = [p.type, p.required ? 'required' : ''].filter(Boolean).join(', ');
    md.appendMarkdown(`\n*${isTag ? '@attr' : '@param'}* \`${p.name}\`${meta ? ` *(${meta})*` : ''}${p.description ? ` — ${oneLine(p.description)}` : ''}\n`);
  }
  if (params.length > shown.length) { md.appendMarkdown(`\n*… +${params.length - shown.length} more*\n`); }
  if (!isTag && e.returns && e.returns !== 'void') { md.appendMarkdown(`\n*@returns* ${e.returns}\n`); }
  cfdocsFooter(md, e);
  return md;
}
/**
 * Builds hover Markdown for an Application.cfc setting documented by CFDocs.
 */
function toMarkdownCfDocsSetting(e: CfDocsEntry, p: CfDocsParam): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendCodeblock(`(setting) this.${p.name}: ${p.type || 'any'}`, codeLanguage());
  if (p.description) { md.appendMarkdown(oneLine(p.description, 500) + '\n'); }
  const values = (p.values ?? []).map(String).filter(Boolean);
  if (values.length) { md.appendMarkdown(`\n*Values:* ${values.slice(0, 12).map(v => `\`${v}\``).join(' | ')}\n`); }
  md.appendMarkdown('\n*Application.cfc setting, same as the* `cfapplication` *attribute*');
  cfdocsFooter(md, e);
  return md;
}

/**
 * Application setting (this.name, this.sessionTimeout, etc.) documented as a cfapplication attribute.
 */
async function getAppSetting(name: string, online: boolean): Promise<vscode.MarkdownString | undefined> {
  if (online) {
    const e = await getCfDocs('cfapplication');
    const p = e?.params?.find(x => x.name.toLowerCase() === name);
    if (e && p) { return toMarkdownCfDocsSetting(e, p); }
  }
  const desc = APP_SETTINGS.get(name);
  if (!desc) { return undefined; }
  const md = new vscode.MarkdownString();
  md.appendCodeblock(`(setting) this.${name}`, codeLanguage());
  md.appendMarkdown(desc + '\n');
  md.appendMarkdown('\n---\n*Application.cfc setting* · *CFDocs:* [cfdocs.org/application](https://cfdocs.org/application)');
  return md;
}
/**
 * Builds hover Markdown for a native function parameter or tag attribute documented by CFDocs.
 */
function toMarkdownCfDocsParam(e: CfDocsEntry, p: CfDocsParam): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendCodeblock(`(attribute) ${cfdocsParamLine(p)}`, codeLanguage());
  if (p.required) { md.appendMarkdown('*required*\n\n'); }
  if (p.description) { md.appendMarkdown(oneLine(p.description, 500) + '\n'); }
  const values = (p.values ?? []).map(String).filter(Boolean);
  if (values.length) { md.appendMarkdown(`\n*Values:* ${values.slice(0, 12).map(v => `\`${v}\``).join(' | ')}\n`); }
  md.appendMarkdown(`\n*attribute of* \`${e.name}\``);
  cfdocsFooter(md, e);
  return md;
}

/**
 * Workspace CFC index
 */
export const index = new Map<string, IndexEntry>();
/**
 * Promise to index
 */
let indexReady: Promise<unknown> | undefined;
/**
 * Reads a CFC file, parses its declarations, and adds the resulting metadata to the workspace index.
 */
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
/**
 * Builds the workspace component index once and returns the shared indexing promise.
 */
function ensureIndex(): Promise<unknown> {
  indexReady ??= Promise.resolve(
    vscode.workspace.findFiles('**/*.cfc', '**/node_modules/**')
  ).then((uris: vscode.Uri[]) => Promise.all(uris.map(indexFile)));
  return indexReady;
}

/**
 * Initializes the extension, watches CFC files, and registers the CFML hover provider.
 */
export function activate(context: vscode.ExtensionContext): void {
  storage = context.globalState;
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

        // N) new MyComponent() / extends="app.models.Base"
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

        const cfdocs = cfdocsSettings();

        // T) Native tags: <cfhttp ...> (tag name) and its attributes (method="get")
        if (cfdocs.enabled) {
          const lt = before.lastIndexOf('<');
          const seg = lt >= 0 ? before.slice(lt) : '';
          if (lt >= 0 && !seg.includes('>')) {
            if (/^<\/?$/.test(seg) && /^cf[a-z0-9_]*$/i.test(word)) {
              const e = await getCfDocs(word);
              if (e && e.type === 'tag') { return new vscode.Hover(toMarkdownCfDocs(e), range); }
            } else {
              const tn = seg.match(/^<(cf[a-z0-9_]+)\s/i);
              if (tn && /^\s*=/.test(lineText.slice(range.end.character))) {
                const e = await getCfDocs(tn[1]);
                const p = e?.params?.find(x => x.name.toLowerCase() === word);
                if (e && p) { return new vscode.Hover(toMarkdownCfDocsParam(e, p), range); }
              }
            }
          }
        }

        // T2) Tag attributes in cfscript: cfcontent(type="...") / cfcontent type="...";
        if (cfdocs.enabled && /^\s*=(?!=)/.test(lineText.slice(range.end.character))) {
          const pm = before.match(new RegExp(`(?<![.\\w])(cf[a-z0-9_]+|${SCRIPT_ALT})\\s*\\(([^()]*)$`, 'i'));
          const sm2 = before.match(new RegExp(`(?:^|[;{}])\\s*(cf[a-z0-9_]+|${SCRIPT_ALT})\\s+([^;{}()]*)$`, 'i'));
          const rawName = (pm ?? sm2)?.[1]?.toLowerCase();
          const tagName = rawName ? (SCRIPT_STATEMENTS.get(rawName) ?? rawName) : undefined;
          if (tagName) {
            const e = await getCfDocs(tagName);
            const p = e?.params?.find(x => x.name.toLowerCase() === word);
            if (e && p) { return new vscode.Hover(toMarkdownCfDocsParam(e, p), range); }
          }
        }

        // A) Scoped variable: arguments.x, local.x, variables.x, this.x, application.x, etc.
        const sm = before.match(new RegExp(`\\b(${HOVER_SCOPES.join('|')})\\.$`, 'i'));
        if (sm && !isCall) {
          const scope = sm[1].toLowerCase();

          if (scope === 'arguments') {
            const p = fn?.args.find(a => a.name.toLowerCase() === word);
            return fn && p ? new vscode.Hover(toMarkdownParam(fn, p), range) : undefined;
          }

          const pool = scope === 'local' ? localVarsOf(vars, fn) : vars;
          const local = pool.filter(v => varMatches(v, scope, word)).sort(byDoc);
          const setting = scope === 'this' && uriBase(document.uri).toLowerCase() === 'application'
            ? await getAppSetting(word, cfdocs.enabled)
            : undefined;
          if (local.length) {
            return new vscode.Hover(
              [...local.slice(0, 3).map(v => toMarkdownVar(v, scope)), ...(setting ? [setting] : [])],
              range
            );
          }

          // Members inherited from base components (extends)
          if (scope === 'variables' || scope === 'this') {
            await ensureIndex();
            for (const e of inheritanceChain(current)) {
              const hits = e.vars.filter(v => varMatches(v, scope, word)).sort(byDoc);
              if (hits.length) {
                return new vscode.Hover(hits.slice(0, 3).map(v => toMarkdownVar(v, scope, rel(e.uri))), range);
              }
            }
            return setting ? new vscode.Hover(setting, range) : undefined;
          }

          // Shared scopes: these can be defined in another CFC (for example, Application.cfc)
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
          const nat = nativeScopeMember(scope, word);
          return nat ? new vscode.Hover(nat, range) : undefined;
        }

        // C) Unqualified identifier inside a function: parameter or local variable (var / local.x)
        if (!isCall && fn && !before.endsWith('.')) {
          const p = fn.args.find(a => a.name.toLowerCase() === word);
          if (p) { return new vscode.Hover(toMarkdownParam(fn, p), range); }

          const lv = localVarsOf(vars, fn).filter(v => varMatches(v, 'local', word)).sort(byDoc);
          if (lv.length) {
            return new vscode.Hover(toMarkdownVar(lv[0], lv[0].scope), range);
          }
        }

        // S) Scope name followed by "." or "[": url.x, form.x, cgi.x, session.x, etc
        if (!isCall && !before.endsWith('.') && SCOPE_INFO.has(word) && /^\s*[.\[]/.test(lineText.slice(range.end.character))) {
          return new vscode.Hover(toMarkdownScope(word), range);
        }

        // D) Unqualified identifier: variables-scope variable (<cfset page = ...>, page = ...;, property)
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

        // Tag in cfscript: cfcontent type="text/html";  /  include "x.cfm";  /  location(url="x")
        if (cfdocs.enabled && !before.endsWith('.')) {
          const atStatement = /(?:^|[;{}])\s*$/.test(before) && !/^\s*=(?!=)/.test(lineText.slice(range.end.character));
          const isUserFn = funcs.some(f => f.name.toLowerCase() === word);
          const stmt = atStatement && !isUserFn ? SCRIPT_STATEMENTS.get(word) : undefined;
          const tagName = stmt ?? (!isCall && /^cf[a-z0-9_]+$/.test(word) ? word : undefined);
          if (tagName) {
            const e = await getCfDocs(tagName);
            if (e && e.type === 'tag') { return new vscode.Hover(toMarkdownCfDocs(e, true), range); }
          }
        }

        // B) Function: name followed by "(" (call or declaration)
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

        // Methods inherited from base components
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

        // Any other CFC in the workspace with that documented method
        const found: vscode.MarkdownString[] = [];
        for (const { uri, funcs: fs } of index.values()) {
          for (const f of fs) {
            if (f.name.toLowerCase() === word && f.hasDoc) {
              found.push(toMarkdown(f, rel(uri)));
            }
          }
        }
        if (found.length) { return new vscode.Hover(found.slice(0, 5), range); }

        // Native CFML function (CFDocs): only when it is not a method of another object (obj.method())
        if (cfdocs.enabled && !before.endsWith('.') && !NOT_FUNCTIONS.has(word) && /^[a-z_]\w*$/.test(word)) {
          const e = await getCfDocs(word);
          if (e) { return new vscode.Hover(toMarkdownCfDocs(e, e.type === 'tag'), range); }
        }
        return undefined;
      }
    })
  );
}

/**
 * Releases extension resources when the extension is deactivated.
 */
export function deactivate(): void {}