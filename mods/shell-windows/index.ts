// shell-windows -- one mod, one decision point, for Windows shell_command.
//
// The harness spawns cmd.exe on this machine. Two failure classes follow:
//   1. unix-style lines (ls, cat, grep, ...) die with
//        'ls' is not recognized as an internal or external command.
//   2. GBK-emitting native tools turn Chinese into U+FFFD, because the harness
//      decodes the child stream as UTF-8 (post-execution cannot fix that).
// One hook resolves BOTH in a single pass, per line:
//
//   a) leading bash/sh/zsh  ->  swap in the Git Bash path directly
//   b) already -EncodedCommand  ->  decode, try to route, re-encode in place
//   c) bash-routable (any unix tool in the line)  ->  run inside Git Bash;
//      bash itself emits UTF-8, so no encoding layer is needed here. Bash-routed
//      lines that still contain `%` re-enter -EncodedCommand packaging (cmd.exe
//      expands %VAR% even inside quoted args); the payload is decoded AFTER
//      cmd's parse layer.
//   d) everything else (pure cmd)  ->  wrap in `powershell -EncodedCommand`
//      whose payload re-enters cmd with console CP 65001. UTF-8 tools
//      (git/node/python/rg/...) skip the wrap: nothing to fix, +0ms.
//
// Order-independence between the old shell-bash and shell-utf8 mods is gone by
// construction: there is no second mod to negotiate with.
//
// Routing details (unchanged from shell-bash, all checks dynamic):
//   * split into top-level segments (&& || ; | &), assignments kept;
//   * cmd builtins map to bash equivalents per BUILTIN_FIXERS
//     (dir/type/copy/del/move/ren/md/rd/where/set/...; some keep native flags
//     via an inner `cmd /c ...` delegation);
//   * segments whose head resolves on PATH stay native as-is (this MSYS hands
//     `/c /i /mir`-style flags through untouched; doubling them is what breaks).
//   * remaining segments (ls, grep, ...) pass through; >=1 -> line routes.
//   * `2>&1`-style redirects survive (the `&` after `>` is not an operator);
//   * cmd's bare `a & b` maps to bash `a ; b` (sequential), not background;
//   * `2>nul` / `>nul` / `<nul` map to /dev/null -- a literal `nul` target
//     would create a reserved-name file bash then treats as real;
//   * %VAR% / %ERRORLEVEL% / %CD% -> $VAR / $? / $PWD, C:\a\b -> C:/a/b.
// Deliberately NOT translated (fail loudly, honest intent): goto, label,
// flag-bearing if/for nesting, else-chains, set /a, delayed expansion,
// mklink /j. Simple if/for shapes ARE handled.

import {existsSync} from 'fs';
import type {ModApi} from '@commandcode/harness';

const IS_WINDOWS = process.platform === 'win32';

const BASH_CANDIDATES = [
  process.env.SCOOP && `${process.env.SCOOP}\\apps\\git\\current\\bin\\bash.exe`,
  process.env.USERPROFILE && `${process.env.USERPROFILE}\\scoop\\apps\\git\\current\\bin\\bash.exe`,
  process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}\\scoop\\apps\\git\\current\\bin\\bash.exe`,
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
].filter((p): p is string => Boolean(p));

const BASH_LAUNCHERS = new Set(['bash', 'sh', 'zsh']);

// cmd.exe builtins that are translatable AND where native behavior is not
// acceptable. Absent == bail loudly (_if/for/goto/mklink/label/verify_).
const BUILTIN_FIXERS: Record<string, (t: string[]) => string[] | null> = {
  '@echo': (t) => [':'],
  cd: (t) => {
    const rest = t.slice(1).filter((x) => x.toLowerCase() !== '/d');
    return ['cd', ...rest];
  },
  chdir: (t) => {
    const rest = t.slice(1).filter((x) => x.toLowerCase() !== '/d');
    return ['cd', ...rest];
  },
  cls: (t) => (t.length === 1 ? ['clear'] : null),
  copy: (t) => fixWithFlags(t, ['cp'], {'/y': '-f'}),
  del: (t) => fixWithFlags(t, ['rm', '-f'], {'/f': '', '/q': '', '/s': '-r'}),
  erase: (t) => fixWithFlags(t, ['rm', '-f'], {'/f': '', '/q': '', '/s': '-r'}),
  dir: (t) => ['cmd', '/c', ...t],                 // keep native flags exact
  echo: (t) => t,                                   // bash echo is close enough
  exit: (t) => {
    const rest = t.slice(1).filter((x) => x.toLowerCase() !== '/b');
    return rest.some((x) => x.startsWith('/')) ? null : ['exit', ...rest];
  },
  call: (t) => (t.length > 1 && !t[1]!.startsWith(':') ? t.slice(1) : null),
  md: (t) => fixWithFlags(t, ['mkdir'], {}),
  mkdir: (t) => fixWithFlags(t, ['mkdir'], {}),
  move: (t) => fixWithFlags(t, ['mv'], {'/y': '-f'}),
  ren: (t) => (t.length === 3 ? ['mv', t[1]!, t[2]!] : null),
  rename: (t) => (t.length === 3 ? ['mv', t[1]!, t[2]!] : null),
  rd: (t) => rdRmdir(t),
  rmdir: (t) => rdRmdir(t),
  rem: (t) => [':', ...t.slice(1)],
  set: (t) => {
    const body = t.slice(1);
    if (!body.length) return ['cmd', '/c', 'set'];
    if (body.length === 1) {
      const v = body[0]!;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(v)) return ['export', v];
      return ['cmd', '/c', 'set', v];
    }
    return null;
  },
  setlocal: (t) => [':'],
  endlocal: (t) => [':'],
  shift: (t) => [':'],
  prompt: (t) => [':'],
  start: (t) => ['cmd', '/c', ...t],
  title: (t) => ['cmd', '/c', ...t],
  color: (t) => ['cmd', '/c', ...t],
  verify: (t) => ['true'],
  mklink: (t) => {
    const body: string[] = [];
    let hard = false;
    for (const tok of t.slice(1)) {
      const lower = tok.toLowerCase();
      if (lower === '/h') hard = true;
      else if (lower === '/d') continue; // dir symlink == plain symlink in bash
      else if (lower.startsWith('/')) return null; // /j junction has no faithful form
      else body.push(tok);
    }
    if (body.length !== 2) return null;
    // mklink LINK TARGET vs ln -s TARGET LINK: arg order is reversed
    return hard ? ['ln', body[1]!, body[0]!] : ['ln', '-s', body[1]!, body[0]!];
  },
  for: (t) => {
    if ((t[1] ?? '').startsWith('/')) return null; // /L /R /D /F: bail loudly
    const seg = t.join(' ');
    const m = /^for\s+%([A-Za-z])\s+in\s+\(([^()]*)\)\s+do\s+([\s\S]+)$/.exec(seg);
    if (!m) return null;
    const list = m[2]!.replace(/[\s,;]+/g, ' ').trim();
    const v = m[1]!.toLowerCase();
    if (!list) return null;
    // cmd betrays the loop var as %i; bash uses $i
    const body = m[3]!.replace(/%([A-Za-z])/g, (_x, c: string) => `$${c.toLowerCase()}`);
    if (NEW_NESTED_RE.test(body)) return null;
    return [`for ${v} in ${list}; do ${body}; done`];
  },
  if: (t) => {
    const seg = t.join(' ');
    if ((t[1] ?? '').toLowerCase() === '/i') return null; // case-fold: no faithful map
    const nest = (body: string) => NEW_NESTED_RE.test(body) || /\belse\b/i.test(body) ? null : body;
    const me = /^if\s+(not\s+)?exist\s+(\S+)\s+([\s\S]+)$/i.exec(seg);
    if (me) {
      const body = nest(me[3]!);
      if (body === null) return null;
      return [`if [ ${me[1] ? '! ' : ''}-e ${me[2]!} ]; then ${body}; fi`];
    }
    const me2 = /^if\s+(not\s+)?errorlevel\s+(\d+)\s+([\s\S]+)$/i.exec(seg);
    if (me2) {
      const body = nest(me2[3]!);
      if (body === null) return null;
      return [`if [ $? ${me2[1] ? '-lt' : '-ge'} ${me2[2]!} ]; then ${body}; fi`];
    }
    const mq = /^if\s+(not\s+)?(.+?)\s*==(.+?)\s+([\s\S]+)$/s.exec(seg);
    if (!mq) return null;
    const body = nest(mq[4]!);
    if (body === null) return null;
    const lhs = cmdSideToBash(mq[2]!);
    const rhs = cmdSideToBash(mq[3]!);
    if (!lhs || !rhs) return null;
    return [`if [ ${lhs} ${mq[1] ? '!=' : '='} ${rhs} ]; then ${body}; fi`];
  },
  type: (t) => (t.length === 2 ? ['cat', t[1]!] : null),
  where: (t) => fixWithFlags(t, ['which'], {}),
  ver: (t) => (t.length === 1 ? ['cmd', '/c', 'ver'] : null),
  vol: (t) => (t.length === 1 ? ['cmd', '/c', 'vol'] : null),
  path: (t) => ['cmd', '/c', ...t],
  date: (t) => (t.length === 1 ? t : ['cmd', '/c', ...t]),
  time: (t) => (t.length === 1 ? t : ['cmd', '/c', ...t]),
};

// cmd syntax with no faithful bash form: leave the whole line alone.
const BAIL_HEADS = new Set(['goto', 'label']);

// cmd.exe command line caps at 8191 chars; stay well under it.
const MAX_ROUTE = 7000;

// base64(utf16le) is ~2.67x script length; the Windows command line caps at
// 8191, keep a wide margin on the pure-cmd wrap path.
const MAX_WRAP = 1800;

// Agent workhorses that already emit UTF-8. Verified: python 3.15 ships PEP 686
// UTF-8 mode on by default (enc=utf-8, utf8mode=1), so skipping it is correct.
// If a pre-3.15 venv ever appears, prefer prefixing
//   set "PYTHONIOENCODING=utf-8" &&
// (measured: +0ms) over removing python from this list.
const SKIP_UTF8 =
  /^\s*(git|node|npm|npx|pnpm|yarn|bun|deno|python|python3|py|pip|pip3|uv|ruff|rg|fd|jq|curl|wget|ssh|scp|docker|kubectl|gh|cargo|go|make|cmake|bash|sh|zsh|tar|gzip|7z)\b/i;

function rdRmdir(t: string[]): string[] | null {
  const body: string[] = [];
  let rdS = false;
  for (const tok of t.slice(1)) {
    const lower = tok.toLowerCase();
    if (lower.startsWith('/')) {
      if (lower === '/s') rdS = true;
      else if (lower === '/q') continue;
      else return null;
    } else body.push(tok);
  }
  return rdS ? ['rm', '-rf', ...body] : ['rmdir', ...body];
}

// Nested if/for/goto beyond the simple shapes cannot be tokenized faithfully.
const NEW_NESTED_RE = /(^|\s)(if|for|goto|mklink)\b/i;

function cmdSideToBash(side: string): string | null {
  const bare = side.replace(/^"+|"+$/g, '');
  if (/%[A-Za-z_][A-Za-z0-9_]*%/.test(bare)) return `"${mapPercentVars(bare)}"`;
  if (bare.includes("'") || bare.includes('"')) return null;
  return `'${bare}'`;
}

function fixWithFlags(
  t: string[],
  base: string[],
  flagMap: Record<string, string | ''>,
): string[] | null {
  const flags: string[] = [];
  const body: string[] = [];
  for (const tok of t.slice(1)) {
    const lower = tok.toLowerCase();
    if (lower.startsWith('/')) {
      if (!(lower in flagMap)) return null;
      if (flagMap[lower]) flags.push(flagMap[lower]!);
    } else body.push(tok);
  }
  return [...base, ...flags, ...body];
}

// Top-level split preserving the operator text for faithful reassembly.
type Part = {text: string; op: string | null};

function splitTopLevel(command: string): Part[] {
  const items: Part[] = [];
  let cur = '';
  let op: string | null = null;
  let quote: string | null = null;
  const flush = (withOp: boolean) => {
    if (cur.trim()) items.push({text: cur, op: withOp ? op : null});
    cur = '';
    op = null;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if ((c === '&' || c === '|') && command[i + 1] === c) {
      flush(op !== null);
      op = c + c!;
      i++;
      while (command[i + 1] === ' ' || command[i + 1] === '\t') op += command[++i]!;
      continue;
    }
    if (c === ';' || c === '&' || c === '|') {
      // `2>&1` / `>&2`: the `&` after `>` duplicates descriptors, not an
      // operator -- keep it inside the segment (measured: splitting it made a
      // live session fail with "syntax error near unexpected token &").
      if (c === '&' && cur.endsWith('>')) {
        cur += c;
        continue;
      }
      flush(op !== null);
      // cmd's bare `a & b` runs a THEN b regardless of status; bash `a & b`
      // would BACKGROUND a. `;` is the faithful sequential spelling.
      op = c === '&' ? ';' : c;
      while (command[i + 1] === ' ' || command[i + 1] === '\t') op += command[++i]!;
      continue;
    }
    cur += c;
  }
  flush(op !== null);
  return items;
}

// Respect quotes: returns untouched tokens (quotes kept where present).
function tokensOf(text: string): string[] {
  const toks: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (const c of text) {
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === ' ' || c === '\t') {
      if (cur) toks.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur) toks.push(cur);
  return toks;
}

// Split leading FOO=bar env assignments (bash style is already portable).
function extractAssignments(text: string): {pre: string; rest: string} {
  let rest = text;
  let pre = '';
  for (;;) {
    const m = rest.match(
      /^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+/,
    );
    if (!m) return {pre, rest};
    pre += m[0];
    rest = rest.slice(m[0].length);
  }
}

// Does cmd.exe see `name` as an executable? (only PATH + PATHEXT, current env)
function resolveOnPath(name: string): boolean {
  if (!name) return false;
  if (name.includes('/') || name.includes('\\')) return existsSync(name);
  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';').map((e) => e.toLowerCase());
  for (const dir of (process.env.PATH ?? '').split(';').filter(Boolean)) {
    const base = dir.replace(/[\\]+$/, '');
    if (existsSync(`${base}\\${name}`)) return true;
    for (const ext of exts) if (existsSync(`${base}\\${name}${ext}`)) return true;
  }
  return false;
}

// (shieldFlags removed empirically: this MSYS (Git for Windows, msys 3.x)
// passes `/c` `/i` `/mir`-style bare flags to native exes untouched, while
// the doubled `//c` reaches cmd.exe literally and starts an interactive cmd
// -- findstr even reports "FINDSTR: // ignored". Measurements 2026-10-30.)

function mapPercentVars(s: string): string {
  return s
    .replace(/%ERRORLEVEL%/gi, '$?')
    .replace(/%CD%/gi, '$PWD')
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_m, v: string) => `$${v}`);
}

// cmd discards bytes with 2>nul / >nul / <nul. In bash a literal `nul` target
// creates a real file named `nul` -- a reserved Windows device name, so the
// file resists normal deletion. Redirect to where bash actually discards.
function mapNulTargets(s: string): string {
  return s
    .replace(/([0-2]?>+|<)\s*nul\b/gi, (_m, redir: string) => `${redir} /dev/null`);
}

function convertBackslashPaths(s: string): string {
  // quoted first: "C:\Users\artin\Sync" -> "C:/Users/artin/Sync"
  s = s.replace(
    /"([A-Za-z]:)([^"\\]*\\[^"]*)"/g,
    (_m, drive: string, tail: string) => `"${drive}${tail.replace(/\\/g, '/')}"`,
  );
  // bare: C:\Users\artin\Sync -> C:/Users/artin/Sync; bare root C:\ -> C:/
  s = s.replace(
    /([A-Za-z]):((?:\\[^\s"')]*)+)/g,
    (_m, drive: string, tail: string) => `${drive}:${tail.replace(/\\/g, '/')}`,
  );
  return s;
}

// Returns the bash-wrapped line, or null when the command is not bash-routable.
function buildRouted(command: string): string | null {
  if (!command.trim()) return null;
  const items = splitTopLevel(command);
  if (!items.length) return null;

  let unixCount = 0;
  const built: string[] = [];
  for (const [i, item] of items.entries()) {
    const {pre, rest} = extractAssignments(item.text);
    const toks = tokensOf(rest);
    const head = (toks[0] ?? '').toLowerCase().replace(/\.exe$/, '');
    let piece: string;
    if (Object.prototype.hasOwnProperty.call(BUILTIN_FIXERS, head)) {
      const out = BUILTIN_FIXERS[head]!(toks);
      if (!out) return null;
      piece = pre + out.join(' ');
    } else if (BAIL_HEADS.has(head)) {
      return null;
    } else if (resolveOnPath(head)) {
      piece = pre + rest;
    } else {
      unixCount++;
      piece = (pre + rest).trimEnd();
    }
    built.push(piece);
  }
  if (!unixCount) return null; // pure cmd-native: not bash's business

  let rebuilt = built[0] ?? '';
  for (let k = 1; k < items.length; k++) {
    rebuilt += ` ${(items[k]!.op ?? '').trim().replace(/\s+/g, ' ')} ${built[k]}`;
  }
  const transformed =
    convertBackslashPaths(mapNulTargets(mapPercentVars(rebuilt)));
  // Double quotes are the only grouping cmd.exe honors across the argv handoff
  // to bash (single quotes remain literal to Windows, tearing argv apart);
  // inner double quotes are escaped so the script text survives verbatim.
  const direct = `"${BASH_WRAP_BASH}" -c "${transformed.replace(/"/g, '\\"')}"`;
  if (!transformed.includes('%')) return direct;
  // Residual quirk: cmd.exe expands %VAR% even inside quoted args. Wrap the
  // routed line in its own EncodedCommand so the payload is seen AFTER cmd's
  // parse layer, untouched; this also lifts the cheap-path length limit here,
  // per-route (measured: without `&` the payload is a PS ParserError, and a
  // file named `nul` used to appear in the project directory from `2>nul`).
  const script =
    'try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}; ' +
    // `&` required: a quoted path opens a PS expression pipeline, so `-c` that
    // follows would be an UnexpectedToken.
    `& '${BASH_WRAP_BASH}' -c '${transformed.replace(/'/g, "''")}'; exit $LASTEXITCODE`;
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  if (encoded.length > 8000) return direct; // cmd line cap: fall back to direct
  return `powershell -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}

const toB64 = (s: string): string => Buffer.from(s, 'utf16le').toString('base64');

// Pure-cmd UTF-8 fix: the wrapper sets ITS OWN console output code page to
// 65001, then spawns cmd.exe. cmd reads the code page when it starts, so its
// output (MUI strings, echo, Chinese filenames) arrives as valid UTF-8.
// Without the trailing `exit $LASTEXITCODE` the wrapper always exits 0 and
// every failure looks like success (measured: exit /b 7 came back as 1).
function wrapCommand(command: string): string {
  const escaped = command.replace(/'/g, "''"); // PowerShell single-quote escape
  const script =
    'try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}; ' +
    // The original command still runs inside cmd, so &&, |, >, %VAR% all keep
    // working; only which console it was born in changed.
    `cmd /d /s /c '${escaped}'; ` +
    'exit $LASTEXITCODE';
  return `powershell -NoLogo -NoProfile -NonInteractive -EncodedCommand ${toB64(script)}`;
}

let BASH_WRAP_BASH = ''; // set in default export; declared here for buildRouted

export default function (api: ModApi): void {
  if (!IS_WINDOWS) return;
  const bash = BASH_CANDIDATES.find((p) => existsSync(p));
  if (!bash) return; // no Git Bash on disk: mod stays inert
  BASH_WRAP_BASH = bash;
  const oursPrefix = `"${bash}" `;

  api.hooks({
    beforeToolCall: ({toolName, input}) => {
      if (toolName !== 'shell_command') return undefined;
      const command = typeof input?.command === 'string' ? input.command : '';
      if (!command.trim()) return undefined;
      if (command.startsWith(oursPrefix)) return undefined; // already routed

      const trimmed = command.trim();
      const head0 = trimmed.split(/\s+/)[0]!.toLowerCase().replace(/\.exe$/, '');
      if (BASH_LAUNCHERS.has(head0)) {
        // Keeps args; stops `bash` resolving to the WSL stub in System32.
        return {input: {...input, command: `"${bash}"` + trimmed.slice(head0.length)}};
      }

      // Route inside an existing EncodedCommand wrapper (covers agents that
      // hand-write powershell one-liners too): decode, reroute, re-encode.
      const encIdx = command.toLowerCase().indexOf('-encodedcommand');
      if (encIdx >= 0) {
        const payload = command.slice(encIdx + '-encodedcommand'.length).trim();
        const decoded = Buffer.from(payload.replace(/["']/g, ''), 'base64').toString('utf16le');
        const routed = buildRouted(decoded);
        if (!routed) return undefined; // stays a cmd one-liner inside PS
        const reencoded = toB64(routed);
        return {input: {...input, command: command.slice(0, encIdx) + `-EncodedCommand ${reencoded}`}};
      }

      // bash route: single-line, within the cmd.exe argv cap only.
      const routeable = command.length <= MAX_ROUTE && !/[\r\n]/.test(command);
      if (routeable) {
        const routed = buildRouted(command);
        if (routed) return {input: {...input, command: routed}};
      }

      // Pure cmd: fix the code page unless the tool already speaks UTF-8.
      if (SKIP_UTF8.test(command)) return undefined;
      if (command.length > MAX_WRAP) return undefined;
      return {input: {...input, command: wrapCommand(command)}};
    },
  });
}
