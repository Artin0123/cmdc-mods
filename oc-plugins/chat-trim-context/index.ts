import { Plugin } from "@opencode/plugin"

const ENV_PARAGRAPHS = [
  "Here is some useful information about the environment you are running in:",
  "The environment you are running in is now:",
]

const clean = (text: string) =>
  text
    .split(/\n{2,}/)
    .filter((paragraph) => !ENV_PARAGRAPHS.some((prefix) => paragraph.startsWith(prefix)))
    .join("\n\n")
    .trim()

export default Plugin.define({
  id: "chat.trim-context",
  async setup(ctx) {
    for (const name of ["context", "compaction", "generate"] as const) {
      await ctx.session.hook(name, (event) => {
        if (event.agent !== "chat") return
        event.system = event.system.flatMap((part, index) => {
          if (index === 0 || part.type !== "text") return [part]
          const text = clean(part.text)
          return text ? [{ ...part, text }] : []
        })
      })
    }
  },
})