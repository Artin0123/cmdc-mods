import { Plugin } from "@opencode/plugin"

const ENV_BLOCK =
  /Here is some useful information about the environment you are running in:\s*<env>[\s\S]*?<\/env>\s*/g
const WORKTREE_MARKER = "tools.opencode.session_move"

const clean = (text: string) =>
  text
    .replace(ENV_BLOCK, "")
    .split(/\n{2,}/)
    .filter((paragraph) => !paragraph.includes(WORKTREE_MARKER))
    .join("\n\n")
    .trim()

export default Plugin.define({
  id: "chat.trim-context",
  async setup(ctx) {
    for (const name of ["context", "compaction", "generate"] as const) {
      await ctx.session.hook(name, (event) => {
        if (event.agent !== "chat") return
        delete event.tools.skill
        event.system = event.system.flatMap((part, index) => {
          if (index === 0 || part.type !== "text") return [part]
          const text = clean(part.text)
          return text ? [{ ...part, text }] : []
        })
      })
    }
  },
})
