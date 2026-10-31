// Unit battery for pi-extensions/env-guard/index.ts
//
//   node pi-extensions/tests/env-guard/index.mjs
//
// Imports the extension's TypeScript directly (jiti-style, no build step)
// and asserts every documented guard plus every deliberately-not-fixed form,
// so the "刻意不修" decisions stay pinned instead of drifting back.
//
// Needs Node >= 22.6 (type stripping default from 23.6).
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {tmpdir} from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(join(here, '..', '..', 'env-guard', 'index.ts')).href);

let pass = 0; const failures = [];
const check = (name, ok, detail) => { if (ok) pass++; else failures.push(`${name} -> ${detail}`); };
const rt = (p) => mod.rewritePath(p);
const bc = (c) => mod.rewriteBashCommand(c);
const T = tmpdir();

// --- rewritePath: /tmp family ---
check('P: /tmp bare', rt('/tmp') === T, JSON.stringify(rt('/tmp')));
check('P: /tmp/x', rt('/tmp/sub/x.txt') === T + '\\sub\\x.txt', JSON.stringify(rt('/tmp/sub/x.txt')));
check('P: /TMP case-insensitive', rt('/TMP/x') === T + '\\x', JSON.stringify(rt('/TMP/x')));
check('P: /tmp\\foo mixed separator', rt('/tmp\\foo') === T + '\\foo', JSON.stringify(rt('/tmp\\foo')));
check('P: $TEMP/x', rt('$TEMP/x') === T + '\\x', JSON.stringify(rt('$TEMP/x')));
check('P: $temp lowercase', rt('$temp/x') === T + '\\x', JSON.stringify(rt('$temp/x')));
check('P: $TMP/x', rt('$TMP/x') === T + '\\x', JSON.stringify(rt('$TMP/x')));
check('P: $TMPDIR/x', rt('$TMPDIR/x') === T + '\\x', JSON.stringify(rt('$TMPDIR/x')));
check('P: bare $TEMP', rt('$TEMP') === T, JSON.stringify(rt('$TEMP')));
check('P: %TEMP%/x', rt('%TEMP%/x') === T + '\\x', JSON.stringify(rt('%TEMP%/x')));
check('P: %tmp%\\x', rt('%tmp%\\x') === T + '\\x', JSON.stringify(rt('%tmp%\\x')));

// --- rewritePath: deliberate non-fixes ---
check('P: C:\\tmp untouched (native write ok)', rt('C:\\tmp\\x') === 'C:\\tmp\\x', JSON.stringify(rt('C:\\tmp\\x')));
check('P: relative untouched', rt('relative/x') === 'relative/x', JSON.stringify(rt('relative/x')));
check('P: ~ untouched (tool expands)', rt('~/x') === '~/x', JSON.stringify(rt('~/x')));

// --- rewritePath: MSYS drive letters — deliberately NOT fixed in pi ---
// pi's own resolveToCwd -> normalizeWindowsShellPath already maps /c/Users/x
// -> C:\Users\x (plus /mnt/d, /cygdrive/e), verified e2e (write to /c/tgprobe
// landed at C:\tgprobe, no C:\c). The extension passes them through; a
// rewrite here would be duplicate protection (pure side effect). The same
// rewrite IS justified on hosts without that normalization layer (cmdc).
check('P: /c/Users passes through (pi natively maps)', rt('/c/Users/a') === '/c/Users/a', JSON.stringify(rt('/c/Users/a')));
check('P: /c/tmp passes through', rt('/c/tmp/x') === '/c/tmp/x', JSON.stringify(rt('/c/tmp/x')));

// --- rewriteBashCommand: doubled flags (probe-gated: only when the spawned
// bash actually reports MSYS_NO_PATHCONV=1) ---
const noConv = bc('cmd //c ver');
check('P: cmd //c -> /c', noConv.command === 'cmd /c ver' && noConv.cmdFlagFixed, JSON.stringify(noConv));
check('P: cmd //k -> /k', bc('cmd //k dir').cmdFlagFixed, JSON.stringify(bc('cmd //k dir')));
const multi = bc('cmd //q //c ver');
check('P: multi-flag //q //c both fixed', multi.command === 'cmd /q /c ver', JSON.stringify(multi));
const tight = bc('cmd//c ver');
check('P: tight cmd//c form', tight.command === 'cmd /c ver', JSON.stringify(tight));

// --- rewriteBashCommand: position awareness ---
check('P: data position untouched', bc('echo cmd //c ver').command === 'echo cmd //c ver', JSON.stringify(bc('echo cmd //c ver')));
const afterSemi = bc('ls; cmd //c ver');
check('P: command position after ; fixed', afterSemi.command === 'ls; cmd /c ver', JSON.stringify(afterSemi));
const nested = bc('echo "v: $(cmd //c ver)"');
check('P: nested $( ) fixed', nested.command === 'echo "v: $(cmd /c ver)"', JSON.stringify(nested));
const backtick = bc('echo v: `cmd //c ver`');
check('P: backtick nested fixed', backtick.command === 'echo v: `cmd /c ver`', JSON.stringify(backtick));

// --- rewriteBashCommand: protected data ---
const heredoc = bc("cat <<'EOF'\ncmd //c ver\nEOF");
check('P: heredoc body untouched', heredoc.command.includes('cmd //c ver'), JSON.stringify(heredoc));
const nul = bc('a 2>nul & b &>nul');
check('P: nul forms untouched (deliberate)', nul.command === 'a 2>nul & b &>nul' && !nul.cmdFlagFixed, JSON.stringify(nul));

// --- cmd + non-ASCII detection ---
const cn = bc('cmd /c echo 中文');
check('P: cmd+nonASCII flagged', cn.cmdNonAscii === true, JSON.stringify(cn));
const noCn = bc('echo 中文');
check('P: plain nonASCII not flagged', noCn.cmdNonAscii === false, JSON.stringify(noCn));
const cnData = bc('echo cmd 中文');
check('P: cmd-in-data not flagged', cnData.cmdNonAscii === false, JSON.stringify(cnData));

// --- //c with quoted payload: flag fixed, payload kept ---
const quoted = bc('cmd //c "dir > nul"');
check('P: //c fixed, quoted payload kept', quoted.command === 'cmd /c "dir > nul"', JSON.stringify(quoted));

for (const f of failures) console.log('  FAIL ' + f);
console.log(`=== pi unit battery: ${pass} passed, ${failures.length} failed ===`);
process.exit(failures.length === 0 ? 0 : 1);
