# cmd-mod-system-prompt

讓 Command Code 支援 pi agent 慣例的系統提示詞檔案——**檔名即功能，零設定**。

## 用法

建立檔案，完成。沒有指令、沒有 flag、沒有設定：

| 檔名               | 效果                                                       |
| ------------------ | ---------------------------------------------------------- |
| `APPEND_SYSTEM.md` | **附加**在 Command Code 內建系統提示詞之後                 |
| `SYSTEM.md`        | **整份取代**內建系統提示詞（含 identity 與安全指令，慎用） |

兩個層級（先找到先用，專案蓋全域）：

```
<專案>/.commandcode/APPEND_SYSTEM.md   ← 專案層級，優先
~/.commandcode/APPEND_SYSTEM.md        ← 全域

<專案>/.commandcode/SYSTEM.md
~/.commandcode/SYSTEM.md
```

兩個檔同時存在時：`SYSTEM.md` 先取代內建提示詞，`APPEND_SYSTEM.md` 再附加在替換後的提示詞之後（pi 語義）。

## 行為細節

- **每輪即時讀檔**：檔案沒變 → 位元組不變，prompt cache 不破；改了檔 → 下一輪自動生效（不用 reload、不用重啟）；刪了檔 → 該功能自動失效
- 檔案不存在或只有空白 → mod 完全 no-op
- 空檔/讀取失敗不會炸 session

## 安裝

```bash
cp index.ts ~/.commandcode/mods/system-prompt.ts
```

驗證：`cmdc mods list` 應列出 `system-prompt`；`cmdc mods inspect` 應顯示 hooks: `appendSystemPrompt, transformSystemPrompt, onSessionStart`。

## 已驗證（command-code 1.88.0 實測）

| 情境                              | inputTokens | 結果                                                 |
| --------------------------------- | ----------- | ---------------------------------------------------- |
| 基準（無 mod / 無檔案）           | ~16,265     | —                                                    |
| `APPEND_SYSTEM.md`（1 行 marker） | 16,283      | 回覆帶 marker token ✅                                |
| `SYSTEM.md`（1 行 marker 取代）   | 7,593       | 回覆帶 marker token ✅（少了 ~8.7k = 內建提示詞重量） |
