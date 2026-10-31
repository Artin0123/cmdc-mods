// shell-windows -- one mod, one decision point, for Windows shell_command +
// powershell.
//
// The harness spawns cmd.exe on this machine. Failure classes and the fixes:
//   1. unix-style lines (ls, cat, grep, ...) die under cmd.exe
//        -> route the line into Git Bash (see Routing below).
//   2. GBK-emitting native tools turn Chinese into U+FFFD, because the harness
//      decodes the child stream as UTF-8 (post-execution cannot fix that)
//      -> pure-cmd lines wrap in `powershell -EncodedCommand` whose payload
//      re-enters cmd with console CP 65001.
//   3. cmd.exe mangles payloads on the `"bash" -c "..."` argv handoff: it
//      toggles quoting at every raw `"` (backslash escapes are bash-side
//      only, so `\"` exposes the payload's && | < > to cmd), expands %VAR%
//      even inside quotes, and $() / backticks only survive after cmd's
//      parse layer
//      -> any payload carrying ", %, $( or ` ships as a temp script
//      (cc-bash-*.sh under TEMP) and the command becomes
//      `"bash.exe" "<script>"`: bash reads the file AFTER cmd's parse layer,
//      bytes intact. This replaces the older EncodedCommand packaging and
//      also lifts its ~2.7KB payload ceiling (a file path has no argv cap).
//   4. cmd.exe runs only the FIRST line of a multiline command (LF and CRLF
//      alike, even inside the UTF-8 wrapper) -> multiline commands route per
//      line into one temp script (heredoc bodies stay verbatim); pure-cmd
//      multiline joins its lines with `& ` inside the wrapper.
//   5. `cmd //c` (MSYS doubling habit) reaches cmd.exe literally and starts
//      an interactive cmd (banner + prompt, command never runs) -> doubled
//      flags normalize to their single-slash form. GATED on a one-time probe
//      of the real bash environment (MSYS_NO_PATHCONV): with path conversion
//      on, `//c` is the spelling that works and rewriting it would BE the
//      side effect, so nothing is touched unless conversion is actually off.
//      A failed probe also disables the rewrite (uncertainty never enables
//      side effects; the un-fixed failure is loud and /c works everywhere).
//   6. the harness's powershell tool appends the progress stream to every
//      call as CLIXML XML noise -> `$ProgressPreference='SilentlyContinue'`
//      is prepended (measured: noise gone). ParserError text is emitted
//      before any script runs and stays GBK-garbled; unfixable here.
//   7. file tools (write/edit/read/...) resolve paths host-side: /tmp never
//      passes through MSYS, so write_file('/tmp/x') lands in C:\tmp
//      (measured) and $TEMP/... is rejected -> those forms rewrite to the
//      real temp directory, keeping file tools consistent with bash's /tmp.
//   8. &>nul / &>>nul / >&nul are bash-only spellings that measured WORSE
//      than >nul: they create a real, near-unerasable `nul` file and exit 0
//      -> all nul-target redirects (quoted forms too) map to /dev/null;
//      2>&nul / <&nul are loud ambiguous redirects and stay untouched.
//   9. nested command substitutions run inside bash too: `$(cmd //c ver)`
//      with MSYS_NO_PATHCONV=1 (this machine's bashrc) starts an interactive
//      cmd -- measured: GBK banner, exit 0, command never ran -> a
//      command-position-aware scan fixes //c|//k inside $( ), backticks and
//      double quotes (single quotes stay literal), including the tight
//      `cmd//c` form; `echo cmd //c` (data position) is not touched.
//      os.tmpdir() is guarded against MSYS-mapped TEMP values ("/tmp").
//
// Scope and priority: NATIVE EXECUTION WINS. Anything that fails -- or
// misbehaves -- under its own native execution is left loud and untouched:
// agent errors, wrong-shell syntax, and silent failures native execution
// would produce anyway are not this mod's business. "Silent failure must be
// fixed" is subordinate to that rule; silence alone never justifies a fix.
// Everything below repairs breakage THIS environment's tooling inflicts, in
// exactly three classes:
//   * posix/linux syntax the harness's cmd.exe layer breaks -- multiline
//     truncation, quote-toggle argv tearing, host-side /tmp file tools, GBK
//     console output, CLIXML noise, ASCII $OutputEncoding;
//   * git-bash + windows turning normal Linux behavior into a pathological
//     artifact -- reserved-name `nul` redirect targets that exit 0 and resist
//     deletion;
//   * default-MSYS spelling broken by MSYS_NO_PATHCONV=1 (//c interactive
//     cmd) -- gated on a probe of the actual setting, never hardcoded.
// Deliberate external shells (powershell in any form, other shells) are
// HANDS-OFF. When the agent itself invokes powershell (any form) or another
// shell, the mod does not touch the command: valid payloads must keep
// running as the agent chose (rerouting `gci | sort` into bash would break a
// working command), and invalid ones fail loudly for self-correction. Only
// ENVIRONMENT-level defects get fixed around them: the code page wrapper for
// cmd children, the CLIXML noise and ASCII $OutputEncoding for the
// powershell tool, and the WSL `bash` stub. Commands that fail on their own
// (agent errors) are left loud.
//
// Routing details (all checks dynamic):
//   * split into top-level segments (&& || ; | &), assignments kept;
//   * cmd builtins map to bash equivalents per BUILTIN_FIXERS
//     (dir/type/copy/del/move/ren/md/rd/where/set/...; some keep native flags
//     via an inner `cmd /c ...` delegation);
//   * segments whose head resolves on PATH stay native as-is (this MSYS hands
//     `/c /i /mir`-style flags through untouched; doubling them is what
//     breaks). A unix-style absolute path in the args (`cd /c/x`,
//     `echo hi > /tmp/f`) forces the bash route regardless: cmd cannot use
//     those paths ("The system cannot find the path specified");
//   * remaining segments (ls, grep, ...) pass through; >=1 -> line routes.
//     A cmd-hostile char counts as bash intent too: `echo 'a'"b"'c'` under
//     cmd prints the quotes literally, under bash it prints abc;
//   * `2>&1`-style redirects survive (the `&` after `>` is not an operator);
//   * cmd's bare `a & b` maps to bash `a ; b` (sequential), not background;
//   * `2>nul` / `>nul` / `<nul` map to /dev/null -- a literal `nul` target
//     would create a reserved-name file bash then treats as real;
//   * %VAR% / %ERRORLEVEL% / %CD% -> $VAR / $? / $PWD, C:\a\b -> C:/a/b.
//   * heredoc bodies (lines between `<<DELIM` and `DELIM`) are shipped
//     verbatim: no var mapping, no path conversion, no builtin fixing.
// Deliberately NOT translated (fail loudly, honest intent): goto, label,
// flag-bearing if/for nesting, else-chains, set /a, delayed expansion,
// mklink /j. Simple if/for shapes ARE handled.

import {existsSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync} from 'fs';
import {homedir, tmpdir} from 'os';
import {dirname, join} from 'path';
import {randomBytes} from 'crypto';
import {spawnSync} from 'child_process';
import type {ModApi} from '@commandcode/harness';

const IS_WINDOWS = process.platform === 'win32';

// bash.exe location: detected, never guessed. Scan order: PATH (skipping the
// WSL launcher stub in System32), then derived from git.exe's install root
// (scoop shims resolved via the sibling git.shim), then the Git for Windows
// registry key, then env-derived program roots. There is deliberately NO
// package-manager enumeration: winget, chocolatey, Ninite and friends all
// either put git on PATH or run the same installer that registers
// HKLM/HKCU\SOFTWARE\GitForWindows -- both are already covered. Every
// candidate must answer `uname -s` with an MSYS/MINGW prefix (Git for
// Windows' bash reports OSTYPE "cygwin", so OSTYPE cannot discriminate; WSL
// answers "Linux", Cygwin "CYGWIN_NT-*") -- a non-MSYS bash would silently
// break the routed commands' MSYS assumptions (/c/..., /dev/null, ...) and
// must never be picked. An undetectable bash leaves the mod inert.
const GIT_REG_KEYS = [
  'HKLM\\SOFTWARE\\GitForWindows',
  'HKLM\\SOFTWARE\\WOW6432Node\\GitForWindows',
  'HKCU\\SOFTWARE\\GitForWindows',
];

// Installer-based installs register their root; env-derived program roots
// cover registry-less user-scope installs. Nothing here is a machine path.
function extraBashRoots(): string[] {
  const roots = registryBashRoots();
  const envRoots = [
    process.env.ProgramFiles && `${process.env.ProgramFiles}\\Git`,
    process.env['ProgramFiles(x86)'] && `${process.env['ProgramFiles(x86)']}\\Git`,
    process.env.LocalAppData && `${process.env.LocalAppData}\\Programs\\Git`,
  ].filter((p): p is string => Boolean(p));
  return [...roots, ...envRoots];
}

function registryBashRoots(): string[] {
  const roots: string[] = [];
  for (const key of GIT_REG_KEYS) {
    try {
      const p = spawnSync('reg', ['query', key, '/v', 'InstallPath'], {
        windowsHide: true,
        timeout: 5000,
      });
      const m = /InstallPath\s+REG_SZ\s+(.+)/i.exec(p.stdout?.toString() ?? '');
      if (m) roots.push(m[1]!.trim());
    } catch { /* key absent or reg unavailable */ }
  }
  return roots;
}

function bashCandidateList(): string[] {
  const list: string[] = [];
  const seen = new Set<string>();
  const push = (p: string) => {
    const k = p.toLowerCase();
    if (p && !seen.has(k)) {
      seen.add(k);
      list.push(p);
    }
  };
  // one pass: every PATH dir may hold a bash.exe directly, or a git.exe to
  // derive the install root from. This is generic -- `C:\Program Files\Git`
  // (winget/choco/Ninite all add Git\cmd to PATH) is covered by the same
  // loop as any other install, not specially cased.
  for (const dir of (process.env.PATH ?? '').split(';').filter(Boolean)) {
    const base = dir.replace(/[\\]+$/, '');
    if (/\\System32(\\|$)/i.test(base)) continue; // WSL launcher stub lives here
    push(`${base}\\bash.exe`);
    const git = `${base}\\git.exe`;
    if (!existsSync(git)) continue;
    let root = dirname(git);
    // scoop shim: the shim exe merely forwards; the real git.exe path lives
    // in the sibling git.shim (`path = "..."`, value may be quoted). scoop
    // needs this branch because it neither puts bash.exe on PATH nor writes
    // the registry -- the shim is the only trail. winget/choco/Ninite do not
    // need it: their git.exe on PATH IS the real one.
    const shim = `${root}\\git.shim`;
    if (existsSync(shim)) {
      const m = /^path\s*=\s*(.+)$/im.exec(readFileSync(shim, 'utf8'));
      if (m) root = dirname(m[1]!.trim().replace(/^"+|"+$/g, ''));
    }
    push(join(dirname(root), 'usr', 'bin', 'bash.exe'));
    push(join(dirname(root), 'bin', 'bash.exe'));
  }
  for (const root of extraBashRoots()) {
    push(join(root, 'usr', 'bin', 'bash.exe'));
    push(join(root, 'bin', 'bash.exe'));
  }
  return list;
}

// Every candidate must answer `uname -s` with an MSYS/MINGW prefix (measured
// on this machine: "MINGW64_NT-..."). OSTYPE is useless here -- Git for
// Windows' bash reports "cygwin" (MSYS2 heritage). The prefix check is the
// real discriminator: WSL answers "Linux", Cygwin answers "CYGWIN_NT-*" --
// and both would silently break the routed commands' MSYS assumptions
// (/c/..., /dev/null, ...). A non-MSYS bash must never be picked.
function isMsysBash(path: string): boolean {
  try {
    const p = spawnSync(path, ['-c', 'uname -s'], {
      windowsHide: true,
      timeout: 5000,
    });
    return /^(MINGW|MSYS)/i.test(p.stdout?.toString().trim() ?? '');
  } catch {
    return false;
  }
}

// Exported for tests: which bash the mod actually committed to.
export function detectedBashPath(): string {
  return BASH_WRAP_BASH;
}

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

// Sanity cap on routed commands (the temp-script path itself has no argv
// cap; this only keeps absurd inputs out of the router).
const MAX_ROUTE = 7000;

// base64(utf16le) is ~2.67x script length; the Windows command line caps at
// 8191, keep a wide margin on the pure-cmd wrap path.
const MAX_WRAP = 1800;

// Performance allowlist, NOT a correctness list: pure-cmd lines whose head
// already speaks UTF-8 skip the powershell wrap (+0ms, they run constantly).
// The direction is fail-safe -- a missing entry only costs one unnecessary
// wrap (the UTF-8 tool still emits correct bytes under the 65001 console);
// the inverse design ("wrap only GBK tools") would silently corrupt output
// for every unlisted tool. Verified: python 3.15 ships PEP 686 UTF-8 mode on
// by default (enc=utf-8, utf8mode=1), so skipping it is correct. If a
// pre-3.15 venv ever appears, prefer prefixing
//   set "PYTHONIOENCODING=utf-8" &&
// (measured: +0ms) over removing python from this list.
const SKIP_UTF8 =
  /^\s*(git|node|npm|npx|pnpm|yarn|bun|deno|python|python3|py|pip|pip3|uv|ruff|rg|fd|jq|curl|wget|ssh|scp|docker|kubectl|gh|cargo|go|make|cmake|bash|sh|zsh|tar|gzip|7z)\b/i;

// Payload characters cmd.exe mangles on the inline `"bash" -c "..."` handoff:
// `"` (cmd toggles at every raw quote), `%` (expands even inside quotes),
// `$(` and backticks (only safe after cmd's parse layer). Any of these ships
// the payload as a temp script instead.
const CMD_HOSTILE = /["%]|\$\(|`/;

// A unix-style absolute path (a token with two or more slashes). cmd-native
// heads carrying one (`cd /c/x`, `echo hi > /tmp/f`) can only run under MSYS.
// cmd switches never contain a second slash, so `dir /b` stays native.
const UNIX_PATH_RE = /(?:^|\s)\/[^\s"']+\//;

// Temp scripts shipped for cmd-hostile payloads.
const TEMP_PREFIX = 'cc-bash-';

// The directory bash's /tmp actually maps to -- the anchor that keeps file
// tools and routed commands looking at the SAME temp files. Asked from the
// detected bash itself (cygpath -w /tmp), because a custom msys fstab can
// mount /tmp anywhere; assuming the standard AppData layout would silently
// disagree with bash on such machines. Fallbacks: os.tmpdir() when it is a
// real drive path, then the canonical user temp under homedir().
let bashTmp: string | null = null;
let bashTmpProbed = false;

function realTempDir(): string {
  if (!bashTmpProbed) {
    bashTmpProbed = true;
    try {
      if (BASH_WRAP_BASH) {
        const p = spawnSync(BASH_WRAP_BASH, ['-c', 'cygpath -w /tmp'], {
          windowsHide: true,
          timeout: 5000,
        });
        const out = p.stdout?.toString().trim() ?? '';
        if (!p.error && /^[A-Za-z]:[\\/]/.test(out)) bashTmp = out;
      }
    } catch { /* fallbacks below */ }
  }
  if (bashTmp) return bashTmp;
  const t = tmpdir();
  if (/^[A-Za-z]:[\\/]/.test(t)) return t;
  // canonical Windows user temp; only reached when TEMP itself was an
  // MSYS-mapped value like "/tmp" and cygpath could not be asked.
  return join(homedir(), 'AppData', 'Local', 'Temp');
}

// File tools resolve paths host-side: /tmp never passes through MSYS, so
// write_file('/tmp/x') lands in C:\tmp (measured), $TEMP/... is rejected as
// non-absolute, and a literal "$TEMP" folder has happened before. Rewrite the
// forms that mean "the temp directory" to the real one so file tools agree
// with bash's /tmp. Everything else -- relative paths, other drives -- stays.
export function rewriteTempPath(p: string): string {
  const lower = p.toLowerCase();
  const norm = (rest: string) => realTempDir() + rest.replace(/\//g, '\\');
  if (p === '/tmp' || p.startsWith('/tmp/')) return norm(p.slice(4));
  if (p === '$TEMP' || p.startsWith('$TEMP/')) return norm(p.slice(5));
  if (p === '$TMP' || p.startsWith('$TMP/')) return norm(p.slice(4));
  if (lower === 'c:/tmp' || lower.startsWith('c:/tmp/')) return norm(p.slice(6));
  if (lower === 'c:\\tmp' || lower.startsWith('c:\\tmp\\')) return norm(p.slice(6));
  return p;
}

// Harness API contract (there is no discovery API on the hook): which tools
// take filesystem paths and under which input keys. Missing an entry fails
// safe -- that tool's /tmp paths simply stay unwritten, i.e. today's behavior.
const PATH_TOOLS = new Set(['write_file', 'edit_file', 'read_file', 'read_directory', 'glob', 'grep']);
const PATH_KEYS = ['file_path', 'path'];

function rdRmdir(t: string[]): string[] | null {
  const body: string[] = [];
  let rdS = false;
  for (const tok of t.slice(1)) {
    if (looksLikeFlag(tok)) {
      const lower = tok.toLowerCase();
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

// `/x` is a cmd flag; `/x/y` (two slashes) can only be a path -- fixing
// `rmdir /c/tmp` must not bail to cmd over it.
const looksLikeFlag = (tok: string): boolean => {
  const lower = tok.toLowerCase();
  return lower.startsWith('/') && !/^\/[^/]+\//.test(lower);
};

function fixWithFlags(
  t: string[],
  base: string[],
  flagMap: Record<string, string | ''>,
): string[] | null {
  const flags: string[] = [];
  const body: string[] = [];
  for (const tok of t.slice(1)) {
    if (looksLikeFlag(tok)) {
      const lower = tok.toLowerCase();
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
      // `&>` / `>&` are bash redirect operators (stdout+stderr), not cmd's
      // `a & b` separator -- keep them inside the segment.
      if (c === '&' && command[i + 1] === '>') {
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

// PATH entries belonging to an MSYS/Git-Bash installation (`...\usr\bin`):
// those tools are bash's own toolset. Whether they are ALSO visible to
// cmd.exe is a PATH accident (the harness env and a bash-spawned env
// disagree), and letting that accident decide flips whole classes of lines
// between "routed" and "native". The bash side always finds them, so treat
// them as unix unconditionally.
const MSYS_PATH_DIR = /[\\/]usr[\\/]bin(?:[\\/]|$)/i;

// Does cmd.exe see `name` as an executable? (only PATH + PATHEXT, current env)
function resolveOnPath(name: string): boolean {
  if (!name) return false;
  if (name.includes('/') || name.includes('\\')) return existsSync(name);
  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';').map((e) => e.toLowerCase());
  for (const dir of (process.env.PATH ?? '').split(';').filter(Boolean)) {
    if (MSYS_PATH_DIR.test(dir)) continue;
    const base = dir.replace(/[\\]+$/, '');
    if (existsSync(`${base}\\${name}`)) return true;
    for (const ext of exts) if (existsSync(`${base}\\${name}${ext}`)) return true;
  }
  return false;
}

// `cmd //c ver` -- MSYS's doubled-slash flag habit reaches cmd.exe literally
// and starts an interactive cmd (banner + prompt, command never runs). This
// MSYS hands the single-slash `/c` form through untouched, so normalize the
// doubled form on the leading flag run of a cmd invocation only.
function unDoubleSlashFlags(toks: string[]): string[] {
  const head = [toks[0]!];
  let i = 1;
  for (; i < toks.length; i++) {
    const tok = toks[i]!;
    if (/^\/\/[A-Za-z]+$/.test(tok)) head.push('/' + tok.slice(2));
    else break;
  }
  return [...head, ...toks.slice(i)];
}

function normalizeDoubledCmdFlags(command: string): string {
  return command.replace(
    /^(\s*cmd(?:\.exe)?\s+)((?:\/\/[A-Za-z]+\s*)+)/i,
    (_m, h: string, flags: string) => h + flags.replace(/\/\/([A-Za-z]+)/g, '/$1'),
  );
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

// cmd discards bytes with 2>nul / >nul / <nul -- and so do the bash-only
// spellings &>nul / &>>nul / >&nul, which measured WORSE: they create a real
// file named `nul` (reserved Windows device name, near-unerasable through
// cmd) and exit 0. In bash a literal `nul` target hits the NUL device or
// creates that file; /dev/null is what was meant. `(?![\w.])` keeps nul.txt
// and nul2 intact; 2>&nul / <&nul are ambiguous redirects that fail loudly
// without creating anything -- deliberately left alone.
function mapNulTargets(s: string): string {
  return s.replace(
    /(&>>?|(?<![0-9])>&|[0-2]?>+|<)[ \t]*(?:"nul"|'nul'|nul)(?![\w.])/gi,
    (_m, redir: string) => `${redir === '>&' ? '&>' : redir} /dev/null`,
  );
}

// `&>` / `>&` exist only in bash (cmd reads the `&` as a separator), so their
// presence marks bash intent even when every head looks cmd-native.
const BASH_ONLY_REDIRECT = /(?:^|[\s;|(])(?:&>>?|>&)(?![\w.&])/;

// In s, index of the ")" matching the "(" in front of `from`; -1 if absent.
// Understands bash nesting: quotes reopen context, but $( ) and backticks
// still execute inside double quotes; single quotes are fully literal.
// (Same shape as the tmp-guard extension's matcher.)
function matchParen(s: string, from: number): number {
  let depth = 1;
  let i = from;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === "'") {
      let p = i + 1;
      while (p < s.length && s[p] !== "'") p++;
      i = p + 1;
      continue;
    }
    if (c === '"') {
      let p = i + 1;
      while (p < s.length && s[p] !== '"') {
        if (s[p] === '\\') {
          p += 2;
          continue;
        }
        if (s[p] === '$' && s[p + 1] === '(') {
          const cl = matchParen(s, p + 2);
          if (cl === -1) return -1;
          p = cl + 1;
          continue;
        }
        if (s[p] === '`') {
          let q = p + 1;
          while (q < s.length && s[q] !== '`') {
            if (s[q] === '\\') q++;
            q++;
          }
          p = q + 1;
          continue;
        }
        p++;
      }
      i = p + 1;
      continue;
    }
    if (c === '(') {
      depth++;
      i++;
      continue;
    }
    if (c === ')') {
      depth--;
      if (depth === 0) return i;
      i++;
      continue;
    }
    i++;
  }
  return -1;
}

// Nested command substitutions execute inside bash too: `$(cmd //c ver)`
// with MSYS_NO_PATHCONV=1 (set in this machine's bashrc) hands a literal
// `//c` to cmd.exe, which starts an interactive cmd -- measured: GBK banner,
// exit 0, the command never ran. routeLine only inspects segment heads, so
// nested spans get their own scan. Command-position tracking mirrors the
// tmp-guard extension: single quotes are fully literal, double quotes recurse
// into $() / backticks, FOO=bar prefixes keep the command position, and the
// `&` of 2>&1 is not a separator. `cmd//c` (tight) and `cmd //c` both fix;
// `echo cmd //c` stays untouched (data position).
function fixNestedCmdFlags(s: string, fixFlags: boolean): string {
  let out = '';
  let i = 0;
  let curTok = '';
  let prevTok = '';
  let prevTokCmdPos = false;
  let cmdPosNext = true;
  const commitTok = () => {
    if (!curTok) return;
    prevTokCmdPos = cmdPosNext;
    if (cmdPosNext) {
      // FOO=bar env prefixes do not end the command position
      cmdPosNext = /^[A-Za-z_][A-Za-z0-9_]*=/.test(curTok);
    }
    prevTok = curTok;
    curTok = '';
  };
  // inside double quotes, $( ) and `...` still execute: recurse into them
  const scanDq = (seg: string): string => {
    let r = '';
    let k = 0;
    while (k < seg.length) {
      const c = seg[k]!;
      if (c === '$' && seg[k + 1] === '(') {
        const close = matchParen(seg, k + 2);
        if (close === -1) {
          r += seg.slice(k);
          break;
        }
        r += '$(' + fixNestedCmdFlags(seg.slice(k + 2, close), fixFlags) + ')';
        k = close + 1;
        continue;
      }
      if (c === '`') {
        let p = k + 1;
        while (p < seg.length && seg[p] !== '`') {
          if (seg[p] === '\\') p++;
          p++;
        }
        if (p >= seg.length) {
          r += seg.slice(k);
          break;
        }
        r += '`' + fixNestedCmdFlags(seg.slice(k + 1, p), fixFlags) + '`';
        k = p + 1;
        continue;
      }
      r += c;
      k++;
    }
    return r;
  };
  while (i < s.length) {
    const c = s[i]!;
    if (c === '\\') {
      out += s.slice(i, i + 2);
      curTok += s.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === "'") {
      commitTok();
      const e = s.indexOf("'", i + 1);
      if (e === -1) {
        out += s.slice(i);
        break;
      }
      out += s.slice(i, e + 1);
      i = e + 1;
      continue;
    }
    if (c === '"') {
      commitTok();
      let j = i + 1;
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '\\') {
          j += 2;
          continue;
        }
        if (s[j] === '$' && s[j + 1] === '(') {
          const cl = matchParen(s, j + 2);
          if (cl === -1) {
            j = s.length;
            break;
          }
          j = cl + 1;
          continue;
        }
        if (s[j] === '`') {
          let p = j + 1;
          while (p < s.length && s[p] !== '`') {
            if (s[p] === '\\') p++;
            p++;
          }
          j = p + 1;
          continue;
        }
        j++;
      }
      if (j >= s.length) {
        out += scanDq(s.slice(i));
        break;
      }
      out += scanDq(s.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (c === '`') {
      commitTok();
      let p = i + 1;
      while (p < s.length && s[p] !== '`') {
        if (s[p] === '\\') p++;
        p++;
      }
      if (p >= s.length) {
        out += '`' + fixNestedCmdFlags(s.slice(i + 1), fixFlags);
        break;
      }
      out += '`' + fixNestedCmdFlags(s.slice(i + 1, p), fixFlags) + '`';
      i = p + 1;
      continue;
    }
    if (c === '$' && s[i + 1] === '(') {
      commitTok();
      const close = matchParen(s, i + 2);
      if (close === -1) {
        out += s.slice(i);
        break;
      }
      out += '$(' + fixNestedCmdFlags(s.slice(i + 2, close), fixFlags) + ')';
      i = close + 1;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\n') {
      commitTok();
      if (c === '\n') cmdPosNext = true;
      out += c;
      i++;
      continue;
    }
    if (c === '|' || c === ';' || c === '(') {
      commitTok();
      cmdPosNext = true;
      out += c;
      i++;
      continue;
    }
    if (c === '&') {
      commitTok();
      if (s[i - 1] !== '>' && s[i - 1] !== '<') cmdPosNext = true; // 2>&1's & is no separator
      out += c;
      i++;
      continue;
    }
    if (c === ')' || c === '>' || c === '<') {
      commitTok(); // a redirect target is not a command position
      out += c;
      i++;
      continue;
    }
    if (c === '/' && s[i + 1] === '/' && fixFlags) {
      const atCmd =
        curTok === ''
          ? prevTokCmdPos && prevTok.toLowerCase() === 'cmd'
          : cmdPosNext && curTok.toLowerCase() === 'cmd';
      if (atCmd) {
        const m = /^\/\/([a-z]+)(?![\w.-])/i.exec(s.slice(i));
        if (m) {
          // tight `cmd//c`: separate program and flag with a space
          out += (curTok === '' ? '' : ' ') + '/' + m[1]!;
          if (curTok !== '') curTok = '/' + m[1]!;
          i += m[0].length;
          continue;
        }
      }
      curTok += c;
      out += c;
      i++;
      continue;
    }
    curTok += c;
    out += c;
    i++;
  }
  return out;
}

function convertBackslashPaths(s: string): string {
  // quoted first: "C:\Users\me\Sync" -> "C:/Users/me/Sync"
  s = s.replace(
    /"([A-Za-z]:)([^"\\]*\\[^"]*)"/g,
    (_m, drive: string, tail: string) => `"${drive}${tail.replace(/\\/g, '/')}"`,
  );
  // bare: C:\Users\me\Sync -> C:/Users/me/Sync; bare root C:\ -> C:/
  s = s.replace(
    /([A-Za-z]):((?:\\[^\s"')]*)+)/g,
    (_m, drive: string, tail: string) => `${drive}:${tail.replace(/\\/g, '/')}`,
  );
  return s;
}

// Route ONE physical line (no newlines): split segments, fix builtins, apply
// the var/nul/path transforms per segment. Returns the bash-side text plus
// the signals that decide routing:
//   unix      -- segments only bash can run (unix tools, unix paths)
//   builtins  -- segments a fixer translated (echo/if/set/...)
//   delegates -- a fixer delegated to `cmd /c ...` (dir, ver, ...): such
//                segments keep backslash paths AND their GBK-unless-65001
//                output, so lines that ONLY delegate belong in the utf8 wrap,
//                not in bash.
function routeLine(
  text: string,
): {piece: string; unix: number; builtins: number; delegates: number; bashOnly: boolean} | null {
  const items = splitTopLevel(text);
  if (!items.length) return null;

  let unixCount = 0;
  let builtinCount = 0;
  let delegateCount = 0;
  let bashOnly = false;
  // //c rewrites only fire when path conversion is actually off (probed,
  // not hardcoded): with conversion on, `//c` is the spelling that works.
  const fixFlags = pathConvDisabled();
  const built: string[] = [];
  for (const item of items) {
    const {pre, rest} = extractAssignments(item.text);
    let toks = tokensOf(rest);
    // tight `cmd//c` form: one token, no flag separation
    const tight = /^cmd\/\/([a-z]{1,4})$/i.exec(toks[0] ?? '');
    if (tight && fixFlags) toks = ['cmd', '/' + tight[1]!, ...toks.slice(1)];
    const head = (toks[0] ?? '').toLowerCase().replace(/\.exe$/, '');
    let piece: string;
    let delegates = false;
    let builtin = false;
    if (Object.prototype.hasOwnProperty.call(BUILTIN_FIXERS, head)) {
      const out = BUILTIN_FIXERS[head]!(toks);
      if (!out) return null;
      builtin = true;
      delegates = out[0] === 'cmd';
      piece = pre + out.join(' ');
    } else if (BAIL_HEADS.has(head)) {
      return null;
    } else if (head === 'cmd') {
      builtin = true;
      delegates = true;
      piece = pre + (fixFlags ? unDoubleSlashFlags(toks).join(' ') : toks.join(' '));
    } else if (resolveOnPath(head)) {
      piece = pre + rest;
    } else {
      unixCount++;
      piece = (pre + rest).trimEnd();
    }
    if (builtin) builtinCount++;
    if (delegates) delegateCount++;
    piece = fixNestedCmdFlags(piece, fixFlags);
    // cmd.exe cannot use forward-slash paths (`dir "C:/x"` -> invalid
    // parameter); only segments that STAY in bash get the conversion.
    let seg = mapNulTargets(mapPercentVars(piece));
    if (!delegates) seg = convertBackslashPaths(seg);
    if (UNIX_PATH_RE.test(rest)) unixCount++;
    if (BASH_ONLY_REDIRECT.test(seg)) bashOnly = true;
    built.push(seg);
  }

  let rebuilt = built[0] ?? '';
  for (let k = 1; k < items.length; k++) {
    rebuilt += ` ${(items[k]!.op ?? '').trim().replace(/\s+/g, ' ')} ${built[k]}`;
  }
  return {
    piece: rebuilt,
    unix: unixCount,
    builtins: builtinCount,
    delegates: delegateCount,
    bashOnly,
  };
}

// Multiline: route per line so the whole script can ship as ONE temp bash
// script (cmd.exe itself only ever runs the first line). Heredoc bodies stay
// byte-verbatim -- no var mapping, no path conversion, no builtin fixing.
// A trailing `\` merges with the next line first (bash line continuation).
function buildRoutedMultiline(command: string): string | null {
  const raw = command.split(/\r\n|\r|\n/);
  const lines: string[] = [];
  for (const line of raw) {
    const prev = lines[lines.length - 1];
    if (prev !== undefined && prev.trimEnd().endsWith('\\')) {
      lines[lines.length - 1] = prev.trimEnd().slice(0, -1).trimEnd() + ' ' + line.trim();
    } else {
      lines.push(line);
    }
  }

  const out: string[] = [];
  let unixSeen = false;
  let delegateSeen = false;
  let delim: string | null = null;
  for (const line of lines) {
    if (delim !== null) {
      if (line === delim) delim = null; // POSIX: the delimiter line is exact
      out.push(line);
      continue;
    }
    if (!line.trim()) {
      out.push(line);
      continue;
    }
    const routed = routeLine(line);
    if (!routed) return null;
    if (routed.unix > 0 || routed.bashOnly) unixSeen = true;
    if (routed.delegates > 0) delegateSeen = true;
    out.push(routed.piece);
    const hd = /<<-?\s*(['"]?)([A-Za-z0-9_]+)\1/.exec(line);
    if (hd) delim = hd[2]!;
  }
  // cmd eats every line after the first, so multiline prefers bash whenever
  // it is safe there; delegate-only scripts (dir/ver/...) keep utf8-wrap
  // semantics instead (their cmd children need the 65001 console).
  if (!unixSeen && delegateSeen) return null;
  return out.join('\n');
}

// Temp-script shipping: write the payload to disk (UTF-8, LF) and return a
// plain `"bash" "<file>"` invocation. The file content never passes through
// cmd's parse layer, so quoting, %, $(), backticks and newlines all survive
// byte-exact, and the command line stays tiny (no argv cap concerns).
let tempSwept = false;

function sweepStaleTempScripts(): void {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const name of readdirSync(realTempDir())) {
    if (!name.startsWith(TEMP_PREFIX) || !name.endsWith('.sh')) continue;
    const p = join(realTempDir(), name);
    try {
      if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
    } catch { /* locked or gone */ }
  }
}

function shipScript(script: string): string | null {
  try {
    const file = join(realTempDir(), `${TEMP_PREFIX}${randomBytes(6).toString('hex')}.sh`);
    writeFileSync(file, script.replace(/\r\n?/g, '\n') + '\n', 'utf8');
    if (!tempSwept) {
      tempSwept = true;
      try { sweepStaleTempScripts(); } catch { /* not fatal */ }
    }
    // bash keeps the fd open while it runs, so a late unlink of a long-lived
    // script simply fails on Windows and the sweep catches it next session.
    const t = setTimeout(() => { try { unlinkSync(file); } catch { /* see above */ } }, 10 * 60 * 1000);
    t.unref?.();
    return `"${BASH_WRAP_BASH}" "${file}"`;
  } catch {
    return null;
  }
}

// Returns the bash-wrapped line, or null when the command is not bash-routable.
function buildRouted(command: string): string | null {
  if (!command.trim()) return null;

  if (/[\r\n]/.test(command)) {
    const script = buildRoutedMultiline(command);
    // Multiline cannot travel inline: cmd.exe runs only the first line.
    return script ? shipScript(script) : null;
  }

  const line = routeLine(command);
  if (!line) return null;
  // Route when bash is needed or clearly safer:
  //   * a unix segment (ls, grep, a /unix/path) -- cmd cannot run it;
  //   * a bash-only `&>` / `>&` redirect -- cmd would misparse the `&`;
  //   * a cmd-hostile char WITH a translated builtin and no cmd delegation --
  //     `echo 'a'"b"'c'` under cmd prints the quotes literally, bash prints
  //     abc. Delegate-only hostile lines (dir "x") stay in the utf8 wrap:
  //     same cmd semantics plus the 65001 console.
  const routable =
    line.unix > 0 ||
    line.bashOnly ||
    (CMD_HOSTILE.test(line.piece) && line.builtins > 0 && line.delegates === 0);
  if (!routable) return null; // pure cmd: not bash's business

  if (!CMD_HOSTILE.test(line.piece)) {
    // Double quotes are the only grouping cmd.exe honors across the argv
    // handoff to bash (single quotes remain literal to Windows, tearing argv
    // apart); inner double quotes are escaped so the script text survives.
    return `"${BASH_WRAP_BASH}" -c "${line.piece.replace(/"/g, '\\"')}"`;
  }
  // Hostile payload: temp script, or best-effort inline fallback if the disk
  // write failed.
  return (
    shipScript(line.piece) ??
    `"${BASH_WRAP_BASH}" -c "${line.piece.replace(/"/g, '\\"')}"`
  );
}

const toB64 = (s: string): string => Buffer.from(s, 'utf16le').toString('base64');

// Pure-cmd UTF-8 fix: the wrapper sets ITS OWN console output code page to
// 65001, then spawns cmd.exe. cmd reads the code page when it starts, so its
// output (MUI strings, echo, Chinese filenames) arrives as valid UTF-8.
// Without the trailing `exit $LASTEXITCODE` the wrapper always exits 0 and
// every failure looks like success (measured: exit /b 7 came back as 1).
// Multiline: cmd runs only the first line of anything it is handed (LF and
// CRLF alike), so lines join with ` & ` (cmd's sequential operator). Parens
// blocks spanning lines cannot survive that join and fail loudly instead of
// silently truncating -- the honest failure.
function wrapCommand(command: string): string {
  const joined = command.replace(/\r\n|\r|\n/g, ' & ');
  const escaped = joined.replace(/'/g, "''"); // PowerShell single-quote escape
  const script =
    'try { $ProgressPreference = "SilentlyContinue" } catch {}; ' +
    'try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}; ' +
    // The original command still runs inside cmd, so &&, |, >, %VAR% all keep
    // working; only which console it was born in changed.
    `cmd /d /s /c '${escaped}'; ` +
    'exit $LASTEXITCODE';
  return `powershell -NoLogo -NoProfile -NonInteractive -EncodedCommand ${toB64(script)}`;
}

let BASH_WRAP_BASH = ''; // set in default export; declared here for buildRouted

// Whether `//c` reaches cmd.exe literally. With MSYS path conversion ON
// (default git-bash), `//c` is the spelling that WORKS and rewriting it to
// `/c` would be the side effect; with conversion OFF (this machine's bashrc
// exports MSYS_NO_PATHCONV=1), `//c` starts an interactive cmd. The bashrc
// is invisible to us, so probe the real bash environment once instead of
// hardcoding its content: bash -c sources the user's bashrc (BASH_ENV), so
// the child sees exactly what routed commands will see.
let noPathConv: boolean | null = null;

function pathConvDisabled(): boolean {
  if (noPathConv === null) {
    // Uncertainty must resolve to "do not rewrite": with conversion on, //c
    // is the working spelling and rewriting it would BE the side effect. A
    // failed or inconclusive probe therefore leaves //c alone -- if
    // conversion really is off, the interactive-cmd failure is loud (banner,
    // no output) and /c works in BOTH configurations, so the agent can
    // self-correct. Never enable rewrites on a failed probe.
    noPathConv = false;
    try {
      const p = spawnSync(
        BASH_WRAP_BASH,
        ['-c', 'printf %s "$MSYS_NO_PATHCONV"'],
        {windowsHide: true, timeout: 5000},
      );
      noPathConv = !p.error && p.stdout?.toString().trim() === '1';
    } catch {
      /* keep false: probe failure must not enable rewrites */
    }
  }
  return noPathConv;
}

function detectBash(): string | null {
  for (const cand of bashCandidateList()) {
    if (!existsSync(cand)) continue;
    if (isMsysBash(cand)) return cand;
  }
  return null;
}

export default function (api: ModApi): void {
  try { writeFileSync('C:\\Users\\artin\\AppData\\Local\\Temp\\cc-dbg-mod-loaded.txt', String(Date.now())); } catch { /* dbg */ }
  if (!IS_WINDOWS) return;
  const bash = detectBash();
  if (!bash) return; // no MSYS bash found: mod stays inert
  BASH_WRAP_BASH = bash;
  const oursPrefix = `"${bash}" `;

  api.hooks({
    beforeToolCall: ({toolName, input}) => {
      if (PATH_TOOLS.has(toolName)) {
        // File tools resolve /tmp & friends host-side (see rewriteTempPath).
        for (const key of PATH_KEYS) {
          const v = (input as Record<string, unknown>)?.[key];
          if (typeof v === 'string') {
            const rewritten = rewriteTempPath(v);
            if (rewritten !== v) {
              return {input: {...input, [key]: rewritten}};
            }
          }
        }
        return undefined;
      }
      if (toolName === 'powershell') {
        try { writeFileSync('C:\\Users\\artin\\AppData\\Local\\Temp\\cc-dbg-ps-hook.txt', String(Date.now()) + '\n' + command.slice(0, 120)); } catch { /* dbg */ }
        // The harness appends the progress stream to every powershell call as
        // CLIXML XML (e.g. "Preparing module for first use"). Silencing the
        // progress preference removes it (measured). $OutputEncoding is also
        // raised from PS 5.1's ASCII default: piping Chinese into a native
        // tool silently became "???" (environment deficiency, measured).
        // Prepend only, never alter the rest: the command keeps its exact
        // semantics, and a later in-script assignment still overrides.
        const command = typeof input?.command === 'string' ? input.command : '';
        if (!command.trim()) return undefined;
        if (/^\s*(\$ProgressPreference\s*=|param\b|\[CmdletBinding)/.test(command)) return undefined;
        if (command.includes('$ProgressPreference')) return undefined;
        return {input: {...input, command:
          `$ProgressPreference = 'SilentlyContinue'; ` +
          `try { $OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}; ` +
          command}};
      }
      if (toolName !== 'shell_command') return undefined;
      let command = typeof input?.command === 'string' ? input.command : '';
      if (!command.trim()) return undefined;
      if (command.startsWith(oursPrefix)) return undefined; // already routed

      const trimmed = command.trim();
      const head0 = trimmed.split(/\s+/)[0]!.toLowerCase().replace(/\.exe$/, '');
      // `bash`/`sh` resolve through the detected install (the PATH `bash` may
      // be the WSL stub in System32; `sh` runs POSIX mode via sh.exe).
      // `zsh` is NOT rewritten: invoking it is deliberate, System32 has no
      // zsh stub, and mapping it to bash would override the agent's intent.
      const launcherExe =
        head0 === 'bash' ? bash :
        head0 === 'sh' ? (existsSync(`${dirname(bash)}\\sh.exe`) ? `${dirname(bash)}\\sh.exe` : bash) :
        null;
      if (launcherExe) {
        return {input: {...input, command: `"${launcherExe}"` + trimmed.slice(head0.length)}};
      }
      if (head0 === 'cmd' && pathConvDisabled()) command = normalizeDoubledCmdFlags(command);

      // Deliberate external shells are hands-off: `powershell -Command ...`
      // and `powershell -EncodedCommand ...` pass through untouched (the
      // base64 payload survives cmd verbatim, so there is no environment
      // breakage to fix). Rerouting their payloads into bash would override
      // the agent's shell choice -- valid PowerShell using aliases
      // (`gci | sort`) runs fine today and must keep doing so; invalid
      // payloads fail loudly and the agent self-corrects.

      // bash route: within a sanity length cap only.
      if (command.length <= MAX_ROUTE) {
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
