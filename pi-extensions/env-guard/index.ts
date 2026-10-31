// env-guard.ts
// 防護 pi 在 Windows 上的路徑與 shell 事故。優先序（最高到最低）：
//
// 1.【原生執行最優先】原生就會壞的，讓它壞——不論失敗是大聲還是靜默。
//    「靜默失敗要修」只在修的對象是『本環境的工具轉換/處理自己弄壞』時才成立；
//    模型寫錯或 bash/Node 原生行為造成的任何失敗（含靜默），一律不介入。
// 2.【環境工具失敗才修】只修這一類：模型寫的語法在它假設的環境裡是正確的，
//    但被本環境的工具轉換或處理弄壞：
//   - /tmp、$TEMP：對 bash 是正確語法，但 write/edit/read/grep/find/ls 工具
//     在 host 端解析，不經 MSYS 映射、不展開變數 → 寫入建成 C:\tmp 或
//     字面 "$TEMP" 資料夾，搜尋類直接報錯（~ 工具自身會正確展開，不需管）。
//     變數形式全擋：$TEMP/$TMP/$TMPDIR、%TEMP%/%TMP%，不分大小寫與分隔符。
//   - cmd //c|//k：原生 git-bash（預設開啟路徑轉換）下 //c 是唯一能用的寫法，
//     但本機 ~/.bashrc 設了 MSYS_NO_PATHCONV=1，//c 原樣抵達 cmd → 進互動模式
//     （印橫幅、指令沒跑、exit 0）。bashrc 對擴充不可見，故以子 bash 探測實際值
//     （見下方 pathConvDisabled），確認轉換關閉才啟用改寫——探測失敗一律不改寫。
//     適用 cmd 與 cmd.exe、指令位置的全部 //字母旗標（含多旗標 cmd //q //c）。
//
// 【刻意不修】原生行為或模型自身錯誤，一概讓它壞：
//   - C:\tmp：write 工具寫 C:\tmp 原生會成功（合法 Windows 路徑）——原生不壞就不修，
//     模型真寫 C:\tmp 就讓它寫。
//   - nul 重導向（> nul、2>nul…）：實測 bash（與 pi spawn 同一顆）把裸 nul 映射到
//     丟棄裝置——多數形態根本不建檔；只有在同 process 先開過 /dev/null 的
//     命令形態（如 `x > nul 2>/dev/null`）才會因 MSYS 裝置映射失效建出實體檔。
//     這是 bash 原生行為（無 pi 介入也一樣），且是模型寫 cmd-ism 的自身錯誤，
//     不符合介入判準；殘留檔 `rm nul` 即可刪。write 工具 path="nul" 同理
//     （Node host 端原生就會建真檔，非 pi 加工）。
//   - < nul：bash 直接報 ENOENT，錯誤訊息自己會說話
//   - 2>&nul、<&nul：ambiguous redirect，大聲失敗且不造檔
//   - 其他 cmd-ism（del、dir /b、robocopy //mir…）：不是所有 shell 語法都能無風險改寫
//
// 位置：~/.pi/agent/extensions/env-guard/index.ts（全域生效，jiti 直接跑 TS；
// 也可整包用 pi install git:github.com/Artin0123/cmdc-mods 安裝）

import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// 不直接信 os.tmpdir()：若 pi 是從 git-bash 啟動，TEMP 可能是 "/tmp" 這種
// MSYS 映射值，Node 直接拿去用會再踩同樣的坑。但也不要預設 AppData 佈局：
// bash 的 /tmp 靠 /etc/fstab 掛載（Git for Windows 預設 usertemp，但自訂 fstab
// 可指向任何地方）。正確解：問偵測到的 bash 本身 `cygpath -w /tmp`——那才是
// bash 的 `> /tmp/x` 與檔案工具看同一個目錄的錨點。探不到才退回 os.tmpdir()
//（磁碟路徑時），再退回家目錄慣例位置。
let bashTmp: string | null = null;
let bashTmpProbed = false;
// bash 偵測結果快取（findBash 會被 realTempDir 與 pathConvDisabled 多次呼叫，
// 掃描+uname 驗證有成本，結果算一次就定）
let bashCache: string | null | undefined;

export function realTempDir(): string {
  if (!bashTmpProbed) {
    bashTmpProbed = true;
    try {
      const bash = findBash();
      if (bash) {
        const p = spawnSync(bash, ["-c", "cygpath -w /tmp"], { timeout: 5000, windowsHide: true });
        const out = (p.stdout?.toString() ?? "").trim();
        if (!p.error && /^[A-Za-z]:[\\/]/.test(out)) bashTmp = out;
      }
    } catch { /* 退回下方備援 */ }
  }
  if (bashTmp) return bashTmp;
  const t = os.tmpdir();
  if (/^[A-Za-z]:[\\/]/.test(t)) return path.normalize(t);
  return path.join(os.homedir(), "AppData", "Local", "Temp");
}
const realTemp = realTempDir();

// ===== MSYS 路徑轉換探測（決定 cmd //c 是否該改寫成 /c）=====
// 改寫方向取決於 bashrc 的 MSYS_NO_PATHCONV，而 bashrc 對本擴充不可見。
// 但 bash -c 會 source 它（BASH_ENV），所以探測子 shell 看到的實際值，結果快取一次：
//   轉換關閉（=1）→ //c 原樣抵達 cmd、進互動模式 → 啟用改寫
//   轉換開啟（預設 git-bash）→ //c 是唯一能動的拼法，改寫它本身就是副作用 → 不改寫
//   探測失敗／找不到 bash → 不改寫（fail-safe：漏修的話 cmd 會印橫幅大聲失敗，
//   模型可自行修正；誤修則是沉默破壞正確語法——寧可漏修，不可誤修）
let noPathConvCache: boolean | null = null;

// ---- bash 自動偵測（掃描 + 驗證身份，不寫死任何安裝路徑）----
// 陷阱：C:\Windows\System32\bash.exe 是 WSL 啟動器（永遠在 PATH 且常排前面）；
// 天真掃 PATH 會抓到它。正確解是「掃描 + 驗證」：每個候選都用 `uname -s` 驗
// 身份——Git Bash = MINGW*_NT-*、MSYS2 = MSYS_NT-*、WSL = Linux、
// Cygwin = CYGWIN_NT-*（別信 OSTYPE：Git Bash 回報 "cygwin"，無法判別）。
// 全部落空 → 回傳 null，相關功能整體停用（inert）：漏修的 cmd 大聲失敗
// 可自修，猜錯路徑後的結果是靜默出錯。
// 候選來源（依優先序，刻意不做套件管理器列舉）：
//   1. PATH 掃描（僅跳過 System32——WSL stub 所在地）
//   2. PATH 上的 git.exe 反推安裝根目錄；同目錄若有 git.shim 則解析 path= 拿
//      真實位置。shim 是必要分支：scoop 這類安裝既不把 bash.exe 放上 PATH
//      也不寫註冊表，git.shim 是唯一的軌跡；winget/choco/Ninite 的 git.exe
//      本尊就在 PATH 上，用不到這分支。這是通用的「跟著 git.exe 找」，
//      不針對任何套件管理器——它們要么把 git 放上 PATH，要么走同一個
//      安裝程式寫下 GitForWindows 註冊表鍵，兩者都已覆蓋。
//   3. Git for Windows 註冊表鍵（安裝程式式安裝會登記 InstallPath）
//   4. 環境變數推導的程式根目錄（覆蓋無註冊表的使用者層安裝）
const MSYS_UNAME = /^(MINGW|MSYS)/;

// Git for Windows 安裝程式登記的註冊表鍵
const GIT_REG_KEYS = [
  "HKLM\\SOFTWARE\\GitForWindows",
  "HKLM\\SOFTWARE\\WOW6432Node\\GitForWindows",
  "HKCU\\SOFTWARE\\GitForWindows",
];

function verifyMsysBash(candidate: string): boolean {
  try {
    const p = spawnSync(candidate, ["-c", "uname -s"], { timeout: 5000, windowsHide: true });
    return !p.error && MSYS_UNAME.test((p.stdout?.toString() ?? "").trim());
  } catch {
    return false;
  }
}

function registryBashRoots(): string[] {
  const roots: string[] = [];
  for (const key of GIT_REG_KEYS) {
    try {
      const p = spawnSync("reg", ["query", key, "/v", "InstallPath"], {
        timeout: 5000,
        windowsHide: true,
      });
      const m = /InstallPath\s+REG_SZ\s+(.+)/i.exec(p.stdout?.toString() ?? "");
      if (m) roots.push(m[1]!.trim());
    } catch { /* 鍵不存在或 reg 不可用 */ }
  }
  return roots;
}

function extraBashRoots(): string[] {
  const envRoots = [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Git"),
    process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Git"),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Git"),
  ].filter((p): p is string => Boolean(p));
  return [...registryBashRoots(), ...envRoots];
}

// 從安裝根目錄推導 bash 候選（Git for Windows 兩個位置都可能）
function bashCandidatesFromRoot(root: string, out: string[], seen: Set<string>) {
  const add = (p: string) => {
    const k = p.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(p); }
  };
  add(path.join(root, "usr", "bin", "bash.exe"));
  add(path.join(root, "bin", "bash.exe"));
}


export function findBash(): string | null {
  if (bashCache !== undefined) return bashCache;
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (p: string) => {
    const k = p.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(p); }
  };
  const pathDirs = (process.env.PATH ?? "").split(";").filter(Boolean);

  // 1) 單次 PATH 掃描：每個目錄可能有 bash.exe 本尊，或 git.exe 可反推安裝根。
  //    這是通用邏輯—— winget/choco/Ninite 都把 Git\cmd 放上 PATH，與其他安裝
  //    同一個迴圈覆蓋，不需特例。找到即回傳；registry/env 根目錄只在 PATH
  //    全軍覆沒時才查（省去每次啟動的 3 個 reg query 子行程）。
  for (const d of pathDirs) {
    const base = d.replace(/[\\]+$/, "");
    if (/\\System32(\\|$)/i.test(base)) continue; // WSL 啟動器 stub 所在地
    add(path.join(base, "bash.exe"));
    const git = path.join(base, "git.exe");
    if (!existsSync(git)) continue;
    let root = path.dirname(git); // 通常是 <安裝根>\cmd
    // shim 只是轉發器：真實 git.exe 的路徑在旁邊的 git.shim（path=，值可能帶引號）。
    // 只有 PATH 上的 git.exe 是 shim 時才會走到這（見上方候選來源註解）。
    const shim = path.join(root, "git.shim");
    if (existsSync(shim)) {
      try {
        const m = /^path\s*=\s*(.+)$/im.exec(readFileSync(shim, "utf8"));
        if (m) root = path.dirname(m[1]!.trim().replace(/^"+|"+$/g, ""));
      } catch { /* shim 讀不了就當作沒有 */ }
    }
    bashCandidatesFromRoot(path.dirname(root), out, seen);
  }
  for (const c of out) {
    if (existsSync(c) && verifyMsysBash(c)) { bashCache = c; return c; }
  }
  // 2) 註冊表 + 環境變數推導的根目錄，最後手段（同樣過 uname 驗證才算數）
  const out2: string[] = [];
  const seen2 = new Set<string>(out.map((p) => p.toLowerCase()));
  for (const root of extraBashRoots()) bashCandidatesFromRoot(root, out2, seen2);
  for (const c of out2) {
    if (existsSync(c) && verifyMsysBash(c)) { bashCache = c; return c; }
  }
  bashCache = null;
  return null;
}

function pathConvDisabled(): boolean {
  if (noPathConvCache === null) {
    noPathConvCache = false; // 失敗時維持「不改寫」
    try {
      const bash = findBash();
      if (bash) {
        const p = spawnSync(bash, ["-c", 'printf %s "$MSYS_NO_PATHCONV"'], {
          timeout: 5000,
          windowsHide: true,
        });
        noPathConvCache = !p.error && (p.stdout?.toString().trim() === "1");
      }
    } catch {
      /* keep false */
    }
  }
  return noPathConvCache;
}

// 在 s 中從 from 開始找與 "$(" 配對的 ")"，回傳其索引；找不到回傳 -1。
// 需理解 bash 的巢狀：引號會重新開啟語境，但引號內的 $( )、反引號仍會作用，
// 單引號則完全字面。遞迴處理雙引號內的命令取代。
function matchParen(s: string, from: number): number {
  let depth = 1;
  let i = from;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "'") {
      let p = i + 1;
      while (p < s.length && s[p] !== "'") p++;
      i = p + 1;
      continue;
    }
    if (c === '"') {
      let p = i + 1;
      while (p < s.length && s[p] !== '"') {
        if (s[p] === "\\") {
          p += 2;
          continue;
        }
        if (s[p] === "$" && s[p + 1] === "(") {
          const cl = matchParen(s, p + 2);
          if (cl === -1) return -1;
          p = cl + 1;
          continue;
        }
        if (s[p] === "`") {
          let q2 = p + 1;
          while (q2 < s.length && s[q2] !== "`") {
            if (s[q2] === "\\") q2++;
            q2++;
          }
          p = q2 + 1;
          continue;
        }
        p++;
      }
      i = p + 1;
      continue;
    }
    if (c === "(") {
      depth++;
      i++;
      continue;
    }
    if (c === ")") {
      depth--;
      if (depth === 0) return i;
      i++;
      continue;
    }
    i++;
  }
  return -1;
}

export function rewritePath(p: string): string {
  // 接續部分統一用反斜線，避免混合分隔符（Windows API 雖兩者通吃，但輸出乾淨一致）
  const norm = (rest: string) => realTemp + rest.replace(/\//g, "\\");
  let m: RegExpExecArray | null;
  // POSIX /tmp（MSYS 掛載不分大小寫、混合分隔符也擋：/tmp、/TMP/x、/tmp\foo）
  m = /^\/tmp([\\/].*)?$/i.exec(p);
  if (m) return norm(m[1] ?? "");
  // bash/cmd 風格的暫存變數：工具不展開任何變數，$TEMP 曾實際建成字面資料夾。
  // $TEMP/$TMP/$TMPDIR 不分大小寫與分隔符全擋（工具語境下任何寫法都不可能展開）
  m = /^\$(?:temp|tmp|tmpdir)([\\/].*)?$/i.exec(p);
  if (m) return norm(m[1] ?? "");
  // cmd 風格 %TEMP%/%TMP%：同樣不被展開 → 字面 %TEMP% 資料夾
  m = /^%(?:temp|tmp)%([\\/].*)?$/i.exec(p);
  if (m) return norm(m[1] ?? "");
  // C:\tmp：刻意不修——原生寫入會成功（合法 Windows 路徑），原生不壞就不修。
  // 裸 nul / NUL：刻意不修。實測 bash 把裸 nul 映射到丟棄裝置（多數形態不建檔），
  // 會建檔的形態是 MSYS 原生行為（見檔頭），非工具層問題
  return p;
}

// bash 指令改寫（語法感知掃描器，單次掃描處理兩件事）：
//   1. cmd //c|//k → cmd /c|/k：MSYS 慣用的雙斜線旗標在 MSYS_NO_PATHCONV=1 下
//      會原樣抵達 cmd，cmd 不認得就進互動模式（印橫幅、指令沒跑、exit 0）——
//      沉默的錯。只在「指令位置」的 cmd 才改寫（echo cmd //c 等資料用法不動）
//   2. 偵測「cmd + 非 ASCII」：實測 cmd 的中文輸出非 UTF-8、且輸入端在
//      ANSI 轉換時就已毀損（連 PowerShell 包裝都救不回），無法忠實改寫，只能發警告
// 語法感知規則：
//   - 單引號/雙引號內的字面「> nul」是資料，不動（cmd //c "dir > nul" 引號內交給 cmd）
//   - heredoc 本體是資料，不動；結束標記行整行原樣跳過（同列殘字非標記，bash 會視為本體）
//   - 反斜線跳脫的字元不構成運算子
//   - 反引號與 $( ) 內是指令位置（會真的執行）；FOO=bar 前綴不結束指令位置
//   - 2>&1 的 & 不是分隔符（前一字元是 > ）
export interface BashScanResult {
  command: string;
  cmdFlagFixed: boolean;  // cmd //c|//k 被改寫為 /c|/k
  cmdNonAscii: boolean;   // 指令位置的 cmd + 非 ASCII（僅警告）
}

export function rewriteBashCommand(command: string): BashScanResult {
  const r = scanBash(command);
  return {
    command: r.command,
    cmdFlagFixed: r.cmdFlagFixed,
    cmdNonAscii: r.sawCmd && r.nonAscii,
  };
}

function scanBash(command: string): BashScanResult & { sawCmd: boolean; nonAscii: boolean } {
  const heredoc = /<<(-?)[ \t]*(["']?)([A-Za-z_][A-Za-z0-9_]*)\2/y; // sticky 已錨定 lastIndex
  const cmdFlag = /\/\/([A-Za-z]+)(?![\w.-])/iy; // cmd 旗標都是字母（/v:on 這類冒號參數自然保留在後）
  const nonAsciiRe = /[^\x00-\x7F]/;
  let out = "";
  let i = 0;
  const n = command.length;
  let pendingDelim: string | null = null;
  let inHeader = false;
  let cmdFlagFixed = false;
  let sawCmd = false;
  let nonAscii = false;
  // token 追蹤：判斷 cmd 是否在「指令位置」（可執行處），避免改到字面資料
  let curTok = "";
  let prevTok = "";
  let prevTokCmdPos = false;
  let cmdPosNext = true;
  let cmdFlagZone = false; // cmd 之後的旗標區（cmd //q //c 的第二個旗標也要改）

  const isCmdTok = (t: string) => {
    const l = t.toLowerCase();
    return l === "cmd" || l === "cmd.exe";
  };

  const commitTok = () => {
    if (!curTok) return;
    prevTokCmdPos = cmdPosNext;
    if (cmdPosNext) {
      sawCmd = sawCmd || isCmdTok(curTok);
      // FOO=bar 環境變數前綴不結束指令位置（FOO=bar cmd …）
      cmdPosNext = /^[A-Za-z_][A-Za-z0-9_]*=/.test(curTok);
    }
    // 旗標區維持規則：cmd 本身開啟旗標區；區內的 /旗標（含剛改寫的）不關閉；其他 token 關閉
    if (cmdFlagZone && !curTok.startsWith("/")) cmdFlagZone = false;
    if (prevTokCmdPos && isCmdTok(curTok)) cmdFlagZone = true;
    prevTok = curTok;
    curTok = "";
  };

  // 双引號內的 $( ) 與 `…` 會真的被 bash 執行（如 R="$(cmd //c ver)"），
  // 必須遞迴掃描；引號本身是字面，但命令取代區域內是完整 shell 語法
  const scanDq = (seg: string): string => {
    let s = "";
    let k = 0;
    const m2 = seg.length;
    while (k < m2) {
      const c = seg[k];
      if (c === "$" && seg[k + 1] === "(") {
        const close = matchParen(seg, k + 2);
        if (close === -1) {
          s += seg.slice(k);
          break;
        }
        const sub = scanBash(seg.slice(k + 2, close));
        s += "$(" + sub.command + ")";
        cmdFlagFixed ||= sub.cmdFlagFixed;
        sawCmd ||= sub.sawCmd;
        nonAscii ||= sub.nonAscii;
        k = close + 1;
        continue;
      }
      if (c === "`") {
        let p = k + 1;
        while (p < m2 && seg[p] !== "`") {
          if (seg[p] === "\\") p++;
          p++;
        }
        if (p >= m2) {
          s += seg.slice(k);
          break;
        }
        const sub = scanBash(seg.slice(k + 1, p));
        s += "`" + sub.command + "`";
        cmdFlagFixed ||= sub.cmdFlagFixed;
        sawCmd ||= sub.sawCmd;
        nonAscii ||= sub.nonAscii;
        k = p + 1;
        continue;
      }
      s += c;
      k++;
    }
    return s;
  };

  while (i < n) {
    // heredoc 本體：逐行原樣複製；結束標記行整行跳過（標記行殘字視為本體，同 bash）
    if (pendingDelim !== null && !inHeader) {
      let lineEnd = command.indexOf("\n", i);
      if (lineEnd === -1) lineEnd = n;
      if (command.slice(i, lineEnd).trim() === pendingDelim) {
        out += command.slice(i, Math.min(lineEnd + 1, n));
        i = lineEnd + 1;
        pendingDelim = null;
        curTok = "";
        prevTok = "";
        cmdPosNext = true; // 標記行後是新指令列
        continue;
      }
      out += command.slice(i, Math.min(lineEnd + 1, n));
      i = lineEnd + 1;
      continue;
    }
    const ch = command[i];
    if (ch === "\n" && pendingDelim !== null && inHeader) {
      out += "\n";
      i++;
      inHeader = false;
      curTok = "";
      prevTok = "";
      continue;
    }
    if (ch === "\\") {
      const seg = command.slice(i, i + 2);
      if (nonAsciiRe.test(seg)) nonAscii = true;
      out += seg;
      curTok += seg; // 跳脫字元屬於當前詞（\> 不構成運算子）
      i += 2;
      continue;
    }
    if (ch === "'") {
      commitTok();
      const end = command.indexOf("'", i + 1);
      if (end === -1) {
        const seg = command.slice(i);
        if (nonAsciiRe.test(seg)) nonAscii = true;
        out += seg;
        break;
      }
      const seg = command.slice(i, end + 1);
      if (nonAsciiRe.test(seg)) nonAscii = true; // 引號內非 ASCII 仍會抵達 cmd（cmd /c "echo 中文"）
      out += seg;
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      commitTok();
      // 找關閉引號：$() 與反引號內會重新開啟引號語境，需跳過整個命令取代區域
      let j = i + 1;
      while (j < n && command[j] !== '"') {
        if (command[j] === "\\") {
          j += 2;
          continue;
        }
        if (command[j] === "$" && command[j + 1] === "(") {
          const close = matchParen(command, j + 2);
          if (close === -1) {
            j = n;
            break;
          }
          j = close + 1;
          continue;
        }
        if (command[j] === "`") {
          let p = j + 1;
          while (p < n && command[p] !== "`") {
            if (command[p] === "\\") p++;
            p++;
          }
          j = p + 1;
          continue;
        }
        j++;
      }
      if (j >= n) {
        const seg = command.slice(i);
        if (nonAsciiRe.test(seg)) nonAscii = true;
        out += scanDq(seg); // 未閉合引號內的 $() 同樣會執行
        break;
      }
      const seg = command.slice(i, j + 1);
      if (nonAsciiRe.test(seg)) nonAscii = true;
      out += scanDq(seg);
      i = j + 1;
      continue;
    }
    if (ch === "<" && command[i + 1] === "<") {
      commitTok();
      heredoc.lastIndex = i;
      const m = heredoc.exec(command);
      if (m) {
        pendingDelim = m[3];
        inHeader = true;
        out += m[0];
        i += m[0].length;
        continue; // 標記行同列的重導向照常掃描（cmd 旗標偵測仍需要）
      }
    }
    if (ch === " " || ch === "\t" || ch === "\n") {
      commitTok();
      if (ch === "\n") cmdPosNext = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === "|" || ch === ";" || ch === "(") {
      commitTok();
      cmdPosNext = true; // 分隔符後是新的指令位置（含 $( 與反引號開頭）
      out += ch;
      i++;
      continue;
    }
    if (ch === "&") {
      commitTok();
      if (command[i - 1] !== ">" && command[i - 1] !== "<") cmdPosNext = true; // 2>&1 的 & 不是分隔符
      out += ch;
      i++;
      continue;
    }
    if (ch === ")" || ch === ">" || ch === "<") {
      commitTok(); // 重定向目標不是指令位置
      out += ch;
      i++;
      continue;
    }
    if (ch === "`") {
      commitTok();
      cmdPosNext = true; // 反引號內是指令位置（關閉反引號後不設，保守不誤判）
      out += ch;
      i++;
      continue;
    }
    // cmd 的雙斜線旗標：僅當 cmd 出現在指令位置（含緊貼形 cmd//c）
    if (ch === "/" && command[i + 1] === "/") {
      const atCmd =
        curTok === ""
          ? (prevTokCmdPos && isCmdTok(prevTok)) || (cmdFlagZone && prevTok.startsWith("/"))
          : cmdPosNext && isCmdTok(curTok);
      if (atCmd && pathConvDisabled()) {
        cmdFlag.lastIndex = i;
        const m = cmdFlag.exec(command);
        if (m) {
          // 緊貼形 cmd//c：cmd 已寫入 out，需補空格分離程式名與旗標
          out += (curTok === "" ? "" : " ") + "/" + m[1];
          i += m[0].length;
          curTok = "/" + m[1];
          cmdFlagFixed = true;
          continue;
        }
      }
      curTok += ch;
      out += ch;
      i++;
      continue;
    }
    if (nonAsciiRe.test(ch)) nonAscii = true;
    curTok += ch;
    out += ch;
    i++;
  }
  return { command: out, cmdFlagFixed, sawCmd, nonAscii };
}

// 給只需要純字串結果的舊呼叫端相容用
export function rewriteNulRedirects(command: string): string {
  return rewriteBashCommand(command).command;
}

const notifyUI = (ctx: { hasUI: boolean; ui: { notify: (msg: string, level?: string) => void } }, msg: string, level: string) => {
  if (!ctx.hasUI) return;
  try {
    ctx.ui.notify(msg, level);
  } catch {
    try {
      ctx.ui.notify(msg, "info");
    } catch {
      /* 通知失敗不影響工具執行 */
    }
  }
};

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", (event, ctx) => {
    const name = event.toolName;

    // write / edit / read / grep / find / ls：改寫 path 參數
    //（grep/find/ls 同樣是 host 端解析（resolveToCwd），/tmp/$TEMP 也會出事，
    //  但它們是唯讀工具，失敗型態是「找不到目錄」大聲報錯——修掉是純獲益）
    if (name === "write" || name === "edit" || name === "read" || name === "grep" || name === "find" || name === "ls") {
      const input = event.input as { path?: string };
      if (typeof input?.path === "string") {
        const rewritten = rewritePath(input.path);
        if (rewritten !== input.path) {
          const from = input.path;
          input.path = rewritten;
          notifyUI(
            ctx,
            `env-guard: path rewritten ${from} -> ${rewritten}`,
            "info",
          );
        }
      }
      return;
    }

    // bash：cmd //c 旗標修正、cmd+非 ASCII 警告
    //（bash 內的 /tmp 經 MSYS 映射本來就正確，不需動）
    if (name === "bash") {
      const input = event.input as { command?: string };
      if (typeof input?.command === "string") {
        const r = rewriteBashCommand(input.command);
        if (r.command !== input.command) {
          input.command = r.command;
        }
        if (r.cmdFlagFixed) {
          notifyUI(
            ctx,
            "env-guard: cmd //c flag rewritten to /c (MSYS_NO_PATHCONV=1 detected; //c would start an interactive cmd)",
            "info",
          );
        }
        if (r.cmdNonAscii) {
          notifyUI(
            ctx,
            "env-guard: command mixes cmd with non-ASCII text - measured: cmd input is mangled by ANSI conversion and output is not UTF-8 (PowerShell wrapping cannot recover it); results unreliable, prefer bash-native tools or PowerShell-native commands",
            "warning",
          );
        }
      }
    }
  });
}
