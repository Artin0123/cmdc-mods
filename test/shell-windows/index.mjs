// Regression tests for mods/shell-windows/index.ts
//
//   node test/shell-windows/index.mjs
//
// Imports the mod's TypeScript directly (no build step, same idea as jiti),
// calls the real beforeToolCall hook against a stub cmd, and (sections B/C)
// runs the command the mod produced through spawnSync({shell:true}) -- which
// is how the harness spawns.
//
// Needs Node >= 22.6 with --experimental-strip-types (default from 23.6).
//
// NOTE: this file lives in test/, never in mods/. Discovery treats any file
// matching /\.(ts|js|mts|mjs)$/ inside a mod folder as a mod of its own, so a
// test file dropped next to a mod's index.ts would register as a second mod.

import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const modPath = join(here, '..', '..', 'mods', 'shell-windows', 'index.ts');

const CN = String.fromCharCode(0x4e2d, 0x6587); // "zhong wen"
const CN_GBK = 'd6d0cec4';
const CN_UTF8 = 'e4b8ade69687';

const mod = await import(pathToFileURL(modPath).href);
const hooks = {};
mod.default({hooks: (h) => Object.assign(hooks, h)});

const rewrite = (command, toolName = 'shell_command') =>
  hooks.beforeToolCall({toolName, input: {command}});
const out = (command) => rewrite(command)?.input?.command;
const run = (command, opts) => spawnSync(command, {shell: true, windowsHide: true, ...opts});
const both = (p) => Buffer.concat([p.stderr || Buffer.alloc(0), p.stdout || Buffer.alloc(0)]);
const hex = (buf) => [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
const validUtf8 = (buf) => {
  try {
    new TextDecoder('utf-8', {fatal: true}).decode(buf);
    return true;
  } catch {
    return false;
  }
};

let pass = 0;
const failures = [];
const check = (name, ok, detail) => {
  if (ok) pass++;
  else failures.push(detail === undefined ? name : `${name} -> ${detail}`);
};

// ============ A. routing decisions (string level) ============

const routedWith = (payload) => (g) =>
  typeof g === 'string' && g.startsWith('"C:\\') && g.includes(`bash.exe" -c "${payload}"`);
const untouched = (g) => g === undefined;
const contains = (needle) => (g) => typeof g === 'string' && g.includes(needle);
const encoded = (g) =>
  typeof g === 'string' && g.includes('powershell') && g.includes('-EncodedCommand');
const decodedPayload = (g) => {
  const s = typeof g === 'string' ? g : '';
  const i = s.indexOf('-EncodedCommand');
  return i >= 0 ? Buffer.from(s.slice(i + 15).trim(), 'base64').toString('utf16le') : '';
};

const cases = [
  // pure unix: routed whole
  ['ls -la', routedWith('ls -la')],
  ['ls -la && cat a b', routedWith('ls -la && cat a b')],
  ['head -5 x | wc -l', routedWith('head -5 x | wc -l')],
  ['FOO=bar ls', routedWith('FOO=bar ls')],
  ['/usr/bin/env node', (g) => typeof g === 'string' && g.includes('bash.exe')],
  ['bash -c "ls -la"', routedWith('ls -la')],
  ['sh script.sh', contains('bash.exe" ')],
  // 2>&1 must survive as one segment (was: broken into "ls 2> & 1 | head -3")
  ['ls 2>&1', routedWith('ls 2>&1')],
  ['ls 2>&1 | head -3', routedWith('ls 2>&1 | head -3')],
  // NUL redirect has a faithful map: /dev/null (a literal `nul` file is a
  // reserved Windows name; the file resists normal deletion through cmd.exe)
  ['dir 2>nul && ls', contains('cmd /c dir 2> /dev/null && ls')],
  ['copy a b >nul && ls', contains('cp a b > /dev/null')],
  ['type x <nul && ls', encoded], // type takes exactly FILE; redirect bails -> native
  ['del x 2>nul && ls', contains('rm -f x 2> /dev/null')],
  ['dir 2>nulfile && ls', contains('2>nulfile')],
  ['dir 2>nul', encoded], // pure cmd: NUL device is native and correct, utf8 wrap only
  // pure cmd stays native semantics inside the utf8 wrapper
  ['dir', encoded],
  ['git status', untouched],
  ['node -v', untouched],
  ['where python', encoded],
  ['dir /b && echo ok', encoded],
  // cmd `a & b` == bash `a ; b` (sequential), NOT background
  ['dir & ls', contains('cmd /c dir ; ls')],
  // mixed: seamless translation, each segment faithful
  ['dir && ls -la', contains('cmd /c dir && ls -la')],
  ['cd C:\\Users\\artin\\Sync && ls', contains('cd C:/Users/artin/Sync && ls')],
  ['copy a b && ls', contains('cp a b')],
  ['copy /b a b && ls', encoded],
  ['del x && ls', contains('rm -f x')],
  ['rd /s /q x && ls', contains('rm -rf x')],
  ['ren a.txt b.txt && ls', contains('mv a.txt b.txt')],
  ['type C:\\x\\a.txt && ls', contains('cat C:/x/a.txt')],
  ['echo %PATH% | head -1', contains('$PATH')],
  ['echo %ERRORLEVEL% && ls', contains('$?')],
  ['set FOO=bar && ls', contains('export FOO=bar')],
  ['set && ls', contains('cmd /c set')],
  ['where node && ls', contains('which node')],
  ['ver && ls', contains('cmd /c ver')],
  ['robocopy a b /mir && ls', contains('robocopy a b /mir')],
  ['date /t && ls', contains('cmd /c date /t')],
  // untranslatable constructs keep their native semantics(utf8 wrap takes over)
  ['goto done && ls', encoded],
  // simple if/for/mklink shapes
  ['mklink a b && ls', contains('ln -s b a && ls')],
  ['mklink /h a b && ls', contains('ln b a && ls')],
  ['mklink /j a b && ls', encoded],
  ['verify on && ls', contains('true && ls')],
  ['for %i in (a b) do echo %i && ls', contains('for i in a b; do echo $i; done && ls')],
  ['for /l %i in (1,1,3) do echo %i && ls', encoded],
  ['if exist a (echo x) && ls', contains('if [ -e a ]; then (echo x); fi && ls')],
  ['if not exist a (echo x) && ls', contains('if [ ! -e a ]; then')],
  ['if %FOO%==bar echo y && ls', contains('[ \\"$FOO\\" = \'bar\' ]')],
  ['if not %FOO%==bar echo y && ls', contains('!=')],
  ['if errorlevel 2 echo y && ls', contains('[ $? -ge 2 ]')],
  ['if not errorlevel 2 echo y && ls', contains('-lt')],
  ['if /i %FOO%==bar echo y', encoded],
];
for (const [cmd, ok] of cases) check(`route: ${cmd}`, ok(out(cmd)), JSON.stringify(out(cmd)));

// utf8-style wrapper passthrough: route inside an existing EncodedCommand
const utf16b64 = (s) => Buffer.from(s, 'utf16le').toString('base64');
const w1 = `powershell -NoLogo -NoProfile -NonInteractive -EncodedCommand ${utf16b64('ls -la')}`;
const o1 = out(w1);
check('encoded: ls -la re-routed inside PS wrapper',
  encoded(o1) && decodedPayload(o1).includes('bash.exe" -c "ls -la"'), decodedPayload(o1));
const w2 = `powershell -NoLogo -NoProfile -NonInteractive -EncodedCommand ${utf16b64('dir && ls')}`;
const o2 = out(w2);
check('encoded: cmd-one-liner inside PS wrapper re-routed',
  encoded(o2) && decodedPayload(o2).includes('cmd /c dir && ls'), decodedPayload(o2));
check('encoded: unroutable payload stays untouched',
  untouched(out(`powershell -EncodedCommand ${utf16b64('dir /b')}`)));

// percent safety: routed lines containing % get their own EncodedCommand pack
const enc = out('echo 50% off && ls');
check('percent line auto-packaged', encoded(enc), enc);
const encDec = decodedPayload(enc);
check('packaged payload invokes bash with `&`',
  encDec.includes("& '") &&
  encDec.includes(`bash.exe' -c 'echo 50% off`) &&
  encDec.includes('exit $LASTEXITCODE'), encDec);

// idempotence: a routed line must not be second-guessed on the way back
check('routed lines stay routed on second pass', untouched(out(out('ls -la'))));

// ============ B. execution: utf8 regression (spawnSync real runs) ============

const dir = mkdtempSync(join(tmpdir(), 'shell-windows-'));
writeFileSync(join(dir, CN + '.txt'), 'x', 'utf8');
const plain = join(dir, 'plain.txt');
writeFileSync(plain, 'hello world\r\n', 'utf8');

// the bug exists without the mod (literal command -> spawnSync, mod untouched;
// harness decodes child as UTF-8 while cmd emits GBK)
const rawCn = run('echo ' + CN);
check('B: raw echo <cn> emits GBK', hex(both(rawCn)).includes(CN_GBK),
  hex(both(rawCn)).slice(0, 80));
check('B: raw echo <cn> has no UTF-8', !hex(both(rawCn)).includes(CN_UTF8));

const wDir = run(out('dir C:\\'));
const wDirText = wDir.stdout.toString('utf8');
check('B: wrapped dir C:\\ produced output', wDir.stdout.length > 0);
check('B: wrapped dir C:\\ is valid UTF-8', validUtf8(wDir.stdout));
check('B: wrapped dir C:\\ has no U+FFFD', !wDirText.includes('\uFFFD'));
check('B: wrapped dir C:\\ header is readable',
  /Volume in drive|Directory of/i.test(wDirText), wDirText.slice(0, 80));

const wCn = run(out('echo ' + CN));
check('B: wrapped echo <cn> emits UTF-8', hex(both(wCn)).includes(CN_UTF8),
  hex(both(wCn)).slice(0, 80));
check('B: wrapped echo <cn> has no GBK', !hex(both(wCn)).includes(CN_GBK));

// Chinese FILENAMES take a different Windows path than echo -- check them too.
const rawList = run('dir "' + dir + '"');
check('B: raw dir <cn file> emits GBK filename',
  hex(both(rawList)).includes(CN_GBK), hex(both(rawList)).slice(0, 80));
const wList = run(out('dir "' + dir + '"'));
check('B: wrapped dir <cn file> is valid UTF-8',
  validUtf8(both(wList)), wList.stderr.toString());
check('B: wrapped dir <cn file> has UTF-8 filename',
  hex(both(wList)).includes(CN_UTF8), hex(both(wList)).slice(0, 80));

// exit codes (native wrap forwards cmd exit exactly)
check('B: exit /b 0 -> 0', run(out('cmd /c exit /b 0')).status === 0,
  String(run(out('cmd /c exit /b 0')).status));
const bad = run(out('cmd /c exit /b 7'));
check('B: native exit /b 7 -> 7', bad.status === 7, String(bad.status));
const badRouted = run(out('ls no-such-file && echo next || echo skip'));
check('B: routed bash exit code carries (true branch)', badRouted.status === 0,
  String(badRouted.status) + ' ' + badRouted.stdout.toString().slice(0, 40));

// cmd syntax survives (native wrap keeps &&, &, |, %VAR%, quoting intact)
check('B: && chains', /a[\s\S]*b/.test(both(run(out('echo a && echo b'))).toString()));
check('B: & runs both', /a[\s\S]*b/.test(both(run(out('echo a & echo b'))).toString()));
check('B: %VAR% expands',
  !run(out('echo %COMPUTERNAME%')).stdout.toString().includes('%COMPUTERNAME%'));
check('B: | pipes', run(out('dir "' + dir + '" | findstr /i plain')).stdout.length > 0);
check('B: /c:"..." quoting works',
  /hello world/.test(run(out('findstr /c:"hello world" "' + plain + '"')).stdout.toString()));
check('B: trailing backslash survives', run(out('dir C:\\')).stdout.length > 0);

// ============ C. execution: bash routing (spawnSync real runs) ============

const rLs = run(out('ls -la'), {cwd: here});
check('C: routed ls -la exits 0', rLs.status === 0, String(rLs.status));
check('C: routed ls -la lists files', rLs.stdout.length > 0);

const rLsEnc = run(out('ls 2>&1'), {cwd: here});
check('C: routed ls 2>&1 exits 0', rLsEnc.status === 0, String(rLsEnc.status));

const rChain = run(out('cd C:\\ && ls'), {cwd: here});
check('C: routed cd chains', rChain.status === 0 && rChain.stdout.length > 0,
  String(rChain.status));

// NUL: routed `2>nul` must map to /dev/null -- a stray reserved-name file
// would be near-impossible to delete through cmd.exe (`del \\?\...\nul` only).
const rNul = run(out('dir 2>nul && ls'), {cwd: dir});
check('C: routed dir 2>nul && ls exits 0', rNul.status === 0, String(rNul.status));
check('C: routed dir 2>nul creates no `nul` file', !existsSync(join(dir, 'nul')));

// percent packaging, end to end (PS -> bash -> echo, cmd's %VAR% never sees it)
const rPct = run(out('echo 50% off && ls'), {cwd: here});
check('C: percent line end-to-end',
  rPct.status === 0 && rPct.stdout.toString().includes('50% off'),
  rPct.stdout.toString().slice(0, 80) + ' status=' + rPct.status);

// inner `cmd /c ...` must reach cmd's option layer -- `//c` used to literally
// start an interactive cmd (banner + prompt instead of the actual command)
const rInner = run(out('dir && ls -la'), {cwd: join(here, '..', '..')});
const rInnerText = rInner.stdout.toString();
check('C: inner cmd /c produces no cmd banner', !rInnerText.includes('Microsoft Windows ['), rInnerText.slice(0, 120));
check('C: inner cmd /c satisfies the && chain (ls ran)', rInnerText.includes('README.md'));

// native exes inside routed lines keep bare slash flags untouched
const rFlag = run(out('findstr /i hello "' + plain + '" && ls'), {cwd: dir});
check('C: findstr /i inside routed line works', rFlag.stdout.toString().includes('hello world'),
  rFlag.stdout.toString().slice(0, 60) + String(rFlag.status));

// ============ result ============

for (const f of failures) console.log('  FAIL  ' + f);
console.log(`=== ${pass} passed, ${failures.length} failed ===`);
process.exit(failures.length === 0 ? 0 : 1);
