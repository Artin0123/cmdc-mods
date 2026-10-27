import {existsSync, readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {resolve} from 'node:path';
import type {ModApi} from '@commandcode/harness';

/**
 * cmdc-system-prompt
 *
 * Filename IS the feature (pi-agent naming, Command Code locations).
 * Zero settings - create a file, done:
 *
 *   APPEND_SYSTEM.md   -> appended AFTER Command Code's system prompt
 *   SYSTEM.md          -> REPLACES Command Code's system prompt entirely
 *
 * Each name resolves at two levels (first hit wins), mirroring how
 * Command Code resolves AGENTS.md:
 *   1. <cwd>/.commandcode/<NAME>     (project-local, wins)
 *   2. ~/.commandcode/<NAME>         (global)
 *
 * When both SYSTEM.md and APPEND_SYSTEM.md exist: SYSTEM.md replaces the
 * built-in prompt, APPEND_SYSTEM.md is appended after the replacement.
 *
 * Files are re-read every round: unchanged file = unchanged bytes, so the
 * prompt-prefix cache stays warm; editing applies from the next model call;
 * deleting a file restores stock behavior for that part. No file, no effect.
 */

const REPLACE_FILE = 'SYSTEM.md';
const APPEND_FILE = 'APPEND_SYSTEM.md';

function readFirst(paths: string[]): string | undefined {
	for (const path of paths) {
		if (!existsSync(path)) continue;
		const text = readFileSync(path, 'utf8').trim();
		if (text !== '') return text;
	}
	return undefined;
}

export default function (cmd: ModApi): void {
	const replacePaths = (): string[] => [
		resolve(cmd.cwd, '.commandcode', REPLACE_FILE),
		resolve(homedir(), '.commandcode', REPLACE_FILE),
	];
	const appendPaths = (): string[] => [
		resolve(cmd.cwd, '.commandcode', APPEND_FILE),
		resolve(homedir(), '.commandcode', APPEND_FILE),
	];

	cmd.hooks({
		appendSystemPrompt() {
			return readFirst(appendPaths());
		},

		// SYSTEM.md semantics: replace the built-in prompt; APPEND_SYSTEM.md
		// then lands after the replacement (the append hook already ran, so
		// re-attach its text here to keep it after the replacement).
		transformSystemPrompt({system}) {
			const replace = readFirst(replacePaths());
			if (!replace) return system;
			const append = readFirst(appendPaths());
			return append ? `${replace}\n\n${append}` : replace;
		},

		onSessionStart() {
			const found = [...appendPaths(), ...replacePaths()].find(path =>
				existsSync(path),
			);
			if (found) cmd.ui.notify(`[system-prompt] using ${found}`);
		},
	});
}
