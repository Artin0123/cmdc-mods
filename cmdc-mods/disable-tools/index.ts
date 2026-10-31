import type {ModApi} from '@commandcode/harness';

/**
 * disable-tools
 *
 * DISABLED_TOOLS below lists tool wire names (the ones /agents' advanced
 * list shows) to remove from the model's tool surface entirely: no schema,
 * no execution, not even in sub-agents. This is the mod-host tool filter
 * (setActiveTools) — not permission deny, which only blocks execution while
 * the schema still rides in every request.
 *
 * Applied at session start and re-applied on every run_start, so tools that
 * register late (background MCP servers) are only ever filtered when they
 * are actually listed — a stale snapshot never disables anything on its
 * own. Editing the constant applies on the next /mods reload (or new
 * session). An empty list never calls setActiveTools, so it neither
 * disables anything nor clobbers another mod's filter.
 *
 * Known gap: shouldDefer tools (web, sleep, task_*, worktrees, …) ride the
 * deferred-tools pipeline — search_tools' pool is not filtered by the mod
 * host, so a disabled deferred tool can still be discovered and its schema
 * loaded; the execution refusal is what actually stops it.
 */

const DISABLED_TOOLS: string[] = [
	// 'web_search',
];

export default function (cmd: ModApi): void {
	const disabled = new Set(
		DISABLED_TOOLS.map(name => name.trim()).filter(name => name !== ''),
	);

	// active = registered − disabled. Fresh tool list on every apply:
	// registered late (background MCP tools) stay visible unless the constant
	// names them; listed names take effect as soon as they register.
	const applyToolFilter = (): void => {
		if (disabled.size === 0) return;
		const all = cmd.getAllTools();
		cmd.setActiveTools(all.filter(name => !disabled.has(name)));
	};

	// Registered at load, so the listener is not session-scoped and survives
	// every later session bind. Handlers run after services exist — calling
	// setActiveTools here reads the real registry, never an empty one.
	cmd.on('run_start', applyToolFilter);

	cmd.hooks({
		onSessionStart() {
			// First apply: runs after the host binds services and flushes
			// deferred actions, so the registry is full.
			applyToolFilter();
			if (disabled.size > 0) {
				cmd.ui.notify(
					`[disable-tools] tools disabled: ${[...disabled].join(', ')}`,
				);
			}
		},
	});
}
