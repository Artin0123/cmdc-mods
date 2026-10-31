// Regression tests for cmdc-mods/system-prompt/index.ts
//
//   node cmdc-mods/tests/system-prompt/index.mjs
//
// Imports the mod's TypeScript directly (no build step), calls the
// appendSystemPrompt / transformSystemPrompt hooks against a stub cmd, and
// checks resolution order (project before home) and the SYSTEM.md +
// APPEND_SYSTEM.md composition. HOME/USERPROFILE are pointed at a temp home
// for the duration of each scenario so the resolution is hermetic (the real
// ~/.commandcode must not leak into the tests).
//
// Needs Node >= 22.6 with --experimental-strip-types (default from 23.6).
//
// NOTE: tests live in the HOST folder's tests/ (cmdc-mods/tests/), outside
// the mod folder -- keeping plugin folders clean regardless of each host's
// discovery rules.

import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const modPath = join(here, '..', '..', 'system-prompt', 'index.ts');

let pass = 0;
const failures = [];
const check = (name, ok, detail) => {
	if (ok) pass++;
	else failures.push(detail === undefined ? name : `${name} -> ${detail}`);
};

// ---- scaffold -----------------------------------------------------------

const makeCmd = cwd => {
	const state = {notifies: [], hooks: {}};
	return {
		cwd,
		ui: {notify: message => state.notifies.push(message)},
		hooks: hooks => Object.assign(state.hooks, hooks),
		state,
	};
};

// Hermetic home: the mod resolves prompt files against homedir(); point it
// at a temp dir for the scenario. os.homedir() re-reads the env on every
// call (no caching), so this holds for the whole scenario.
const tempHome = () => {
	const home = mkdtempSync(join(tmpdir(), 'system-prompt-home-'));
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	return home;
};

const runScenario = async (setupCwd, setupHome) => {
	const home = tempHome();
	const mod = await import(pathToFileURL(modPath).href);
	const cwd = mkdtempSync(join(tmpdir(), 'system-prompt-cwd-'));
	if (setupCwd) setupCwd(cwd);
	if (setupHome) setupHome(home);
	const cmd = makeCmd(cwd);
	mod.default(cmd);
	return {cwd, home, state: cmd.state};
};

const cleanup = ({cwd, home}) => {
	for (const path of [cwd, home]) rmSync(path, {recursive: true, force: true});
	delete process.env.HOME;
	delete process.env.USERPROFILE;
};

const writePrompt = (base, name, content) => {
	mkdirSync(join(base, '.commandcode'), {recursive: true});
	writeFileSync(join(base, '.commandcode', name), content);
};

// ============ scenarios ============

// 1. APPEND_SYSTEM.md in <cwd>/.commandcode wins over the (empty) home.
{
	const s = await runScenario(cwd => writePrompt(cwd, 'APPEND_SYSTEM.md', 'PROJECT APPEND'));
	check(
		'1 project file wins: append hook reads it',
		s.state.hooks.appendSystemPrompt() === 'PROJECT APPEND',
		s.state.hooks.appendSystemPrompt(),
	);
	cleanup(s);
}

// 2. Home fallback: no project file -> the home file is used.
{
	const s = await runScenario(
		cwd => mkdirSync(join(cwd, '.commandcode'), {recursive: true}),
		home => writePrompt(home, 'APPEND_SYSTEM.md', 'HOME APPEND'),
	);
	check(
		'2 home fallback supplies the append text',
		s.state.hooks.appendSystemPrompt() === 'HOME APPEND',
		s.state.hooks.appendSystemPrompt(),
	);
	cleanup(s);
}

// 3. SYSTEM.md replaces the prompt; APPEND_SYSTEM.md rides after it.
{
	const s = await runScenario(cwd => {
		writePrompt(cwd, 'SYSTEM.md', 'REPLACED');
		writePrompt(cwd, 'APPEND_SYSTEM.md', 'APPENDED');
	});
	const hooks = s.state.hooks;
	check(
		'3 replace+append composition',
		hooks.transformSystemPrompt({system: 'BUILTIN'}) === 'REPLACED\n\nAPPENDED',
		hooks.transformSystemPrompt({system: 'BUILTIN'}),
	);
	// appendSystemPrompt must keep returning the append text so a replace-only
	// consumer (transform hook absent) still lands it.
	check('3 append hook still returns the append text', hooks.appendSystemPrompt() === 'APPENDED');
	cleanup(s);
}

// 4. SYSTEM.md alone: replacement without any tail.
{
	const s = await runScenario(cwd => writePrompt(cwd, 'SYSTEM.md', 'REPLACED'));
	check(
		'4 replace alone returns exactly the replacement',
		s.state.hooks.transformSystemPrompt({system: 'BUILTIN'}) === 'REPLACED',
	);
	cleanup(s);
}

// 5. No files anywhere: both prompt hooks are pass-through (stock behavior).
{
	const s = await runScenario();
	check('5 no files: append hook returns undefined', s.state.hooks.appendSystemPrompt() === undefined);
	check(
		'5 no files: transform hook passes the system prompt through',
		s.state.hooks.transformSystemPrompt({system: 'BUILTIN'}) === 'BUILTIN',
		s.state.hooks.transformSystemPrompt({system: 'BUILTIN'}),
	);
	cleanup(s);
}

// 6. Session-start notification points at the file actually used.
{
	const s = await runScenario(cwd => writePrompt(cwd, 'APPEND_SYSTEM.md', 'APPEND'));
	s.state.hooks.onSessionStart();
	check(
		'6 session-start notify points at the file in use',
		s.state.notifies.some(m => m.includes(`[system-prompt] using ${join(s.cwd, '.commandcode', 'APPEND_SYSTEM.md')}`)),
		s.state.notifies.join(' | '),
	);
	cleanup(s);
}

// ---- report -------------------------------------------------------------

const total = pass + failures.length;
console.log(`system-prompt: ${pass}/${total} passed`);
if (failures.length > 0) {
	console.error('\nFAILURES:');
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exit(1);
}
