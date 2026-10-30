# cmdc-mods

給 [Command Code](https://commandcode.ai) 用的 mods。一個 mod 一個資料夾，可單獨啟用。

| mod | 做什麼 |
| --- | --- |
| `system-prompt` | 用 `SYSTEM.md` / `APPEND_SYSTEM.md` 自訂或附加系統提示詞 |
| `shell-windows` | Windows `shell_command` 整合層：unix 指令透明路由 Git Bash；純 cmd 指令包 PowerShell 修 UTF-8 亂碼 |

```
mods/system-prompt/index.ts
mods/shell-windows/index.ts
test/shell-windows/index.mjs
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
cp -r mods/shell-windows ~/.commandcode/mods/
```

> **1、2 只選一種，不要混用。** 混用會讓同一個 mod 出現兩份（名稱都叫 `system-prompt` / `shell-windows`），載入器只保留第一個並警告。

## 確認有載入

```bash
cmdc mods list
```

```
Mods (2)
  shell-windows  · user · from git:github.com/Artin0123/cmdc-mods
  system-prompt  · user · from git:github.com/Artin0123/cmdc-mods
```

## 停用 / 移除

```bash
cmdc mods disable shell-windows      # 停用，檔案留著
cmdc mods enable  shell-windows
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

## shell-windows

**只影響 Windows，只影響 `shell_command`。一個 hook、每行指令一個決策點。**

### 每行指令走法

| 指令形態 | 走法 |
| --- | --- |
| 開頭是 `bash` / `sh` / `zsh` | 直接換成 Git Bash 路徑（不經過 System32 的 WSL stub） |
| 行內有 unix 工具（`ls`、`grep`、…） | 整行路由 `"C:\...\Git\bin\bash.exe" -c '<line>'`，bash 自產 UTF-8 |
| 純 cmd 指令（`dir`、`ipconfig`、…） | 包 `powershell -EncodedCommand`，console CP 65001 再進 cmd |
| 輸出本來就是 UTF-8 的工具（`git`、`node`、`python`…） | 不包裝，+0ms |

路由時順手翻譯：cmd 內建（`dir`/`copy`/`del`/`rd`/`set`/`ren`/`type`/simple `if`/`for`/`mklink`）、
`%VAR%`→`$VAR`、`%ERRORLEVEL%`→`$?`、`C:\a\b`→`C:/a/b`、`2>&1` 原樣保留、
cmd 的裸 `a & b` → bash `a ; b`（依序而非丟背景）、`2>nul`/`>nul`/`<nul` → `/dev/null`。

翻不動的（照原樣大聲失敗，不猜測）：`goto`、label、帶 flag 的 `if`/`for`巢狀、`mklink /j`、delayed expansion。

### 會看到什麼

| 項目 | 變化 |
| --- | --- |
| 中文檔名、`echo` 的中文、程式輸出的中文（純 cmd 行） | 正常顯示 |
| 工具自己的訊息標頭 | 變英文，例如 `Volume in drive C has no label.` |
| unix 指令在 Windows | 直接可用 |

指令語意不變：`&&`、`|`、`>`、`%VAR%`、引號、離開碼都跟原生 `cmd` 一致。

### 成本

路由行：bash 啟動約 +50 ms；被包裝的純 cmd 行：約 **+120 ms**（PowerShell 啟動）。UTF-8 工具跳過。

### 已知缺口

| 缺口 | 說明 |
| --- | --- |
| 路由行內的 `cmd //c` 中文輸出會亂碼 | 內層 cmd 的 GBK 未經包裝；混合行的中文本來就沒修，路由不改這一點 |
| 純 cmd 行超過 1800 字元不包裝 | Windows 命令列長度上限；路由行另有 7000 上限 |
| 只涵蓋 `shell_command` | 背景的 `monitor_command` 不受影響 |
| Python < 3.15 | 3.15 起預設 UTF-8；更舊的自行 `set "PYTHONIOENCODING=utf-8" &&` |

---

## 開發

```bash
node test/shell-windows/index.mjs
```

需要 Node ≥ 22.6（23.6 起預設支援 `.ts`，更舊的要加 `--experimental-strip-types`）。

`test/` 跟 `mods/` 分開放：mod 資料夾裡任何 `.ts` / `.js` / `.mts` / `.mjs` 都會被當成另一個 mod，測試檔放進去會變成第二個 mod。
