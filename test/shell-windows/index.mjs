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
import {existsSync, mkdtempSync, readFileSync, writeFileSync} from 'node:fs';
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
// cmd-hostile payloads (", %, $(, `, newline) ship as a temp bash script:
// `"bash.exe" "<TEMP>\cc-bash-*.sh"` -- nothing else on the line.
const shipped = (g) =>
  typeof g === 'string' && /^"[^"]+bash\.exe" "[^"]+cc-bash-[^"]+\.sh"$/.test(g);
const shippedScript = (g) => {
  if (typeof g !== 'string') return null;
  const m = /^"[^"]+bash\.exe" "([^"]+cc-bash-[^"]+\.sh)"$/.exec(g);
  return m ? m[1] : null;
};
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
  ['sh script.sh', contains('sh.exe" script.sh')], // POSIX mode via sh.exe
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
  // if %FOO% translations now ship as temp scripts (the mapped piece carries
  // `"`), so the translation itself is asserted end-to-end in section C
  ['if %FOO%==bar echo y && ls', shipped],
  ['if not %FOO%==bar echo y && ls', shipped],
  ['if errorlevel 2 echo y && ls', contains('[ $? -ge 2 ]')],
  ['if not errorlevel 2 echo y && ls', contains('-lt')],
  ['if /i %FOO%==bar echo y', encoded],
  // cmd-hostile payloads: cmd.exe toggles quotes at every raw `"` (so `\"`
  // exposes && | < > to cmd), expands %VAR% even inside quotes, and only
  // survives $() / backticks after its parse layer -> temp script shipping.
  ['echo 50% off && ls', shipped],
  ['echo "a b" && ls', shipped],
  ['echo \'a\'"b"\'c\' && ls', shipped],
  ['echo "sub: $(echo ok)" && ls', shipped],
  ['echo `tick` && ls', shipped],
  ['echo plain && ls', routedWith('echo plain && ls')],
  // a cmd-hostile char is bash intent even with no unix tool in the line:
  // cmd echo prints the quotes literally, bash echo prints abc.
  ['echo \'a\'"b"\'c\'', shipped],
  ['echo plain', encoded], // pure cmd echo: utf8 wrap only
  // unix-style absolute paths force the bash route even for cmd-native heads
  // (cmd cannot use them: "The system cannot find the path specified")
  ['echo hi > /tmp/x.txt', routedWith('echo hi > /tmp/x.txt')],
  ['cd /c/Users && ls', routedWith('cd /c/Users && ls')],
  // cmd //c normalization: the doubled form starts an interactive cmd
  ['cmd //c ver', encoded],
  ['cmd //c ver && ls', contains('cmd /c ver && ls')],
  ['cmd /c ver && ls', contains('cmd /c ver && ls')],
  // multiline: cmd.exe runs only the first line of anything it is handed,
  // so multiline routes per line into one temp script
  ['echo line-A\necho line-B', shipped],
  ['echo line-A\necho "line-B" $(echo sub)\nline-C 中文', shipped],
  ["cat <<'EOF' > out.txt\nbody 中文\nEOF", shipped],
  ['dir\necho after-dir', encoded], // pure cmd multiline: utf8 wrap joins with &
  // bash-only &> / >& redirects: cmd reads the & as a separator, and the nul
  // target creates a real, near-unerasable `nul` file (measured) -> fix AND
  // route (the operator itself marks bash intent)
  ['echo a &>nul && ls', contains('echo a &> /dev/null')],
  ['echo a >&nul && ls', contains('&> /dev/null')],
  ['echo a &>>nul && ls', contains('&>> /dev/null')],
  ['echo a > "nul" && ls', contains('> /dev/null')],
  ['echo a <nul && ls', contains('< /dev/null')],
  ['echo a >nul.txt && ls', routedWith('echo a >nul.txt && ls')], // (?![\w.]) guard
  ['ls 2>&nul', routedWith('ls 2>&nul')], // ambiguous redirect: loud, untouched
  ['echo a &>nul', routedWith('echo a &> /dev/null')], // bash intent, no unix head
  // tight `cmd//c` and nested $() / backtick command positions ($() and
  // backticks are cmd-hostile -> shipped; content verified end-to-end below)
  ['cmd//c ver && ls', contains('cmd /c ver && ls')],
  ['ls && echo $(cmd //c ver)', shipped],
  ['ls && echo $(cmd//c ver)', shipped],
  ['ls && echo `cmd //c ver`', shipped],
  ['ls && echo "$(cmd //c ver)"', shipped],
  ['echo cmd //c && ls', contains('cmd //c')], // data position: untouched
  ['ls && echo $(FOO=bar cmd //c ver)', shipped], // FOO=bar prefix
];
// sanity: the //c gate probes the real bash env with the SAME bash the mod
// detected; on this machine the bashrc sets MSYS_NO_PATHCONV=1, so the probe
// must report conversion OFF and the //c rewrites above are expected to fire.
// If this check fails, the machine changed and the //c cases above should be
// inverted (rewrites must NOT fire when conversion is on -- that would be the
// side effect).
const bashExe = mod.detectedBashPath();
check('detect: bash found and is MSYS',
  typeof bashExe === 'string' && bashExe.endsWith('bash.exe') &&
  /^(MINGW|MSYS)/i.test(spawnSync(bashExe, ['-c', 'uname -s'],
    {windowsHide: true}).stdout?.toString() ?? ''),
  JSON.stringify(bashExe));
const probe = spawnSync(bashExe, ['-c', 'printf %s "$MSYS_NO_PATHCONV"'],
  {windowsHide: true});
check('gate: probe sees MSYS_NO_PATHCONV=1 (bashrc present)',
  probe.stdout?.toString() === '1', JSON.stringify(probe.stdout?.toString()));
for (const [cmd, ok] of cases) check(`route: ${cmd}`, ok(out(cmd)), JSON.stringify(out(cmd)));

// deliberate external shells are HANDS-OFF: a powershell -EncodedCommand
// invocation is wrapped ONLY for the code page; the original command line
// (including its base64 payload) survives byte-exact inside the wrapper --
// never rerouted. Valid PowerShell payloads (aliases included) keep running
// as the agent chose, invalid ones fail loudly.
const utf16b64 = (s) => Buffer.from(s, 'utf16le').toString('base64');
const wrappedPayload = (cmd) => {
  const g = out(cmd);
  return typeof g === 'string' && g.includes('-EncodedCommand') ? decodedPayload(g) : null;
};
const encWrap = (ps) => {
  const b64 = utf16b64(ps);
  const payload = wrappedPayload(`powershell -EncodedCommand ${b64}`);
  return {ok: typeof payload === 'string' && payload.includes(`-EncodedCommand ${b64}`), payload};
};
check('encoded: shell-line payload b64 survives verbatim',
  encWrap('ls -la').ok, encWrap('ls -la').payload);
check('encoded: cmd-one-liner payload b64 survives verbatim',
  encWrap('dir && ls').ok, encWrap('dir && ls').payload);
check('encoded: unroutable payload b64 survives verbatim',
  encWrap('dir /b').ok, encWrap('dir /b').payload);
check('encoded: hand-written PS payload b64 survives verbatim',
  encWrap('$x = Get-Date; Write-Output $x').ok, encWrap('$x = Get-Date; Write-Output $x').payload);
check('encoded: PS-alias payload b64 survives verbatim (valid PS, must not reroute)',
  encWrap('gci | sort').ok, encWrap('gci | sort').payload);

// percent safety: routed lines containing % ship as a temp script -- the
// payload reaches bash after cmd's parse layer, so %VAR% can never expand
const enc = out('echo 50% off && ls');
check('percent line ships as temp script', shipped(enc), enc);
const encScript = shippedScript(enc);
check('shipped script exists on disk and holds the payload',
  encScript !== null && existsSync(encScript) &&
  readFileSync(encScript, 'utf8').includes('echo 50% off && ls'),
  encScript === null ? enc : readFileSync(encScript ?? '', 'utf8').slice(0, 120));

// idempotence: a routed line must not be second-guessed on the way back
check('routed lines stay routed on second pass', untouched(out(out('ls -la'))));
check('shipped lines stay routed on second pass', untouched(out(out('echo "a b" && ls'))));

// powershell tool: the harness appends the progress stream as CLIXML XML
// noise, and PS 5.1 pipes to native tools as ASCII; the hook prepends both
// fixes exactly once
const PS_PRE =
  `$ProgressPreference = 'SilentlyContinue'; ` +
  `try { $OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}; `;
const psPre = hooks.beforeToolCall({toolName: 'powershell', input: {command: 'Get-Date'}});
check('PS: progress + output-encoding prelude prepended',
  psPre?.input?.command === `${PS_PRE}Get-Date`, JSON.stringify(psPre?.input?.command));
check('PS: no double prepend',
  untouched(hooks.beforeToolCall({toolName: 'powershell',
    input: {command: `${PS_PRE}Get-Date`}})));
check('PS: param-first scripts stay untouched',
  untouched(hooks.beforeToolCall({toolName: 'powershell', input: {command: 'param($x) Get-Date'}})));

// deliberate external shells via shell_command: pass-through, only the
// environment (code page) is wrapped around them
const psCmd = out('powershell -Command "Get-ChildItem | Measure-Object"');
check('scope: powershell -Command wrapped but command preserved',
  typeof psCmd === 'string' && psCmd.includes('-EncodedCommand') &&
  decodedPayload(psCmd).includes(`powershell -Command "Get-ChildItem | Measure-Object"`),
  decodedPayload(psCmd));
check('scope: zsh still runs zsh (routed so MSYS-installed zsh is reachable)',
  typeof out('zsh script.zsh') === 'string' && out('zsh script.zsh').includes('zsh script.zsh'),
  JSON.stringify(out('zsh script.zsh')));

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

// ---- cmd-hostile payloads ship byte-exact through the temp script ----

// cmd.exe toggles quotes at every raw `"`: the mixed-quote line used to come
// back literally ('a'"b"'c') or tear the argv apart (unexpected EOF)
const rMix = run(out(`echo 'a'"b"'c'`));
check('C: mixed quotes print abc', rMix.status === 0 && rMix.stdout.toString() === 'abc\n',
  JSON.stringify(rMix.stdout?.toString()) + ' status=' + rMix.status);

// $() and backticks: cmd's parse layer used to eat or misroute these
const rSub = run(out('echo "sub: $(echo ok)"'));
check('C: $( ) expands', rSub.status === 0 && rSub.stdout.toString().includes('sub: ok'),
  JSON.stringify(rSub.stdout?.toString()));
const rTick = run(out('echo pre`echo mid`post'));
check('C: backticks expand', rTick.status === 0 && rTick.stdout.toString() === 'premidpost\n',
  JSON.stringify(rTick.stdout?.toString()));

// unix-style paths under cmd-native heads: cmd reports "The system cannot
// find the path specified" for `> /tmp/...`; MSYS resolves them fine
const rTmp = run(out('echo tempdata > /tmp/cc_mod_test.txt && cat /tmp/cc_mod_test.txt && rm /tmp/cc_mod_test.txt'));
check('C: unix redirect target works', rTmp.status === 0 && rTmp.stdout.toString().includes('tempdata'),
  rTmp.stdout.toString().slice(0, 60) + String(rTmp.status));

// exit codes carry through the temp script form
const rExit = run(out('echo "x" && exit 5'));
check('C: exit code carries via temp script', rExit.status === 5, String(rExit.status));

// if %FOO% translation end-to-end (the mapped piece carries quotes -> shipped)
const rIf = run(out('set FOO=bar && if %FOO%==bar echo match-y && ls'), {cwd: here});
check('C: if %VAR%== translation', rIf.status === 0 && rIf.stdout.toString().includes('match-y'),
  rIf.stdout.toString().slice(0, 80) + String(rIf.status));

// ---- multiline: cmd.exe runs only the first line of anything it is handed ----

const rMulti = run(out('echo line-A\necho line-B'), {cwd: dir});
check('C: multiline runs every line',
  rMulti.status === 0 && rMulti.stdout.toString().includes('line-A') &&
  rMulti.stdout.toString().includes('line-B'),
  JSON.stringify(rMulti.stdout?.toString()) + ' status=' + rMulti.status);

// heredoc bodies stay verbatim: no %VAR% expansion, no path conversion
const hdPath = join(dir, 'hd.txt').replace(/\\/g, '/');
const rHd = run(out(`cat <<'EOF' > "${hdPath}"\nline1 ${CN}\nline2 "q" $ne 50% C:\\raw\\path\nEOF\ncat "${hdPath}"`));
const hdText = rHd.stdout.toString();
check('C: heredoc roundtrip exits 0', rHd.status === 0, String(rHd.status) + ' ' + hdText.slice(0, 80));
check('C: heredoc keeps Chinese verbatim', hdText.includes('line1 ' + CN), hdText.slice(0, 120));
check('C: heredoc keeps quotes, $ and % literal',
  hdText.includes('line2 "q" $ne 50% C:\\raw\\path'), hdText.slice(0, 120));

// pure cmd multiline: the utf8 wrapper joins lines with ` & ` (cmd used to
// run only the first line and drop the rest)
const wMultiCmd = run(out('ver\necho after-ver'));
const wMultiCmdText = both(wMultiCmd).toString();
check('B: multiline pure cmd runs every line',
  wMultiCmd.status === 0 && /after-ver/.test(wMultiCmdText) &&
  /Microsoft Windows \[|Version/i.test(wMultiCmdText),
  wMultiCmdText.slice(0, 100) + ' status=' + wMultiCmd.status);

// ---- cmd //c normalization: the doubled form used to start an interactive
// cmd (banner + prompt, command never ran) ----
const rDbl = run(out('cmd //c echo cmdflag-ok'));
check('C: cmd //c normalizes and runs',
  rDbl.status === 0 && rDbl.stdout.toString().includes('cmdflag-ok') &&
  !rDbl.stdout.toString().includes('Microsoft Windows ['),
  rDbl.stdout.toString().slice(0, 100) + String(rDbl.status));

// ---- &>nul / >&nul used to create a real `nul` file and exit 0 ----
const rAmp = run(out('echo amp-data &>nul'), {cwd: dir});
check('C: &>nul redirects to /dev/null, no nul file',
  rAmp.status === 0 && !existsSync(join(dir, 'nul')) &&
  !rAmp.stdout.toString().includes('amp-data'),
  JSON.stringify(rAmp.stdout?.toString()) + ' nul=' + existsSync(join(dir, 'nul')));
const rGt = run(out('echo gt-data >&nul'), {cwd: dir});
check('C: >&nul redirects to /dev/null, no nul file',
  rGt.status === 0 && !existsSync(join(dir, 'nul')) &&
  !rGt.stdout.toString().includes('gt-data'),
  JSON.stringify(rGt.stdout?.toString()) + ' nul=' + existsSync(join(dir, 'nul')));
// nul.txt is a real filename and must survive untouched
const rNulTxt = run(out('echo keep >nul.txt && cat nul.txt && rm nul.txt'), {cwd: dir});
check('C: >nul.txt stays a real file',
  rNulTxt.status === 0 && rNulTxt.stdout.toString().includes('keep'),
  rNulTxt.stdout.toString().slice(0, 60) + String(rNulTxt.status));

// ---- nested command substitutions: `$(cmd //c ...)` used to start an
// interactive cmd (GBK banner, exit 0, command never ran) ----
const rNest = run(out('ls /dev/null && echo "n: $(cmd //c echo nested-ok)"'), {cwd: dir});
check('C: nested $(cmd //c) runs without banner',
  rNest.status === 0 && rNest.stdout.toString().includes('n: nested-ok') &&
  !rNest.stdout.toString().includes('Microsoft Windows ['),
  JSON.stringify(rNest.stdout?.toString()) + String(rNest.status));
const rTight = run(out('ls /dev/null && echo "t: $(cmd//c echo tight-ok)"'), {cwd: dir});
check('C: nested tight $(cmd//c) runs',
  rTight.status === 0 && rTight.stdout.toString().includes('t: tight-ok'),
  JSON.stringify(rTight.stdout?.toString()) + String(rTight.status));

// ---- file tools resolve /tmp & friends host-side: write_file('/tmp/x')
// landed in C:\tmp (measured); the hook rewrites to the real temp dir ----
const RT = tmpdir(); // drive-lettered here; the mod guards MSYS-mapped values
const rtFile = (p) => {
  const r = hooks.beforeToolCall({toolName: 'write_file', input: {file_path: p}})?.input;
  return r ? r.file_path : p; // undefined hook result == pass-through
};
const expTemp = (rest) => RT + rest.replace(/\//g, '\\');
check('F: write_file /tmp/x -> real temp',
  rtFile('/tmp/sub/x.txt') === expTemp('\\sub\\x.txt'), JSON.stringify(rtFile('/tmp/sub/x.txt')));
check('F: write_file /tmp bare dir', rtFile('/tmp') === RT, JSON.stringify(rtFile('/tmp')));
check('F: write_file $TEMP/x -> real temp',
  rtFile('$TEMP/x.txt') === expTemp('\\x.txt'), JSON.stringify(rtFile('$TEMP/x.txt')));
check('F: write_file $TMP/x -> real temp',
  rtFile('$TMP/x.txt') === expTemp('\\x.txt'), JSON.stringify(rtFile('$TMP/x.txt')));
check('F: write_file C:/tmp/x -> real temp',
  rtFile('C:/tmp/x.txt') === expTemp('\\x.txt'), JSON.stringify(rtFile('C:/tmp/x.txt')));
check('F: write_file C:\\tmp\\x -> real temp',
  rtFile('C:\\tmp\\x.txt') === expTemp('\\x.txt'), JSON.stringify(rtFile('C:\\tmp\\x.txt')));
check('F: normal absolute path untouched',
  rtFile('C:\\Users\\artin\\x.txt') === 'C:\\Users\\artin\\x.txt');
check('F: relative path untouched', rtFile('relative.txt') === 'relative.txt');
const rdPath = hooks.beforeToolCall({toolName: 'read_directory', input: {path: '/tmp'}})?.input?.path
  ?? '/tmp';
check('F: read_directory /tmp -> real temp', rdPath === RT, JSON.stringify(rdPath));
const globPat = hooks.beforeToolCall({toolName: 'glob', input: {pattern: '**/*.ts'}})?.input?.pattern
  ?? '**/*.ts';
check('F: glob pattern untouched', globPat === '**/*.ts', JSON.stringify(globPat));

// the whole point of the rewrite: a file written through the (rewritten)
// file-tool path must be visible to bash at /tmp -- one shared temp dir
const anchor = rtFile('/tmp/cc-anchor-test.txt');
writeFileSync(anchor, 'anchor-ok', 'utf8');
const rAnchor = run(out('cat /tmp/cc-anchor-test.txt && rm /tmp/cc-anchor-test.txt'));
check('F: file-tool /tmp and bash /tmp are the same dir',
  rAnchor.status === 0 && rAnchor.stdout.toString().includes('anchor-ok'),
  JSON.stringify(rAnchor.stdout?.toString()) + String(rAnchor.status));

// ============ result ============

for (const f of failures) console.log('  FAIL  ' + f);
console.log(`=== ${pass} passed, ${failures.length} failed ===`);
process.exit(failures.length === 0 ? 0 : 1);
