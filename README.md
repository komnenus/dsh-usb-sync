# dsh-usb-sync

DSH 的 U 盘自动同步插件：启动时拉取、退出时推送，插着 U 盘就工作。
逻辑与手动脚本一致：工作区登记表只留本机，会话与项目文件走同一个 U 盘仓库，
冲突两边都保留。

## 它做什么

- **自动找 U 盘**：按盘符 C–Z 寻找 `dsh-usb-sync\repo.git`，盘符变了也不用改配置；
  也可以用 `stickPath` 固定。
- **开机拉取**：DSH 启动后约 2.5 秒，拉取 U 盘上的新会话和项目文件，并把下载的会话
  挂回本机已有工作区。
- **退出推送**：DSH 退出（或进程结束）时提交并推送本机的新内容。
- **定时兜底**：默认每 10 分钟再推一次，防止异常退出丢内容。
- **工作区登记表不出本机**：`workspace.json` 只在本机，拉取前后自动备份还原。
- **冲突不丢版本**：同一文件两边都改过时，本机版本留在文件夹里，另一台的版本存进
  `~/.dsh/.chatsync-local/usb-sync/conflicts/<时间>/`，附清单，随时可换回。

## 安装

1. 完全退出 DSH。
2. 把整个插件文件夹放到任意固定位置（例如 `D:\desktop\codex work\` 下面）。
3. 用 PowerShell 运行文件夹里的安装脚本：

   ```
   powershell -NoProfile -ExecutionPolicy Bypass -File "<插件目录>\install.ps1"
   ```

   它会：把插件复制进 `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-usb-sync`；
   备份并在 `cordis.patch.yml` 末尾追加一段配置。不会改动现有条目。
4. 重新打开 DSH。菜单里输入 `/usbsync` 能看到状态就说明装好了。

卸载：`install.ps1 -Uninstall`（只删它自己加的那段配置和插件目录）。

## 配置

配置写在 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 的 `usb-sync` 条目里，
改完重启 DSH 生效。

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉就完全不动作 |
| `stickPath` | `''` | 固定 U 盘目录；留空自动按盘符找 |
| `stickFolder` | `dsh-usb-sync` | U 盘上的文件夹名 |
| `dshHome` | `''` | 留空 = `%USERPROFILE%\.dsh` |
| `branch` | `main` | 同步仓库分支 |
| `gitBin` | `git` | git 可执行文件 |
| `autoPullOnStart` | `true` | 启动时拉取 + 挂回 |
| `autoPushOnExit` | `true` | 退出时推送 |
| `autoPushIntervalMinutes` | `10` | 定时兜底推送，0 关闭 |
| `regroupOnPull` | `true` | 拉取后把会话挂回工作区 |
| `conflictPolicy` | `keep-local` | 冲突时保留本机版本 |
| `registerCommand` | `true` | 注册 `/usbsync` |
| `commandName` | `usbsync` | 命令名（界面上显示为 /usbsync） |
| `timeoutMs` | `120000` | 单条 git 命令超时 |
| `maxConflictFiles` | `200` | 单次冲突最多归档多少个文件 |

## 命令

```
/usbsync            状态：U 盘、领先/落后、未提交改动、冲突组数
/usbsync sync       立即拉取 + 推送
/usbsync conflicts  列出最近一组冲突
/usbsync resolve 2 local    第 2 个文件换回本机版本
/usbsync resolve 2 remote   第 2 个文件改用另一台的版本
/usbsync help
```

## 冲突怎么处理

两边改到同一个文件时，插件不会停下来问你：

1. 本机版本留在工作目录里，照常提交；
2. 另一台的版本存到 `.chatsync-local/usb-sync/conflicts/<时间>/theirs/`；
3. 本机版本同时存一份到同目录的 `ours/`；
4. 生成 `manifest.json` 和 `summary.txt`，写明每个文件保留的是哪一边。

之后用 `/usbsync conflicts` 看清单，想换哪一边就用 `resolve`。换回后会生成一个提交，
下次同步带过去。

## 和手动脚本的关系

插件与 `dsh-usb-sync` 里的手动脚本使用同一套约定（同一个 U 盘仓库、同一批项目映射），
但两者不要同时运行：手动跑同步前关掉 DSH，插件就不会动。
插件不修改 U 盘上的任何脚本，也不碰 DSH 工作文件夹里已有的文件，只读写它自己需要的数据。

## 自测

```
cd <插件目录>
node --test test/engine.test.mjs
```

四个用例覆盖：推送新会话、冲突保留双边并归档、登记表不上 U 盘、会话挂回工作区。

## 依赖

- Node.js（DSH 自带，22.19+ 或 24+）
- `git` 在 PATH 里
- U 盘根目录下有 `dsh-usb-sync\repo.git`

