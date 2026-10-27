# cmdc-mods

給 [Command Code](https://commandcode.ai) 用的 mods。一個 mod 一個資料夾，可單獨啟用。

| mod | 做什麼 |
| --- | --- |
| `system-prompt` | 用 `SYSTEM.md` / `APPEND_SYSTEM.md` 自訂或附加系統提示詞 |
| `shell-utf8` | Windows 上修掉 `shell_command` 的中文亂碼 |

```
mods/system-prompt/index.ts
mods/shell-utf8/index.ts
test/shell-utf8/index.mjs
```

mod 的名稱取自資料夾名（`index.ts` 就是 mod 本體）。

## 安裝（二選一）

### 1. 套件（推薦）

```bash
cmdc mods add Artin0123/cmdc-mods -g
```

### 2. 手動：複製資料夾

```bash
cp -r mods/system-prompt ~/.commandcode/mods/
cp -r mods/shell-utf8    ~/.commandcode/mods/
```

> **1、2 只選一種，不要混用。** 混用會讓同一個 mod 出現兩份（名稱都叫 `system-prompt` / `shell-utf8`），載入器只保留第一個並警告。

## 確認有載入

```bash
cmdc mods list
```

```
Mods (2)
  shell-utf8     · user · ~\.commandcode\mods\shell-utf8\index.ts
  system-prompt  · user · ~\.commandcode\mods\system-prompt\index.ts
```

## 停用 / 移除

```bash
cmdc mods disable shell-utf8      # 停用，檔案留著
cmdc mods enable  shell-utf8
cmdc mods remove  Artin0123/cmdc-mods
```

單次 session 只載入內建模組：`cmdc --safe-mode`

---

## system-prompt

建立檔案就生效，沒有指令也沒有 flag：

| 檔名 | 效果 |
| --- | --- |
| `APPEND_SYSTEM.md` | 附加在內建提示詞之後 |
| `SYSTEM.md` | 整份取代內建提示詞（含 identity 與安全指令，慎用） |

放這裡，先找到先用（專案優先於全域）：

```
<專案>/.commandcode/APPEND_SYSTEM.md
<專案>/.commandcode/SYSTEM.md
~/.commandcode/APPEND_SYSTEM.md
~/.commandcode/SYSTEM.md
```

兩個都有時：`SYSTEM.md` 先取代，`APPEND_SYSTEM.md` 再附加在後面。

每輪都重讀：改檔下一輪生效、不用重啟；刪檔恢復預設；檔案不存在或空白則完全不作用。位元組沒變時 prompt cache 不會破。

實測（command-code 1.88.0，inputTokens）：

| 情境 | inputTokens |
| --- | --- |
| 基準（無 mod、無檔案） | ~16,265 |
| `APPEND_SYSTEM.md`（一行 marker） | 16,283 |
| `SYSTEM.md`（一行 marker 取代） | 7,593 |

範例檔：[`mods/system-prompt/SYSTEM_PROMPT.example.md`](mods/system-prompt/SYSTEM_PROMPT.example.md)

---

## shell-utf8

**只影響 Windows，只影響 `shell_command`。**

### 解決什麼

`cmd.exe` 在中文 Windows 輸出 GBK 位元組，harness 用 UTF-8 解，中文就變成 `����`：

```
GBK: 20 c7 fd b6 af c6 f7   →   " � "
```

裝了之後 `dir`、`ipconfig`、`netstat`、`findstr`、`tasklist` 的中文內容都正常。

### 會看到什麼

| 項目 | 變化 |
| --- | --- |
| 中文檔名、`echo` 的中文、程式輸出的中文 | 正常顯示 |
| 工具自己的訊息標頭 | 變英文，例如 `Volume in drive C has no label.` |

指令語意不變：`&&`、`|`、`>`、`%VAR%`、引號、離開碼都跟原生 `cmd` 一樣。

### 成本

被包裝的指令多約 **+120 ms**（PowerShell 啟動）。`git`、`node`、`python`、`rg`、`jq` 這類本來就輸出 UTF-8 的工具會跳過，不付這個成本。

### 限制

| 限制 | 說明 |
| --- | --- |
| 只涵蓋 `shell_command` | 背景的 `monitor_command` 不受影響，亂碼也不會被修 |
| 指令超過 1800 字元不包裝 | Windows 命令列長度上限 |
| 冷啟動比熱啟動慢 | 熱態 +120 ms 已量，冷態未量 |
| Python < 3.15 | 3.15 起預設 UTF-8；更舊的版本自行加 `set "PYTHONIOENCODING=utf-8" &&` |

---

## 開發

```bash
node test/shell-utf8/index.mjs
```

需要 Node ≥ 22.6（23.6 起預設支援 `.ts`，更舊的要加 `--experimental-strip-types`）。

`test/` 跟 `mods/` 分開放：mod 資料夾裡任何 `.ts` / `.js` / `.mts` / `.mjs` 都會被當成另一個 mod，測試檔放進去會變成第二個 mod。
