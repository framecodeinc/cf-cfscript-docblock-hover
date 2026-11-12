/**
 * CFScript DocBlock Hover.
 *
 * VS Code extension that shows documentation in a hover tooltip for CFML code: the docblocks and
 * hints of user functions, components, variables and properties, plus the native functions, tags
 * and statements documented in CFDocs.
 *
 * The file is organized in sections:
 * 1. Types and scope tables.
 * 2. Parsing of functions, variables and components.
 * 3. Hover markdown builders.
 * 4. Online lookup in CFDocs, with a local cache.
 * 5. Workspace CFC index and the hover provider.
 */

import * as vscode from 'vscode';
import * as https from 'https';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
/** Documentation extracted from a docblock or from tag attributes. */
interface DocInfo {
  /** Free text that comes before the first tag. */
  description: string;
  /** Description of each parameter, keyed by its lower case name. */
  params: Record<string, string>;
  /** Description of the return value. */
  returns: string;
  /** Tags that are not known, keyed by lower case name. In the ColdFusion style they document parameters (`@name text`). */
  extra: Record<string, string>;
}

/** A function argument, as declared in a signature or in a <cfargument> tag. */
interface ArgInfo {
  /** The argument exactly as it was written. */
  text: string;
  /** Name of the argument. */
  name: string;
  /** Declared type, or "any". */
  type: string;
  /** Whether the argument is required. */
  required: boolean;
  /** Default value as written, when there is one. */
  defaultValue?: string;
}

/** A function (cfscript or tag based) with its documentation and its range in the file. */
interface FuncInfo {
  /** Name of the function. */
  name: string;
  /** Access and other modifiers, such as `public` or `remote`. */
  modifiers: string;
  /** Declared return type, or "any". */
  returnType: string;
  /** Declared arguments. */
  args: ArgInfo[];
  /** Documentation of the function. */
  doc: DocInfo;
  /** Whether the function has any documentation. */
  hasDoc: boolean;
  /** Offset of the "function" keyword. */
  start: number;
  /** Offset of the closing "}" (or of ")" when there is no body). */
  end: number;
}

/** A variable, assignment or property found in a file, with its documentation. */
interface VarInfo {
  /** Scope of the variable: variables, this, application, session, request, server, local, url, form, cookie or client. */
  scope: string;
  /** Name of the variable, without the scope. */
  name: string;
  /** How the variable was declared. */
  kind: 'assignment' | 'property' | 'var';
  /** Assigned or default value, as written. */
  value?: string;
  /** Declared type, when there is one. */
  type?: string;
  /** Documentation: the comment above, the trailing comment or the `hint`. */
  doc: string;
  /** Offset of the start of the line. */
  offset: number;
  /** True for an unscoped assignment: `<cfset page = ...>` or `page = ...;`. */
  bare?: boolean;
}

/** Component level information: base component and description. */
interface ComponentInfo {
  /** Base component, as written in `extends`. */
  extends?: string;
  /** Implemented interfaces, as written in `implements`. */
  implements?: string;
  /** Description taken from the docblock or from `hint`. */
  description: string;
}

/** Parsed data of one file, as stored in the workspace index. */
interface IndexEntry {
  /** Location of the file. */
  uri: vscode.Uri;
  /** Functions found in the file. */
  funcs: FuncInfo[];
  /** Variables found in the file. */
  vars: VarInfo[];
  /** Component information, when the file declares a component. */
  component?: ComponentInfo;
  /** Templates included by the file (`include` or `<cfinclude>`), as written. */
  includes?: string[];
}

/** Scopes that can be shared between files or live outside functions. */
const SHARED_SCOPES = ['variables', 'this', 'application', 'session', 'request', 'server'];
/** Scopes in which assignments are detected: `x.name = value`. */
const ASSIGN_SCOPES = [...SHARED_SCOPES, 'local', 'url', 'form', 'cookie', 'client'];
/** Scopes on which hover is shown: `x.name`. */
const HOVER_SCOPES = [...ASSIGN_SCOPES, 'arguments', 'cgi'];

// ---------------------------------------------------------------------------
// Functions: docblock + signature
// ---------------------------------------------------------------------------
/**
 * Matches a cfscript function declaration: optional docblock, modifiers,
 * optional return type, name and arguments.
 * Groups: 1 = docblock, 2 = modifiers, 3 = return type, 4 = name, 5 = raw arguments.
 */
const FUNC_RE = new RegExp(
  '^[ \\t]*(?:(\\/\\*\\*(?:(?!\\*\\/)[\\s\\S])*\\*\\/)\\s*)?' + // /** ... */ (without crossing other comments)
  '((?:(?:public|private|package|remote|static|final|abstract)\\s+)*)' +
  '(?:([\\w.]+)\\s+)?' + // return type
  'function\\s+(\\w+)\\s*\\(([^)]*)\\)',
  'gim'
);

/**
 * Splits an argument list on top-level commas, ignoring commas inside quotes and brackets.
 * @param str - The raw text between the parentheses of a function declaration.
 * @returns The trimmed arguments.
 */
function splitArgs(str: string): string[] {
  const out: string[] = [];
  /** Nesting depth of brackets, braces and parentheses. */
  let depth = 0;
  /** Quote character of the string being read, or null outside strings. */
  let quote: string | null = null;
  /** Text of the argument being read. */
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
 * Parses a single argument such as `required numeric id = 5`.
 * @param text - The raw argument text.
 * @returns The argument name, type, whether it is required and its default value.
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
 * Parses a docblock into description, parameters and return documentation.
 * Both `@param name text` and the ColdFusion style `@name text` are supported.
 * @param raw - The docblock text including the comment delimiters, if any.
 * @returns The parsed documentation (empty when there is no docblock).
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
  /** Adds a continuation line to the description or tag being read. */
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
      // ColdFusion style: "@paramName description"
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
 * Finds the "}" that closes the "{" at `open`, ignoring strings and comments.
 * @param text - The full file text.
 * @param open - Offset of the opening brace.
 * @returns The offset of the closing brace, or -1 if it is not found.
 */
function findBodyEnd(text: string, open: number): number {
  /** Nesting depth of braces. */
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
      /** Index of the character being checked for the end of the string. */
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
 * Finds every function declared in a file, in cfscript and in tag syntax.
 * @param text - The full file text.
 * @returns The functions with their signature, documentation and range.
 */
export function parseFunctions(text: string): FuncInfo[] {
  const funcs: FuncInfo[] = [];
  FUNC_RE.lastIndex = 0;
  /** Current function match. */
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

    // Range of the function (to resolve arguments., local. and var)
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

// --- Functions defined with tags: <cffunction> + <cfargument> ---
/** Matches a <cffunction> opening tag, with an optional <!--- comment ---> right above it. */
const TAG_FUNC_RE = /(?:<!---((?:(?!--->)[\s\S])*)--->\s*)?<cffunction\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/gi;
/** Matches a <cfargument> tag. */
const TAG_ARG_RE = /<cfargument\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/gi;

/**
 * Cleans the text of a CFML comment.
 * @param s - The comment text without its delimiters.
 * @returns The trimmed, non-empty lines joined with line breaks.
 */
function cleanCfComment(s: string | undefined): string {
  return (s || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean).join('\n').trim();
}

/**
 * Formats an attribute value as a literal: numbers and booleans are kept, the rest is quoted.
 * @param v - The attribute value.
 * @returns The value as it would be written in code.
 */
function quoteAttr(v: string): string {
  return /^-?[\d.]+$|^(true|false|yes|no)$/i.test(v) ? v : `"${v}"`;
}

/**
 * Finds the functions declared with <cffunction>, including their <cfargument> tags.
 * The documentation comes from the comment above and from the hint and description attributes.
 * @param text - The full file text.
 * @returns The tag based functions.
 */
function parseTagFunctions(text: string): FuncInfo[] {
  const funcs: FuncInfo[] = [];
  const lower = text.toLowerCase();
  const re = new RegExp(TAG_FUNC_RE.source, 'gi');
  /** Current <cffunction> match. */
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
    /** Current <cfargument> match. */
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
 * Finds the innermost function that contains an offset.
 * @param funcs - The functions of the file.
 * @param offset - Offset of the cursor in the file.
 * @returns The enclosing function, if any.
 */
function enclosingFunction(funcs: FuncInfo[], offset: number): FuncInfo | undefined {
  /** Innermost function found so far. */
  let best: FuncInfo | undefined;
  for (const f of funcs) {
    if (f.start <= offset && offset <= f.end && (!best || f.start > best.start)) { best = f; }
  }
  return best;
}

/**
 * Formats an argument in TypeScript style: `name?: type = default`.
 * @param a - The argument.
 * @returns The formatted argument.
 */
function formatArg(a: ArgInfo): string {
  const optional = !a.required && a.defaultValue === undefined;
  const def = a.defaultValue !== undefined ? ` = ${a.defaultValue}` : '';
  return `${a.name}${optional ? '?' : ''}: ${a.type}${def}`;
}

/**
 * Formats a function signature in TypeScript style, e.g. `function getUser(id: numeric): struct`.
 * @param fn - The function.
 * @returns The signature.
 */
export function formatSignature(fn: FuncInfo): string {
  return `function ${fn.name}(${fn.args.map(formatArg).join(', ')}): ${fn.returnType}`;
}

// ---------------------------------------------------------------------------
// Variables: variables.x / this.x / application.x / local.x / var x / property
// ---------------------------------------------------------------------------
/** Matches a scoped assignment such as `this.name = value`. */
const ASSIGN_RE = new RegExp(`^\\s*(${ASSIGN_SCOPES.join('|')})\\.(\\w+)\\s*=(?!=)\\s*(.*)$`, 'i');
/** Matches a `var` declaration such as `var string x = value;`. */
const VAR_RE = /^\s*var\s+(?:([\w.]+)\s+)?(\w+)\s*(?=[=;]|\/\/|$)(.*)$/i;
/** Matches a loop variable declared with var: `for (var i = 0; ...)` or `for (var k in struct)`. */
const FOR_VAR_RE = /^\s*for\s*\(\s*var\s+(?:([\w.]+)\s+)?(\w+)\s*(?=[=;]|\bin\b)/i;
/** Matches a cfscript `property` declaration. */
const PROPERTY_RE = /^\s*property\s+([^;]*);?/i;

/**
 * Splits a trailing `//` comment off a line of code, ignoring `//` inside quotes.
 * @param s - The text after the assignment operator.
 * @returns The code and the comment (empty if there is none).
 */
function splitTrailingComment(s: string): { code: string; comment: string } {
  /** Quote character of the string being scanned, or null outside strings. */
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
 * Parses the attributes of a `property` declaration.
 * Supports `property name="x" type="string"` and the short form `property string x;`.
 * @param body - The text after the `property` keyword.
 * @returns The property name, type, default value and hint, or undefined if it has no name.
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
 * Finds the variables of a file: scoped assignments, `var` declarations, unscoped assignments,
 * `property`, `<cfproperty>`, `<cfparam>` and `<cfset>`.
 * The comment above a declaration, or at the end of its line, is used as its documentation.
 * @param text - The full file text.
 * @returns The variables found, in file order.
 */
export function parseVariables(text: string): VarInfo[] {
  const vars: VarInfo[] = [];
  const rawLines = text.split('\n');
  const offsets: number[] = [];
  /** Running offset of the start of each line. */
  let acc = 0;
  for (const l of rawLines) { offsets.push(acc); acc += l.length + 1; }
  const lines = rawLines.map(l => l.replace(/\r$/, ''));
  /** Comment lines found right above the next declaration. */
  let buffer: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();

    if (!t) { buffer = []; continue; }

    // Block comment (/** ... */ or /* ... */), possibly spanning several lines
    if (t.startsWith('/*')) {
      /** Text of the block comment, joined line by line until its closing marker. */
      let chunk = t;
      /** Index of the last line that belongs to the comment. */
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
      /** Text of the CFML comment, joined line by line until its closing marker. */
      let chunk = t;
      /** Index of the last line that belongs to the comment. */
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

    // <cfset var x = value> / <cfset this.x = value> / <cfset local.x = value>
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

    // <cfparam name="variables.x" default="value" type="numeric">
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

    // var x = value; / var string x = value; / var x;
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

    // this.x = value; variables.x = value; application.x = value; local.x = value ...
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

    // page = value;  (unscoped; it must end with ; so it is not confused with multi-line struct literals)
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
 * Checks whether a variable is the one referenced as `scope.name`.
 * @param v - The candidate variable.
 * @param scope - The scope in lower case (variables, this, local...).
 * @param name - The variable name in lower case.
 * @returns True if the variable matches.
 */
function varMatches(v: VarInfo, scope: string, name: string): boolean {
  if (v.name.toLowerCase() !== name) { return false; }
  if (scope === 'local') { return v.kind === 'var' || v.scope === 'local'; }
  if (v.kind === 'var') { return false; }
  if (v.kind === 'property') { return scope === 'variables' || scope === 'this'; }
  return v.scope === scope;
}

/**
 * Selects the local variables declared inside a function.
 * @param vars - The variables of the file.
 * @param fn - The function, if any.
 * @returns The `var` declarations and `local.x` assignments inside the function.
 */
function localVarsOf(vars: VarInfo[], fn: FuncInfo | undefined): VarInfo[] {
  if (!fn) { return []; }
  return vars.filter(v =>
    (v.kind === 'var' || v.scope === 'local') && v.offset >= fn.start && v.offset <= fn.end
  );
}

// ---------------------------------------------------------------------------
// Hover markdown
// ---------------------------------------------------------------------------
/** Reads the language used to color the code shown in the hover. */
function codeLanguage(): string {
  return vscode.workspace
    .getConfiguration('cfscriptDocblockHover')
    .get<string>('codeLanguage', 'cfscript-hover');
}

/**
 * Builds the hover for a function: signature, modifiers, description, parameters and return value.
 * @param fn - The function.
 * @param fileLabel - Relative path of the file, shown when the function comes from another file.
 * @returns The markdown to show.
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
 * Builds the hover for a function parameter.
 * @param fn - The function that declares the parameter.
 * @param a - The parameter.
 * @returns The markdown to show.
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
 * Builds the hover for a variable, assignment or property.
 * @param v - The variable.
 * @param scope - The scope used to reference it.
 * @param fileLabel - Relative path of the file, shown when the variable comes from another file.
 * @returns The markdown to show.
 */
function toMarkdownVar(v: VarInfo, scope: string, fileLabel?: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  const val = v.value && v.value.length > 120 ? v.value.slice(0, 117) + '...' : v.value;
  /** Line of code shown at the top of the hover. */
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
// Components: docblock, extends, resolution and inheritance
// ---------------------------------------------------------------------------
/** Matches the start of a cfscript component, with an optional docblock above it. */
const COMPONENT_RE = new RegExp(
  '^[ \\t]*(?:(\\/\\*\\*(?:(?!\\*\\/)[\\s\\S])*\\*\\/)\\s*)?' + // /** ... */
  '(?:(?:abstract|final)\\s+)*component\\b([^{;]*)\\{',
  'im'
);
/** Matches a <cfcomponent> tag, with an optional <!--- comment ---> above it. */
const CFCOMPONENT_RE = /(?:<!---((?:(?!--->)[\s\S])*)--->\s*)?<cfcomponent\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/i;

/**
 * Parses tag attributes such as `name="x" type='string' required=true`.
 * @param s - The attributes text.
 * @returns The attributes, keyed by lower case name.
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
 * Reads the component declaration of a file (cfscript or tag syntax).
 * @param text - The full file text.
 * @returns The base component and description, or undefined if the file has no component.
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

/** Returns the file name of a URI without its extension. */
function uriBase(u: vscode.Uri): string {
  const p = u.path;
  return p.slice(p.lastIndexOf('/') + 1).replace(/\.(cfc|cfm|cfml)$/i, '');
}

/** Returns the lower case directory of a URI. */
function uriDir(u: vscode.Uri): string {
  const p = u.path;
  return p.slice(0, p.lastIndexOf('/')).toLowerCase();
}

/**
 * Looks up components by name or by dotted path (app.models.Logger), best matches first.
 * @param ref - The component name or dotted path.
 * @param fromUri - File that references the component; components in the same folder rank higher.
 * @param extra - Additional entries to search, such as the file being edited.
 * @returns The matching entries.
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
  // If the dotted path matches exactly, discard the rest
  if (parts.length > 1 && matches.length && score(matches[0]) >= 2) {
    return matches.filter(e => score(e) >= 2);
  }
  return matches;
}

/**
 * Walks the `extends` chain of a component.
 * @param entry - The component to start from.
 * @returns The base components, from the closest to the farthest (cycles are ignored).
 */
export function inheritanceChain(entry: IndexEntry): IndexEntry[] {
  const chain: IndexEntry[] = [];
  const seen = new Set<string>([entry.uri.toString()]);
  /** Component whose `extends` is followed at each step. */
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
 * Builds the hover for a component: declaration, description and constructor signature.
 * @param e - The component entry.
 * @param fileLabel - Relative path of the file, shown when the component is in another file.
 * @returns The markdown to show.
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

// ---------------------------------------------------------------------------
// Native scopes (url, form, cgi...): short descriptions written for this extension
// ---------------------------------------------------------------------------
/** Short description of each variable scope. */
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

/** Short description of the most common CGI variables. */
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

/** cfscript statements that are equivalent to a tag: `include "x.cfm";`, `location(url="x")`, `param name="x";` ... */
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
/** The statement names joined with "|", for use in a regular expression. */
const SCRIPT_ALT = [...SCRIPT_STATEMENTS.keys()].join('|');

/** Application.cfc settings that may not be listed as cfapplication attributes in CFDocs. */
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

/** CFDocs page that explains the variable scopes. */
const SCOPES_URL = 'https://cfdocs.org/scopes';

/**
 * Builds the hover for a scope name such as `url` or `session`.
 * @param scope - The scope name in lower case.
 * @returns The markdown to show.
 */
function toMarkdownScope(scope: string): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  md.appendCodeblock(`(scope) ${scope}`, codeLanguage());
  md.appendMarkdown((SCOPE_INFO.get(scope) || '') + '\n');
  md.appendMarkdown(`\n---\n*Scopes:* [cfdocs.org/scopes](${SCOPES_URL})`);
  return md;
}

/**
 * Builds the hover for a member of a request scope: url.page, form.name, cgi.http_host...
 * @param scope - The scope (url, form, cgi, cookie or client).
 * @param name - The member name.
 * @returns The markdown to show, or undefined for other scopes.
 */
export function nativeScopeMember(scope: string, name: string): vscode.MarkdownString | undefined {
  /** Description of the member, or undefined when the scope has none. */
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

// ---------------------------------------------------------------------------
// Native CFML functions and tags: online lookup in CFDocs (the data is not bundled)
// ---------------------------------------------------------------------------
/** A parameter (or tag attribute) in a CFDocs entry. */
interface CfDocsParam {
  /** Name of the parameter or attribute. */
  name: string;
  /** What the parameter does. */
  description?: string;
  /** Whether it is required. */
  required?: boolean;
  /** Default value. It can be of any JSON type. */
  default?: unknown;
  /** Type of the value. */
  type?: string;
  /** Allowed values, when the parameter accepts a fixed set. */
  values?: unknown[];
}

/** An entry of the CFDocs data: a native function or tag. */
interface CfDocsEntry {
  /** Name of the function or tag. */
  name: string;
  /** Either "function" or "tag". */
  type?: string;
  /** Syntax as shown by CFDocs. */
  syntax?: string;
  /** cfscript syntax of a tag. */
  script?: string;
  /** Member function syntax, such as `array.append(value)`. */
  member?: string;
  /** Type of the return value. */
  returns?: string;
  /** What the function or tag does. */
  description?: string;
  /** Notice shown when the function or tag is discouraged. */
  discouraged?: string;
  /** Parameters, or attributes in the case of a tag. */
  params?: CfDocsParam[];
  /** Support and minimum version for each engine (coldfusion, lucee, boxlang). */
  engines?: Record<string, { minimum_version?: string; notes?: string; docs?: string }>;
}

/** Default location of the CFDocs JSON files. */
const CFDOCS_DEFAULT_BASE = 'https://raw.githubusercontent.com/foundeo/cfdocs/master/data/en/';
/** Milliseconds in a day, used for the cache lifetime. */
const DAY_MS = 86400000;
/** Keywords that look like function calls but must not be looked up in CFDocs. */
const NOT_FUNCTIONS = new Set([
  'if', 'else', 'elseif', 'for', 'while', 'do', 'switch', 'case', 'catch', 'try', 'finally',
  'function', 'return', 'new', 'throw', 'and', 'or', 'not', 'in', 'is', 'eq', 'neq', 'lt', 'gt', 'lte', 'gte'
]);

/** Persistent storage used to cache CFDocs responses. It is set on activation. */
let storage: vscode.Memento | undefined;
/** Time until which CFDocs requests are skipped after a network failure. */
let offlineUntil = 0;
/** In-memory cache of CFDocs lookups, so that concurrent hovers share a single request. */
const cfdocsMemory = new Map<string, Promise<CfDocsEntry | null>>();

/**
 * Reads the CFDocs settings.
 * @returns Whether CFDocs is enabled and the base URL (always ending with "/").
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
 * Performs an HTTPS GET request.
 * @param url - The URL to request.
 * @param timeoutMs - Time after which the request is aborted.
 * @returns The HTTP status and the response body.
 */
function httpGet(url: string, timeoutMs = 4000): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'cf-cfscript-docblock-hover' } }, res => {
      /** Response body, accumulated chunk by chunk. */
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
 * Parses JSON, tolerating trailing commas (some CFDocs files have them).
 * @param text - The JSON text.
 * @returns The parsed value.
 */
export function parseJsonLoose(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return JSON.parse(text.replace(/,(\s*[}\]])/g, '$1'));
  }
}

/**
 * Loads a CFDocs entry from the local cache or from the network.
 * Found entries are cached for 7 days and missing ones for 1 day. Network errors are not cached.
 * @param key - The lower case function or tag name.
 * @returns The entry, or null if it does not exist or could not be loaded.
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
    offlineUntil = Date.now() + 60000; // no network or invalid response: do not retry for 1 minute
  }
  cfdocsMemory.delete(key); // not cached: it will be retried later
  return null;
}

/**
 * Gets a CFDocs entry, sharing concurrent requests for the same name.
 * @param name - The function or tag name.
 * @returns The entry, or null.
 */
async function getCfDocs(name: string): Promise<CfDocsEntry | null> {
  const key = name.toLowerCase();
  if (!/^[a-z0-9_]+$/.test(key)) { return null; }
  /** Pending or finished lookup of this name, when one already exists. */
  let p = cfdocsMemory.get(key);
  if (!p) {
    p = loadCfDocs(key);
    cfdocsMemory.set(key, p);
  }
  return p;
}

/**
 * Collapses text into a single line and truncates it.
 * @param s - The text.
 * @param max - Maximum length.
 * @returns The shortened text.
 */
function oneLine(s: string | undefined, max = 240): string {
  const t = (s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/**
 * Formats a CFDocs default value as a literal.
 * @param d - The default value from the data.
 * @returns The literal, or undefined if there is no default.
 */
function cfdocsDefault(d: unknown): string | undefined {
  if (d === undefined || d === null || d === '') { return undefined; }
  return typeof d === 'string' ? quoteAttr(d) : String(d);
}

/**
 * Formats a CFDocs parameter in TypeScript style: `name?: type = default`.
 * @param p - The parameter.
 * @returns The formatted parameter.
 */
function cfdocsParamLine(p: CfDocsParam): string {
  const def = cfdocsDefault(p.default);
  const optional = !p.required && def === undefined;
  return `${p.name}${optional ? '?' : ''}: ${p.type || 'any'}${def !== undefined ? ` = ${def}` : ''}`;
}

/**
 * Builds a TypeScript style signature for a native function.
 * @param e - The CFDocs entry.
 * @returns For example `function arrayAppend(array: array, value: any): boolean`.
 */
export function cfdocsSignature(e: CfDocsEntry): string {
  return `function ${e.name}(${(e.params ?? []).map(cfdocsParamLine).join(', ')}): ${e.returns || 'void'}`;
}

/**
 * Lists the engines (and their minimum versions) selected in the settings.
 * @param e - The CFDocs entry.
 * @returns For example `ColdFusion 6+ · Lucee`.
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
 * Appends the engines and the CFDocs link to a hover.
 * @param md - The markdown being built.
 * @param e - The CFDocs entry.
 */
function cfdocsFooter(md: vscode.MarkdownString, e: CfDocsEntry): void {
  const engines = cfdocsEngines(e);
  const url = `https://cfdocs.org/${e.name.toLowerCase()}`;
  md.appendMarkdown(`\n---\n${engines ? `*${engines}* · ` : ''}*CFDocs:* [${url.replace('https://', '')}](${url})`);
}

/**
 * Builds the hover for a native function or tag.
 * @param e - The CFDocs entry.
 * @param scriptForm - Show the cfscript syntax of a tag instead of its tag syntax.
 * @returns The markdown to show.
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
 * Builds the hover for an Application.cfc setting documented as a cfapplication attribute.
 * @param e - The cfapplication entry.
 * @param p - The attribute.
 * @returns The markdown to show.
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
 * Documents an Application.cfc setting (this.name, this.sessionTimeout...).
 * It uses the cfapplication attributes from CFDocs first, then a small table of settings.
 * @param name - The setting name in lower case.
 * @param online - Whether CFDocs may be queried.
 * @returns The markdown to show, or undefined if the setting is unknown.
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
 * Builds the hover for a tag attribute.
 * @param e - The tag entry.
 * @param p - The attribute.
 * @returns The markdown to show.
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

// ---------------------------------------------------------------------------
// Included templates: include "a.cfm"; / <cfinclude template="a.cfm">
// ---------------------------------------------------------------------------
/** Matches a cfscript `include "a.cfm";`, `include template="a.cfm";` or `cfinclude(template="a.cfm")`. */
const SCRIPT_INCLUDE_RE = /(?:^|[;{}>])[ \t]*(?:cf)?include\s*\(?\s*(?:template\s*=\s*)?(["'])([^"'\r\n]+)\1/gim;
/** Matches a `<cfinclude template="a.cfm">` tag. */
const TAG_INCLUDE_RE = /<cfinclude\b[^>]*?\btemplate\s*=\s*(["'])([^"'\r\n]+)\1/gi;
/** Maximum depth of nested includes that is followed (a.cfm includes b.cfm, which includes c.cfm ...). */
const MAX_INCLUDE_DEPTH = 5;

/** Replaces comments with a space, so that includes that are commented out are ignored. */
function stripComments(text: string): string {
  return text
    .replace(/<!---[\s\S]*?--->/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Finds the templates that a file includes, as written.
 * Includes with a dynamic path (`#variable#`) are ignored because they cannot be resolved.
 * @param text Source code of the file.
 * @returns The distinct paths, in order of appearance.
 */
export function parseIncludes(text: string): string[] {
  const clean = stripComments(text);
  const found: { ref: string; index: number }[] = [];
  for (const base of [SCRIPT_INCLUDE_RE, TAG_INCLUDE_RE]) {
    const re = new RegExp(base.source, base.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(clean))) {
      if (!m[2].includes('#')) { found.push({ ref: m[2].trim(), index: m.index }); }
    }
  }
  found.sort((a, b) => a.index - b.index);
  return [...new Set(found.map(f => f.ref))];
}

/** Resolved include paths, keyed by "file|path". A miss is remembered only for a short time. */
const includeResolutions = new Map<string, { uri?: vscode.Uri; t: number }>();

/** Checks whether a file exists. */
async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds the file that an include refers to.
 * A relative path is resolved from the folder of the including file; a path that starts with "/" is
 * resolved from each workspace folder. If neither exists (for example a mapping), the workspace is
 * searched for that path.
 * @param ref Path as written in the include.
 * @param fromUri File that contains the include.
 * @returns The file, or undefined when it cannot be found.
 */
export async function resolveInclude(ref: string, fromUri: vscode.Uri): Promise<vscode.Uri | undefined> {
  const key = `${fromUri.toString()}|${ref}`;
  const cached = includeResolutions.get(key);
  if (cached && (cached.uri || Date.now() - cached.t < 30000)) { return cached.uri; }

  const candidates = ref.startsWith('/')
    ? (vscode.workspace.workspaceFolders ?? []).map(f => vscode.Uri.joinPath(f.uri, ref))
    : [vscode.Uri.joinPath(fromUri, '..', ref)];

  let found: vscode.Uri | undefined;
  for (const c of candidates) {
    if (await fileExists(c)) { found = c; break; }
  }
  if (!found) {
    const tail = ref.replace(/^\/+/, '').replace(/^(\.{1,2}\/)+/, '');
    found = (await vscode.workspace.findFiles(`**/${tail}`, '**/node_modules/**', 5))[0];
  }
  includeResolutions.set(key, { uri: found, t: Date.now() });
  return found;
}

/** Parsed included files, keyed by URI. `stamp` tells whether the entry is still current. */
const fileCache = new Map<string, { stamp: string; entry: IndexEntry }>();

/**
 * Reads and parses a file. If the file is open in an editor its current text is used, so unsaved
 * changes are taken into account; otherwise it is read from disk. The result is cached until the
 * file changes.
 * @param uri File to read.
 * @returns The parsed file, or undefined when it cannot be read.
 */
export async function getFileEntry(uri: vscode.Uri): Promise<IndexEntry | undefined> {
  const key = uri.toString();
  const open = vscode.workspace.textDocuments.find(d => d.uri.toString() === key);
  let stamp: string;
  try {
    stamp = open ? `doc:${open.version}` : `disk:${(await vscode.workspace.fs.stat(uri)).mtime}`;
  } catch {
    return undefined;
  }
  const cached = fileCache.get(key);
  if (cached && cached.stamp === stamp) { return cached.entry; }

  let text: string;
  try {
    text = open ? open.getText() : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
  } catch {
    return undefined;
  }
  const entry: IndexEntry = {
    uri,
    funcs: parseFunctions(text),
    vars: parseVariables(text),
    component: parseComponent(text),
    includes: parseIncludes(text)
  };
  fileCache.set(key, { stamp, entry });
  return entry;
}

/**
 * Collects the files included by a file, directly or through other includes.
 * @param entry File whose includes are followed.
 * @param depth Current nesting depth.
 * @param seen URIs already visited, to avoid cycles.
 * @returns The included files, in order of appearance.
 */
export async function includedEntries(
  entry: IndexEntry,
  depth = 0,
  seen: Set<string> = new Set([entry.uri.toString()])
): Promise<IndexEntry[]> {
  const out: IndexEntry[] = [];
  if (depth >= MAX_INCLUDE_DEPTH) { return out; }
  for (const ref of entry.includes ?? []) {
    const uri = await resolveInclude(ref, entry.uri);
    if (!uri || seen.has(uri.toString())) { continue; }
    seen.add(uri.toString());
    const included = await getFileEntry(uri);
    if (!included) { continue; }
    out.push(included, ...(await includedEntries(included, depth + 1, seen)));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Workspace CFC index
// ---------------------------------------------------------------------------
/** Index of the workspace CFC files, keyed by URI. It is exported for tests. */
export const index = new Map<string, IndexEntry>();
/** Promise of the first workspace scan. It is created lazily. */
let indexReady: Promise<unknown> | undefined;

/**
 * Parses a file and stores it in the index. The file is removed from the index if it cannot be read.
 * @param uri - The file to index.
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
 * Scans the workspace for .cfc files the first time the index is needed.
 * @returns A promise that resolves when the index is ready.
 */
function ensureIndex(): Promise<unknown> {
  indexReady ??= Promise.resolve(
    vscode.workspace.findFiles('**/*.cfc', '**/node_modules/**')
  ).then((uris: vscode.Uri[]) => Promise.all(uris.map(indexFile)));
  return indexReady;
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------
/**
 * Activates the extension: watches the .cfc files and registers the hover provider.
 * @param context - The extension context.
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
  /** Relative path of a file, for display. */
  const rel = (u: vscode.Uri) => vscode.workspace.asRelativePath(u);
  /** Sort order that puts the variables that have documentation first. */
  const byDoc = (a: VarInfo, b: VarInfo) => Number(!!b.doc) - Number(!!a.doc);

  context.subscriptions.push(
    vscode.languages.registerHoverProvider(selector, {
      /**
       * Provides the hover for the word under the cursor.
       * It tries, in order: components (new / extends), native tags and their attributes, scoped
       * variables, scope names, local variables and parameters, bare variables, tags and statements
       * in cfscript, user functions, inherited methods and, finally, native functions from CFDocs.
       * @param document - The document being edited.
       * @param position - The cursor position.
       * @returns The hover, or undefined when there is nothing to show.
       */
      async provideHover(document, position) {
        const lineText = document.lineAt(position.line).text;
        const text = document.getText();
        const funcs = parseFunctions(text);
        const vars = parseVariables(text);
        const current: IndexEntry = {
          uri: document.uri,
          funcs,
          vars,
          component: parseComponent(text),
          includes: parseIncludes(text)
        };

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

        // T) Native tags: <cfhttp ...> (tag name) and their attributes (method="get")
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

        // A) Scoped variable: arguments.x, local.x, variables.x, this.x, application.x ...
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

          // Variables defined in templates included by this file (include "a.cfm";)
          if (scope !== 'local') {
            for (const e of await includedEntries(current)) {
              const hits = e.vars.filter(v => varMatches(v, scope, word)).sort(byDoc);
              if (hits.length) {
                return new vscode.Hover(hits.slice(0, 3).map(v => toMarkdownVar(v, scope, rel(e.uri))), range);
              }
            }
          }

          // Fields inherited from base components (extends)
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

          // Shared scopes: they can be defined in another CFC (e.g. Application.cfc)
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

        // C) Bare identifier inside a function: parameter or local variable (var / local.x)
        if (!isCall && fn && !before.endsWith('.')) {
          const p = fn.args.find(a => a.name.toLowerCase() === word);
          if (p) { return new vscode.Hover(toMarkdownParam(fn, p), range); }

          const lv = localVarsOf(vars, fn).filter(v => varMatches(v, 'local', word)).sort(byDoc);
          if (lv.length) {
            return new vscode.Hover(toMarkdownVar(lv[0], lv[0].scope), range);
          }
        }

        // S) Scope name followed by "." or "[": url.x, form.x, cgi.x, session.x ...
        if (!isCall && !before.endsWith('.') && SCOPE_INFO.has(word) && /^\s*[.\[]/.test(lineText.slice(range.end.character))) {
          return new vscode.Hover(toMarkdownScope(word), range);
        }

        // D) Bare identifier: variable of the variables scope (<cfset page = ...>, page = ...;, property)
        if (!isCall && !before.endsWith('.')) {
          const own = vars
            .filter(v => v.kind !== 'var' && v.scope === 'variables' && v.name.toLowerCase() === word)
            .sort(byDoc);
          if (own.length) {
            return new vscode.Hover(own.slice(0, 3).map(v => toMarkdownVar(v, 'variables')), range);
          }
          for (const e of await includedEntries(current)) {
            const hits = e.vars
              .filter(v => v.kind !== 'var' && v.scope === 'variables' && v.name.toLowerCase() === word)
              .sort(byDoc);
            if (hits.length) {
              return new vscode.Hover(hits.slice(0, 3).map(v => toMarkdownVar(v, 'variables', rel(e.uri))), range);
            }
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

        // Functions defined in templates included by this file
        if (own && !isSuper) {
          const fromIncludes: vscode.MarkdownString[] = [];
          for (const e of await includedEntries(current)) {
            for (const f of e.funcs) {
              if (f.name.toLowerCase() === word) { fromIncludes.push(toMarkdown(f, rel(e.uri))); }
            }
          }
          if (fromIncludes.length) { return new vscode.Hover(fromIncludes.slice(0, 3), range); }
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

        // Any other CFC in the workspace with that method documented
        const found: vscode.MarkdownString[] = [];
        for (const { uri, funcs: fs } of index.values()) {
          for (const f of fs) {
            if (f.name.toLowerCase() === word && f.hasDoc) {
              found.push(toMarkdown(f, rel(uri)));
            }
          }
        }
        if (found.length) { return new vscode.Hover(found.slice(0, 5), range); }

        // Native CFML function (CFDocs): only if it is not a method of another object (obj.method())
        if (cfdocs.enabled && !before.endsWith('.') && !NOT_FUNCTIONS.has(word) && /^[a-z_]\w*$/.test(word)) {
          const e = await getCfDocs(word);
          if (e) { return new vscode.Hover(toMarkdownCfDocs(e, e.type === 'tag'), range); }
        }
        return undefined;
      }
    })
  );
}

/** Deactivates the extension. There is nothing to clean up: VS Code disposes the subscriptions. */
export function deactivate(): void {}