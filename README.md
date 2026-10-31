# harness-plugins

**Harness 插件合集**：同一套「環境修復」理念（見 [`AGENTS.md`](AGENTS.md)），各 host 各自實作、放在各自的資料夾：

| host         | 資料夾           | 發現方式                                                         |
| ------------ | ---------------- | ---------------------------------------------------------------- |
| Command Code | `cmdc-mods/`     | `package.json` 的 `commandcode.mods` 宣告                        |
| pi           | `pi-extensions/` | `package.json` 的 `pi.extensions` manifest（指向目錄即整層發現） |
| OpenCode v2  | `oc-plugins/`    | `opencode plugin add` 的 `::path:` 子路徑選擇器                  |

| 名稱                | host      | 做什麼                                                                                                                         |
| ------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `env-guard`         | cmdc / pi | 環境修復層（詳見下方各章節）                                                                                                   |
| `system-prompt`     | cmdc      | 用 `SYSTEM.md` / `APPEND_SYSTEM.md` 自訂或附加系統提示詞                                                                       |
| `chat-trim-context` | OpenCode  | `id: chat.trim-context` — 針對 `chat` agent，每次送出模型請求前清理系統提示：移除 `<env>...</env>` 段落與 worktree marker 段落 |

```
cmdc-mods/system-prompt/index.ts      # Command Code
cmdc-mods/env-guard/index.ts          # Command Code
cmdc-mods/tests/env-guard/index.mjs   # env-guard（cmdc 版）的回歸測試
pi-extensions/env-guard/index.ts      # pi
pi-extensions/tests/env-guard/index.mjs # env-guard（pi 版）的單元電池
oc-plugins/chat-trim-context/         # OpenCode v2
```

mod/extension/plugin 名稱取自資料夾名（`index.ts` 就是本體）。三個 host 都支援
「單檔」與「`index.ts` 資料夾」兩種形式；本 repo 統一用**資料夾式**，版面一致。

## package.json 佈局

每個 host 資料夾各有**自己的 `package.json`**（`cmdc-mods/`、`pi-extensions/`、
`oc-plugins/`）——名稱、說明、keywords 隨 host 各自表述，並帶各自的 manifest，
所以單一 host 資料夾可以直接安裝：`cmdc mods add ./cmdc-mods`、
`pi install ./pi-extensions`。

根目錄的 `package.json` **只保留 cmdc / pi 雲端（git）安裝必需的 manifest**、
不帶共用說明：cmdc 與 pi 的 git 套件 package root 都是 repo 根目錄
（`commandcode.mods` 與 `pi.extensions` 必須宣告在根、指向 root 內的路徑，
兩者都不支援 git 子路徑安裝）；OpenCode 不受限——它用 `::path:` 子路徑選擇器
直接指到 `oc-plugins/chat-trim-context/`（該資料夾另有一份自己的 package.json）。


## 安裝（Command Code，二選一）

### 1. 套件（推薦）

```bash
cmdc mods add Artin0123/harness-plugins -g
```

### 2. 手動：複製資料夾

```bash
cp -r cmdc-mods/system-prompt ~/.commandcode/mods/
cp -r cmdc-mods/env-guard ~/.commandcode/mods/
```

> **1、2 只選一種。**

```bash
cmdc mods list        # 確認
cmdc mods disable env-guard      # 停用，檔案留著
cmdc mods enable  env-guard
cmdc mods remove  Artin0123/harness-plugins
```

單次 session 只載入內建模組：`cmdc --safe-mode`

## 安裝（pi，二選一）

### 1. 套件（推薦）

repo 根的 `package.json` 帶 `pi.extensions` manifest 指向 `pi-extensions/`（雲端 git
安裝）；單裝 pi 這個 host 也可直接指到資料夾本身（它有自己的 package.json）：

```bash
pi install git:github.com/Artin0123/harness-plugins
```

### 2. 手動：複製資料夾

```bash
cp -r pi-extensions/env-guard ~/.pi/agent/extensions/
```

> **1、2 只選一種。** pi 以來源識別套件，重複宣告會載入兩份。

```bash
pi list                                  # 確認套件
pi remove git:github.com/Artin0123/harness-plugins
```

單次不載入擴充：`pi --no-extensions`

## 安裝（OpenCode v2，二選一）

需要 OpenCode **v2** 以上（`@opencode/plugin` V2 API）。

### 1. 指令安裝（GitHub 套件 + 子路徑選擇器）

```sh
opencode plugin add "github:Artin0123/harness-plugins#master::path:oc-plugins/chat-trim-context"
```

- 登記到全域 `~/.config/opencode/opencode.json` 的 `plugins`；實體安裝在 `~/.cache/opencode/npm/`
- 以 `#master` 跟隨 master 分支，之後 `opencode plugin update chat.trim-context` 更新到最新 commit；釘版本就用完整 commit hash
- 管理指令：`opencode plugin list` / `check` / `remove`——注意 `list` 只列本地插件目錄裡的；指令安裝的要用 `check` 看（會顯示插件 id 與所在 commit）

### 2. 本地檔案安裝

把插件資料夾放進 OpenCode 的插件目錄（啟動時自動載入）：

- 全域：複製 `oc-plugins/chat-trim-context/` 到 `~/.config/opencode/plugins/`
- 專案層級：複製到專案的 `.opencode/plugins/`
- 更新就重新拉 repo 再覆蓋一次

> **1、2 只選一種。**

---

## system-prompt (cmdc-mods)

建立檔案就生效，沒有指令也沒有 flag：

| 檔名               | 效果                                               |
| ------------------ | -------------------------------------------------- |
| `APPEND_SYSTEM.md` | 附加在內建提示詞之後                               |
| `SYSTEM.md`        | 整份取代內建提示詞（含 identity 與安全指令，慎用） |

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

| 情境                              | inputTokens |
| --------------------------------- | ----------- |
| 基準（無 mod、無檔案）            | ~16,265     |
| `APPEND_SYSTEM.md`（一行 marker） | 16,283      |
| `SYSTEM.md`（一行 marker 取代）   | 7,593       |

範例檔：[`cmdc-mods/system-prompt/SYSTEM_PROMPT.example.md`](cmdc-mods/system-prompt/SYSTEM_PROMPT.example.md)

---

## env-guard (cmdc-mods)

**只影響 Windows。管 shell 語意的三個工具（`shell_command`、`powershell`、`monitor_command`）與檔案六件套的路徑。一個 hook、每次呼叫一個決策點。**

### 每行指令走法

| 指令形態                                              | 走法                                                              |
| ----------------------------------------------------- | ----------------------------------------------------------------- |
| 開頭是 `bash` / `sh` / `zsh`                          | 直接換成 Git Bash 路徑（不經過 System32 的 WSL stub）             |
| 行內有 unix 工具（`ls`、`grep`、…）                   | 整行路由 `"C:\...\Git\bin\bash.exe" -c '<line>'`，bash 自產 UTF-8 |
| 純 cmd 指令（`dir`、`ipconfig`、…）                   | 包 `powershell -EncodedCommand`，console CP 65001 再進 cmd        |
| 輸出本來就是 UTF-8 的工具（`git`、`node`、`python`…） | 不包裝，+0ms                                                      |

路由時順手翻譯：cmd 內建（`dir`/`copy`/`del`/`rd`/`set`/`ren`/`type`/simple `if`/`for`/`mklink`）、
`%VAR%`→`$VAR`、`%ERRORLEVEL%`→`$?`、`C:\a\b`→`C:/a/b`、`2>&1` 原樣保留、
cmd 的裸 `a & b` → bash `a ; b`（依序而非丟背景）、`2>nul`/`>nul`/`<nul` → `/dev/null`。
bash 語法的 `for i in …; do …; done` 與 `if …; then …; fi` 不誤判成 cmd（段首 `do`/`done`/`then`/`fi` 是 bash 鐵證），整行原樣交給 bash；
`bash -c '…'` 的 payload 帶 cmd 活字元（`"` `%` `$(` `` ` `` `<>|&`，cmd 不認單引號）時改送暫存腳本，乾淨 payload 維持 inline。
檔案工具（write/edit/read/glob/grep/read_directory）的 `/tmp`、`$TEMP`、`$TMP`、`c:/tmp` 改寫到 bash 的真實 temp；MSYS 盤符路徑 `/c/...` → `C:/...`（否則 host 端靜默落在 `C:\c\...`）。

翻不動的（照原樣大聲失敗，不猜測）：`goto`、label、帶 flag 的 `if`/`for`巢狀（`for /L` 等 cmd 原生可跑的維持 cmd wrap）、`mklink /j`、delayed expansion。

### 會看到什麼

| 項目                                                 | 變化                                           |
| ---------------------------------------------------- | ---------------------------------------------- |
| 中文檔名、`echo` 的中文、程式輸出的中文（純 cmd 行） | 正常顯示                                       |
| 工具自己的訊息標頭                                   | 變英文，例如 `Volume in drive C has no label.` |
| unix 指令在 Windows                                  | 直接可用                                       |

指令語意不變：`&&`、`|`、`>`、`%VAR%`、引號、離開碼都跟原生 `cmd` 一致。

### 成本

路由行：bash 啟動約 +50 ms；被包裝的純 cmd 行：約 **+120 ms**（PowerShell 啟動）。UTF-8 工具跳過。

### 已知缺口

| 缺口                                | 說明                                                                                                                                               |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 路由行內的 `cmd //c` 中文輸出會亂碼 | 內層 cmd 的 GBK 未經包裝；混合行的中文本來就沒修，路由不改這一點                                                                                   |
| 純 cmd 行超過 1800 字元不包裝       | Windows 命令列長度上限；路由行另有 7000 上限                                                                                                       |
| 覆蓋範圍                            | shell 語意的三個工具（`shell_command`、`powershell`、`monitor_command` 單字串形式走同一套路由；args 分開傳的形式原生正確，不動）＋檔案六件套的路徑 |
| Python < 3.15                       | 3.15 起預設 UTF-8；更舊的自行 `set "PYTHONIOENCODING=utf-8" &&`                                                                                    |

---

## env-guard (pi-extensions)

**只影響 Windows。管 `bash` 工具的指令與 `write`/`edit`/`read`/`grep`/`find`/`ls` 的 `path`。**

pi 直接 spawn bash（沒有 cmd.exe 中介層），所以修法不同：

| 項目                                                  | pi 版做法                                                                                                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `/tmp`、`$TEMP`、`$TMP`、`$TMPDIR`、`%TEMP%`、`%TMP%` | 檔案工具 host 端解析不經 MSYS 映射、不展開變數 → 改寫到 `cygpath -w /tmp` 探測的真實 temp（與 bash 的 `/tmp` 同一錨點）                          |
| `cmd //c` / `//k`                                     | bashrc 的 `MSYS_NO_PATHCONV=1` 讓雙斜線原樣抵達 cmd → 進互動模式（橫幅、指令沒跑、exit 0）。以子 bash 探測實際值，確認關閉才改寫；探測失敗不改寫。**實測**：pi 的 bash 經 `BASH_ENV` 一樣載入 bashrc、病理重現——banner 與 `ver` 輸出幾乎同形，無修復時模型會把 banner 誤讀成指令結果（靜默錯誤答案） |
| cmd + 非 ASCII                                        | 實測 cmd 輸入端在 ANSI 轉換時已毀損、輸出非 UTF-8，無法忠實改寫 → 發警告，建議改用 bash 原生工具或 PowerShell 原生命令                           |

**刻意不修**（原生行為或模型自身錯誤，讓它壞）：`C:\tmp`（原生寫入會成功）、
**MSYS 盤符路徑 `/c/...`**（pi 的檔案工具解析層內建 `normalizeWindowsShellPath`
原生正確映射 `/c/Users/x`→`C:\Users\x`（含 `/mnt/d`、`/cygdrive/e`），e2e 實測
無 `C:\c` 錯位——盤符修復只在沒有這層正規化的 host 才合理）、
裸 `>nul`/`&>nul`/`"nul"`（實測 pi 的 bash 把 nul 映射到丟棄裝置，不建檔——
病理在這個執行層不存在；會建檔的僅限同進程 `/dev/null` 共存的 MSYS 原生行為，
`rm nul` 可刪）、`<nul`（bash 直接報 ENOENT）、`2>&nul`/`<&nul`（ambiguous
redirect，大聲失敗）、其他 cmd-ism（`del`、`dir /b`、`robocopy //mir`…）、
**原生 exe 的 posix 路徑參數**（`python /tmp/x.py`——`MSYS_NO_PATHCONV=1` 關掉
了對原生程式 argv 的路徑轉換，原生 exe 收到字面 `/tmp/...` 找不到檔；大聲失敗，
agent 可用 `cygpath -w` 自癒。全面改寫 argv 會誤傷依賴 posix 形式的 MSYS 工具
參數，誤修風險大於漏修）。

通知前綴 `env-guard:`；改寫與警告都用 `ctx.ui.notify`，不擋工具執行。

---

## chat-trim-context (oc-plugins)

`id: chat.trim-context` — 針對 `chat` agent，在每次送出模型請求前（`context` / `compaction` / `generate`）清理系統提示：

- 移除 `<env>...</env>` 環境資訊段落
- 移除包含 worktree marker（`tools.opencode.session_move`）的段落

---

## 開發

```bash
node cmdc-mods/tests/env-guard/index.mjs    # cmdc 版回歸測試
node pi-extensions/tests/env-guard/index.mjs # pi 版單元電池（含「刻意不修」釘死）
```

需要 Node ≥ 22.6（23.6 起預設支援 `.ts`，更舊的要加 `--experimental-strip-types`）。

測試放 **host 資料夾的 `tests/` 下**、與插件資料夾分離——插件資料夾保持只含
交付物，手動安裝（`cp -r` 插件資料夾）不會把測試帶進安裝目錄；測試隨 host
歸屬一目了然，不會失聯。

通用判準（原生執行優先、修復審查清單、驗證紀律）見 [`AGENTS.md`](AGENTS.md)。
