// Regression tests for cmdc-mods/disable-tools/index.ts
//
//   node cmdc-mods/tests/disable-tools/index.mjs
//
// The tool list lives in the mod source itself (DISABLED_TOOLS), so each
// scenario copies index.ts into a fresh temp dir, rewrites the constant by
// string substitution, imports it, and drives a stub cmd: onSessionStart +
// run_start events against a fake tool registry.
//
// Needs Node >= 22.6 with --experimental-strip-types (default from 23.6).
//
// NOTE: tests live in the HOST folder's tests/ (cmdc-mods/tests/), outside
// the mod folder -- keeping plugin folders clean regardless of each host's
// discovery rules.

import {copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const modSource = join(here, '..', '..', 'disable-tools', 'index.ts');
const modText = readFileSync(modSource, 'utf8');

let pass = 0;
const failures = [];
const check = (name, ok, detail) => {
	if (ok) pass++;
	else failures.push(detail === undefined ? name : `${name} -> ${detail}`);
};

// ---- scaffold -----------------------------------------------------------

// Stub cmd: records setActiveTools calls, keeps a mutable fake registry,
// and lets the test fire run_start. onSessionStart comes from cmd.hooks.
const makeCmd = tools => {
	const state = {
		notifies: [],
		active: null, // last setActiveTools argument (array) or null (never called)
		activeCalls: 0,
		events: {},
		hooks: {},
	};
	return {
		ui: {notify: message => state.notifies.push(message)},
		on: (event, handler) => {
			(state.events[event] ??= []).push(handler);
			return {dispose() {}};
		},
		hooks: hooks => Object.assign(state.hooks, hooks),
		getAllTools: () => [...tools()],
		setActiveTools: names => {
			state.activeCalls++;
			state.active = [...names];
		},
		state,
	};
};

const fireRunStart = state => {
	for (const handler of state.events.run_start ?? []) handler({});
};

// Registered names, in registry order.
const REGISTRY = ['read_file', 'grep', 'shell_command', 'web_search', 'mcp__srv__old'];

// Rewrite the DISABLED_TOOLS constant in a copied source tree.
const injectList = names =>
	modText.replace(
		'const DISABLED_TOOLS: string[] = [',
		`const DISABLED_TOOLS: string[] = [${names.map(name => `'${name}'`).join(', ')},`,
	);

const runScenario = async (disabledNames, {tools = () => REGISTRY} = {}) => {
	const dir = mkdtempSync(join(tmpdir(), 'disable-tools-test-'));
	writeFileSync(join(dir, 'index.ts'), injectList(disabledNames));
	const mod = await import(pathToFileURL(join(dir, 'index.ts')).href);
	const cmd = makeCmd(tools);
	mod.default(cmd);
	cmd.state.hooks.onSessionStart();
	return {dir, state: cmd.state};
};

const cleanup = ({dir}) => rmSync(dir, {recursive: true, force: true});

const eq = actual => JSON.stringify(actual);

// ============ A. filter application ============

// A1. Empty constant (shipped default): hands off -- setActiveTools is
//     never called, so another mod's filter settings cannot be clobbered.
{
	const s = await runScenario([]);
	check('A1 empty list: setActiveTools never called', s.state.activeCalls === 0);
	check(
		'A1 empty list: no tools-disabled notify',
		s.state.notifies.every(m => !m.includes('tools disabled')),
	);
	cleanup(s);
}

// A2. Valid list: active = registry − disabled, applied at session start.
{
	const s = await runScenario(['web_search', 'mcp__srv__old']);
	check(
		'A2 active set excludes listed tools, keeps the rest',
		eq(s.state.active) === eq(['read_file', 'grep', 'shell_command']),
		s.state.active && eq(s.state.active),
	);
	check(
		'A2 notify names the disabled tools',
		s.state.notifies.some(m => m.includes('tools disabled: web_search, mcp__srv__old')),
		s.state.notifies.join(' | '),
	);
	cleanup(s);
}

// A3. Entries are trimmed; blanks dropped.
{
	const s = await runScenario([' web_search ', '  ', 'grep']);
	check(
		'A3 trimmed list filters correctly',
		eq(s.state.active) === eq(['read_file', 'shell_command', 'mcp__srv__old']),
		s.state.active && eq(s.state.active),
	);
	check(
		'A3 notify shows the cleaned names',
		s.state.notifies.some(m => m.includes('tools disabled: web_search, grep')),
	);
	cleanup(s);
}

// ============ B. freshness (run_start re-apply) ============

// B1. Late MCP arrival (registry grows after session start): the new tool
//     stays ACTIVE unless listed -- a stale snapshot must not disable it.
{
	let registry = [...REGISTRY];
	const s = await runScenario(['grep'], {tools: () => registry});
	registry.push('mcp__srv__new'); // background MCP server connects later
	fireRunStart(s.state);
	check(
		'B1 late-arriving unlisted tool stays active',
		s.state.active.includes('mcp__srv__new') && !s.state.active.includes('grep'),
		s.state.active && eq(s.state.active),
	);
	cleanup(s);
}

// B2. Listed name that registers late is filtered at the next apply; before
//     that apply the registered tools are untouched by the pending name.
{
	let registry = ['read_file', 'shell_command'];
	const s = await runScenario(['mcp__srv__late'], {tools: () => registry});
	check(
		'B2 pre-arrival: registry passes through unfiltered',
		eq(s.state.active) === eq(registry),
		s.state.active && eq(s.state.active),
	);
	registry = [...registry, 'mcp__srv__late', 'grep'];
	fireRunStart(s.state);
	check(
		'B2 late-arriving listed tool gets filtered',
		eq(s.state.active) === eq(['read_file', 'shell_command', 'grep']),
		s.state.active && eq(s.state.active),
	);
	cleanup(s);
}

// ---- report -------------------------------------------------------------

const total = pass + failures.length;
console.log(`disable-tools: ${pass}/${total} passed`);
if (failures.length > 0) {
	console.error('\nFAILURES:');
	for (const failure of failures) console.error(`  - ${failure}`);
	process.exit(1);
}
