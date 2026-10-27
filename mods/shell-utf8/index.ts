// shell-utf8 -- make shell_command output valid UTF-8 on Windows.
//
// Why this exists: the harness decodes every child process with
//   child.stdout.setEncoding('utf8')
// (resources/app/node_modules/@commandcode/harness/dist/index.js), so a cmd.exe
// child that emits CP936/GBK bytes becomes U+FFFD -- which is unrecoverable.
// A post-execution hook therefore cannot help: the fix has to happen BEFORE the
// bytes are produced. (Kept out of this comment on purpose: `cmdc mods inspect`
// scans the source text, so naming a hook here would show up as a false positive.)
//
// How: the wrapper sets ITS OWN console output code page to 65001, then spawns
// cmd.exe as a child. cmd reads the code page when it starts, so it is born in a
// 65001 console:
//   - static MUI strings -> English ("Volume in drive C has no label.")
//   - dynamic data       -> real UTF-8 Chinese (filenames, echo, program output)
// Every byte the harness then receives is valid UTF-8.
//
// Measured on Windows 10 19045 / PowerShell 5.1 / zh-CN:
//   50 of 63 Windows console tools emit non-UTF-8 (dir, ipconfig, netstat,
//   tasklist, ver, findstr, ...). Encoding depends on whether the tool PRINTS
//   Chinese, not on the tool name, so an allowlist is the wrong shape: wrap by
//   default and skip only tools known to emit UTF-8 already.
//   Cost: ~+120ms per wrapped command.
//
// Verified forwarding (byte-identical to bare cmd): &&, &, |, ^<tag^>, %VAR%,
// $HOME, don't, "a & b", findstr /c:"hello world" file, for %i in (a b),
// dir "C:\Program Files (x86)", dir C:\ (trailing backslash).

import type {ModApi} from '@commandcode/harness';

const IS_WINDOWS = process.platform === 'win32';

// Agent workhorses that already emit UTF-8. Verified: python 3.15 ships PEP 686
// UTF-8 mode on by default (enc=utf-8, utf8mode=1), so skipping it is correct.
// If a pre-3.15 venv ever appears, prefer prefixing
//   set "PYTHONIOENCODING=utf-8" &&
// (measured: +0ms) over removing python from this list (+120ms).
const SKIP_UTF8 =
  /^\s*(git|node|npm|npx|pnpm|yarn|bun|deno|python|python3|py|pip|pip3|uv|ruff|rg|fd|jq|curl|wget|ssh|scp|docker|kubectl|gh|cargo|go|make|cmake|bash|sh|zsh|tar|gzip|7z)\b/i;

// base64(UTF-16LE) is ~2.67x the script length and the Windows command line caps
// at 8191 chars, so keep a wide margin.
const MAX_COMMAND = 1800;

const toB64 = (s: string): string => Buffer.from(s, 'utf16le').toString('base64');

function wrapCommand(command: string): string {
  const escaped = command.replace(/'/g, "''"); // PowerShell single-quote escape

  const script =
    // Flip this console's output code page BEFORE cmd exists.
    'try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}; ' +
    // The original command still runs inside cmd, so &&, |, >, %VAR% all keep
    // working; only which console it was born in changed.
    `cmd /d /s /c '${escaped}'; ` +
    // Without this the wrapper exits 0 and every failure looks like success
    // (measured: exit /b 7 came back as 1).
    'exit $LASTEXITCODE';

  return `powershell -NoLogo -NoProfile -NonInteractive -EncodedCommand ${toB64(script)}`;
}

export default function (cmd: ModApi): void {
  if (!IS_WINDOWS) return;

  cmd.hooks({
    beforeToolCall: ({toolName, input}) => {
      // Foreground only. monitor_command uses a detached + windowsHide spawn, and
      // an extra PowerShell layer there has not been tested against
      // killProcessTree, so it is deliberately left alone.
      if (toolName !== 'shell_command') return undefined;

      const command = typeof input?.command === 'string' ? input.command : '';
      if (!command.trim()) return undefined;
      if (command.includes('-EncodedCommand')) return undefined; // already wrapped
      if (SKIP_UTF8.test(command)) return undefined;
      if (command.length > MAX_COMMAND) return undefined;

      return {input: {...input, command: wrapCommand(command)}};
    },
  });
}
