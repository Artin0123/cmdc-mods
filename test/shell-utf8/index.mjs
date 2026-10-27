// Regression test for mods/shell-utf8/index.ts
//
//   node test/shell-utf8/index.mjs
//
// Imports the mod's TypeScript directly (no build step, same idea as jiti), calls
// the real beforeToolCall hook against a stub cmd, then runs the command the mod
// produced through spawnSync({shell:true}) -- which is how the harness spawns.
//
// Needs Node >= 22.6 with --experimental-strip-types (default from 23.6).
//
// NOTE: this file lives in test/, never in mods/. Discovery treats any file
// matching /\.(ts|js|mts|mjs)$/ inside a mod folder as a mod of its own, so a test
// file dropped next to a mod's index.ts would register as a second mod.

import {spawnSync} from 'node:child_process';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const modPath = join(here, '..', '..', 'mods', 'shell-utf8', 'index.ts');

const CN = String.fromCharCode(0x4e2d, 0x6587); // "zhong wen"
const CN_GBK = 'd6d0cec4';
const CN_UTF8 = 'e4b8ade69687';

const mod = await import(pathToFileURL(modPath).href);
const hooks = {};
mod.default({hooks: (h) => Object.assign(hooks, h)});

const rewrite = (command, toolName = 'shell_command') =>
  hooks.beforeToolCall({toolName, input: {command}});
const wrapped = (command) => rewrite(command)?.input?.command;
const run = (command) => spawnSync(command, {shell: true, windowsHide: true});
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

// ---------------- fixtures ----------------
const dir = mkdtempSync(join(tmpdir(), 'shell-utf8-'));
writeFileSync(join(dir, CN + '.txt'), 'x', 'utf8');
const plain = join(dir, 'plain.txt');
writeFileSync(plain, 'hello world\r\n', 'utf8');

// ---------------- 1. rewrite decisions ----------------
check('dir C:\\ is wrapped', typeof wrapped('dir C:\\') === 'string');
check('uses -EncodedCommand', String(wrapped('dir C:\\')).includes('-EncodedCommand'));
check('git is skipped', rewrite('git status') === undefined);
check('node is skipped', rewrite('node -v') === undefined);
check('python is skipped', rewrite('python x.py') === undefined);
check('already wrapped is skipped',
  rewrite(String(wrapped('dir C:\\'))) === undefined);
check('over-long is skipped', rewrite('echo ' + 'a'.repeat(2000)) === undefined);
check('empty is skipped', rewrite('   ') === undefined);
check('non-string command is skipped', rewrite(123) === undefined);
check('other tools are untouched', rewrite('dir C:\\', 'read_file') === undefined);

// ---------------- 2. the bug exists today ----------------
const rawCn = run('echo ' + CN);
check('raw echo <cn> emits GBK', hex(rawCn.stdout).includes(CN_GBK), hex(rawCn.stdout));
check('raw echo <cn> has no UTF-8', !hex(rawCn.stdout).includes(CN_UTF8));

// ---------------- 3. the fix ----------------
const wDir = run(wrapped('dir C:\\'));
const wDirText = wDir.stdout.toString('utf8');
check('wrapped dir C:\\ produced output', wDir.stdout.length > 0);
check('wrapped dir C:\\ is valid UTF-8', validUtf8(wDir.stdout));
check('wrapped dir C:\\ has no U+FFFD', !wDirText.includes('\uFFFD'));
check('wrapped dir C:\\ header is readable',
  /Volume in drive|Directory of/i.test(wDirText), wDirText.slice(0, 80));

const wCn = run(wrapped('echo ' + CN));
check('wrapped echo <cn> emits UTF-8', hex(wCn.stdout).includes(CN_UTF8), hex(wCn.stdout));
check('wrapped echo <cn> has no GBK', !hex(wCn.stdout).includes(CN_GBK));

// Chinese FILENAMES take a different Windows path than echo -- check them too.
const rawList = run('dir "' + dir + '"');
check('raw dir <cn file> emits GBK filename', hex(rawList.stdout).includes(CN_GBK));
const wList = run(wrapped('dir "' + dir + '"'));
check('wrapped dir <cn file> is valid UTF-8', validUtf8(wList.stdout));
check('wrapped dir <cn file> has UTF-8 filename', hex(wList.stdout).includes(CN_UTF8));

// ---------------- 4. exit codes ----------------
check('exit /b 0 -> 0', run(wrapped('exit /b 0')).status === 0,
  String(run(wrapped('exit /b 0')).status));
const bad = run(wrapped('exit /b 7'));
check('exit /b 7 -> 7', bad.status === 7, String(bad.status));

// ---------------- 5. cmd syntax survives ----------------
check('&& chains', /a[\s\S]*b/.test(run(wrapped('echo a && echo b')).stdout.toString()));
check('& runs both', /a[\s\S]*b/.test(run(wrapped('echo a & echo b')).stdout.toString()));
check('%VAR% expands',
  !run(wrapped('echo %COMPUTERNAME%')).stdout.toString().includes('%COMPUTERNAME%'));
check('| pipes', run(wrapped('dir "' + dir + '" | findstr /i plain')).stdout.length > 0);
check('/c:"..." quoting works',
  /hello world/.test(run(wrapped('findstr /c:"hello world" "' + plain + '"')).stdout.toString()));
check('trailing backslash survives', run(wrapped('dir C:\\')).stdout.length > 0);

// ---------------- result ----------------
for (const f of failures) console.log('  FAIL  ' + f);
console.log(`=== ${pass} passed, ${failures.length} failed ===`);
process.exit(failures.length === 0 ? 0 : 1);
