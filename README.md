# @nakie-zjm/dsh-session-delete

[中文](#中文) | [English](#english)

---

## 中文

给 DeepSeek Harness（桌面版 / Web 版）加一个**会话永久删除**动作。

DSH 只提供「归档」：会话日志是 append-only 的，`dsh-session-persistence`
没有任何删除方法，`dsh-workspace` 注册表也没有 `removeSession`。这个插件把
已有的公开服务组合成一个真正的删除操作，并把入口挂到侧栏会话行的 `…` 菜单里。

### 安装

包名：**`@nakie-zjm/dsh-session-delete`**

#### 方式一：DSH 插件页（推荐，桌面版和 Web 版都适用）

1. 打开 DSH 的 **插件** 页面；
2. 在「添加插件」里填入包名和版本：

```
@nakie-zjm/dsh-session-delete@0.1.0
```

3. 按页面结果操作。**桌面版需要完全退出并重启应用**——bundle 选择是启动时读取的，
   配置 HMR 不会重新读 profile 的 `package.json`。

安装器会自动把包加入 profile 依赖、把 bundle 选进 `dsh.profile.bundles`，包内的
`cordis.patch.yml` 随层生效，**不需要手改任何配置文件**。

#### 方式二：`dsh plugin` 命令行

```sh
dsh plugin --profile desktop add @nakie-zjm/dsh-session-delete@0.1.0
dsh plugin --profile web     add @nakie-zjm/dsh-session-delete@0.1.0
```

官方桌面版的 `dsh` 命令默认不在 `PATH` 里，需要先在应用里注册自带的命令
（应用菜单中的 **Manage dsh Command…**），并在完全退出应用后使用 `desktop` profile。
从 npm 安装时 `--profile` 换成你自己的 profile 名。

#### 方式三：不用 `dsh plugin` 的手动兜底

```sh
cd ~/.dsh/profiles/desktop          # 或你的 profile 目录
pnpm add @nakie-zjm/dsh-session-delete@0.1.0
```

然后在 `~/.dsh/profiles/desktop/package.json` 里确认两处（安装器正常情况下会自己写）：

```jsonc
{
  "dependencies": { "@nakie-zjm/dsh-session-delete": "0.1.0" },
  "dsh": { "profile": { "bundles": [ /* …, */ "@nakie-zjm/dsh-session-delete" ] } }
}
```

重启应用生效。

#### 卸载

```sh
dsh plugin --profile desktop remove @nakie-zjm/dsh-session-delete
```

或在插件页点卸载。卸载只移除插件本身，**不会**删除任何已有会话。

#### 兼容性

针对 DSH **`0.2.0-rc.2`** 开发与验证。插件依赖下面这些宿主接口，DSH 升级后可能需要跟着更新：

`Workspace.detachSession`、`workspaceRegistry.archiveSession / unarchiveSession / unpinSession`、
`sessionPersistence.list / resolveCurrentLog`、Connection 的 `/api` exact Fetch 路由注册、
`api-session/removed` 转发事件、以及客户端插件的 `dsh.client` 约定与平台种子模块表。

其中只有 `resolveCurrentLog` 缺失会自动退回布局复刻，其余缺失会降级成警告或明确拒绝，
不会静默删错东西。

### 行为

**只加一个入口**：会话行悬停出现的 `…` 菜单里多一项 **永久删除**（红色，order 500，
排在归档 400 之后）。不加行内悬停按钮。

1. **预检**：解析会话（先查活动会话，再查持久化列表），并从宿主拿到它真实的日志位置，
   同时把「能不能安全删」全部判完——这一段有任何拒绝都发生在改动任何状态之前；
2. **确认对话框**：显示会话标题和不可恢复的提示，取消不做任何写入；
3. **确认后**：
   - 会话若还在跑回合：先经注册表自己的归档准入接缝（`archiveSession({stopActivity:true})`）
     停掉这些工作并立刻收回归档标记，然后才继续；
   - 从工作区记账中摘除（`Workspace.detachSession`，会持久化并推送变更）；
   - 从归档集合、置顶集合中摘除；
   - 永久删除会话日志目录与投影缓存文档；
   - 发出 `api-session/removed`，浏览器会话列表立即去掉这一行。

**不可恢复。** 没有回收站、没有备份、没有撤销。

### 永久删除怎么做到失败也安全

直接 `rm -rf` 会在中途失败时留下半棵目录树，而 DSH 下一次启动仍会把它当成会话读。
所以删除走两步隔离：

```
rename(会话目录 → ~/.dsh/sessions/.dsh-session-delete-<随机>/<会话id>/)   ← 同卷，原子
  → 重新 lstat 校验身份（dev/ino/size/birthtimeNs 与改记账前一致）
  → rm(隔离目录, recursive, force:false)
  → 再 stat 一次确认真的没了
```

- 身份对不上（删除期间被换掉）：**放回原位**，什么都不删，报 `unsafe-location`；
- `rm` 中途失败：报错并告知隔离目录的完整路径，`~/.dsh/sessions/` 下不会留下会被误读的目录，只会留下一个 `.dsh-session-delete-*` 待你处理；
- 全部成功才清理隔离目录本身。测试断言：删除完成后 `.dsh-session-delete-*` 一个不剩。

### 位置与安全

- **位置来自宿主**：会话目录优先取 `sessionPersistence.resolveCurrentLog(id)` 的答案，
  只有后端答不出来时才退回本插件对布局的复刻（复刻有测试对着真实目录逐条核对）。
  后端答案必须满足 `<sessions根>/<项目目录>/<会话id>/transcript` 的形状，否则拒绝。
- **符号链接防护**：删除前用 `lstat` + `realpath` 证明目标是真目录、父目录就是
  `~/.dsh/sessions/` 下的项目目录、且解析后仍在 sessions 根内。指向别处就拒绝——
  测试会造一个 junction 指向根外目录，断言拒绝并且目标文件完好无损。
- **拒绝不留副作用**：身份检查、位置检查、运行中检查都排在第一次持久化写入之前。
  任何拒绝之后，会话仍然在工作区原位、仍然在原有归档/置顶状态，日志一个字节没动。
- **请求加固**：只接受 POST + `application/json`；浏览器请求必须同源且带
  `x-dsh-session-delete-confirmation: delete-session`（链接和 HTML 表单设不了自定义头，
  所以跨站导航打不到这个分支）；会话 id 必须匹配 `[A-Za-z0-9_-]{1,128}`；请求体
  先量后读，超过 8 KiB 直接 413。无 `Origin` 的原生调用方（CLI / Agent 直接 POST
  loopback）由宿主信任栅栏认证，不需要那个头。

### 已知边界

- **正在运行的会话**：插件会先停掉它的回合再删。停不下来（宿主没提供归档准入接缝，
  或者停完仍是 live）才拒绝，返回 `session-delete/running`（HTTP 409），并且此时
  一个文件都没动——但那个会话会处于「已归档」状态，需要去侧栏的「显示已归档」筛选里
  取消归档再重试。当前正在对话的这个会话通常属于这一类（它始终 live）。
- 会话的图片/文件附件是内容寻址的**全局**存储，其它会话可能共享，所以删除不动
  `~/.dsh/attachments`。这会留下孤儿字节，但不会误删别人的数据。
- `session_projcache` 的内存表保留该会话那一行直到重启；磁盘文档已删除，且没有
  日志的会话不会再被水合，所以不影响使用。
- **删掉就没了**。要保留内容，请先用官方的 `/export` 命令导出一份 ZIP。
- 与 [`dsh-session-delete`](https://www.npmjs.com/package/dsh-session-delete)（vtxf 的
  同名插件）**不能同时装**：两者都注册 `sidebar.workspaces.session.menu.item`，菜单里会
  出现两个删除项。它侧重目录级批量归档/删除，本插件侧重单会话删除的失败安全与
  运行中会话的处理。

### 开发

仓库根就是包根。产物只有 `lib/client.js` 一个文件：

```
dsh-session-delete/
  package.json        main → src/index.js、./client → lib/client.js、dsh.bundle.patch
  cordis.patch.yml    bundle 补丁层：插入一行 Loader entry
  src/index.js        宿主半（源码 = 产物：删除编排 + /api/session.delete 路由）
  src/client.js       浏览器半源码：工厂体，用 require/exports/module
  lib/client.js       浏览器半产物：build-client.mjs 套上 lazy-CJS 外壳
  scripts/build-client.mjs  唯一的构建步骤；--check 校验产物是否过期
  test/host-half.mjs        宿主半端到端（临时 DSH_HOME，真删文件）
  test/browser-half.mjs     浏览器半（在 Node 里物化 lib/client.js，桩掉 React 与 fetch）
  test/verify-endpoint.mjs  对运行中的实例核对路径推导与可达性
```

宿主半不需要构建：DSH 的 Loader 用 `import` 加载它，`main` 直接指向 `src/index.js`。

浏览器半需要构建：DSH 只服务一个文件（`exports["./client"]`），它必须自己调用
`window.__ModuleLoader__.load({ id, factory })`，而模块表**没有相对加载器**，所以外壳
不能写进源码再 import。外壳由 `scripts/build-client.mjs` 套上——源码保持可读，产物
可复现（`npm run build:check` 校验产物是否过期）。

```sh
npm run build     # 生成 lib/client.js
npm test          # 宿主半 43 项 + 浏览器半 35 项
npm run verify    # 对运行中的 DSH 实例核对（需应用在跑）
npm run check     # build:check + test，prepublishOnly 会自动跑
```

本包**没有任何运行时依赖**：客户端只用平台种子模块表里的
`react`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-store`、
`@deepseek-ai/dsh-client-ui-primitives`。

### 许可

[MIT](LICENSE)

---

## English

Adds one **permanent session delete** action to DeepSeek Harness (Desktop and Web).

DSH ships archive only: the session log is append-only, `dsh-session-persistence`
exposes no delete, and the Workspace registry has no `removeSession`. This plugin
composes the existing public services into a real delete and mounts the entry in
the sidebar session row's `…` menu.

### Install

Package name: **`@nakie-zjm/dsh-session-delete`**

**Plugins page (recommended):** open DSH → **Plugins**, then add
`@nakie-zjm/dsh-session-delete@0.1.0`. The installer adds the profile dependency,
selects the bundle in `dsh.profile.bundles`, and the package's own
`cordis.patch.yml` applies as a layer — no configuration file is edited by hand.
**Desktop requires a full app restart**, because bundle selection is read at startup.

**CLI:**

```sh
dsh plugin --profile desktop add @nakie-zjm/dsh-session-delete@0.1.0
dsh plugin --profile web     add @nakie-zjm/dsh-session-delete@0.1.0
```

The official Desktop build does not put `dsh` on `PATH`; register the bundled
command first (**Manage dsh Command…** in the app menu) and use the `desktop`
profile after fully quitting the app.

**Manual fallback:** in `~/.dsh/profiles/<profile>`, run
`pnpm add @nakie-zjm/dsh-session-delete@0.1.0`, then confirm the name appears in
both `dependencies` and `dsh.profile.bundles` of that profile's `package.json`.

**Uninstall:** `dsh plugin --profile desktop remove @nakie-zjm/dsh-session-delete`,
or use the Plugins page. Uninstalling never deletes existing sessions.

**Compatibility:** built and verified against DSH **`0.2.0-rc.2`**.

### Behaviour

One entry only: a red **Delete permanently** row (order 500, after archive at 400)
in the session row's `…` menu. No hover button.

Every check that can refuse — identity, location, and whether the session is
running — runs before the first durable write, so a refusal leaves the session
exactly as it was. Confirming then stops a running turn through the registry's own
archive admission seam, detaches the session from its Workspace, drops it from the
archive and pin sets, removes its log directory and projection cache, and emits
`api-session/removed` so the browser list drops the row.

**There is no undo.** No trash, no backup. Export with `/export` first if you want
to keep the transcript.

The recursive removal is staged: the session directory is `rename`d into a
quarantine directory beside its project directory, its identity (`dev`/`ino`/
`size`/`birthtimeNs`) is re-checked there, and only then removed — so a failed
removal can never leave a half-deleted tree where DSH would read it as a session.

### Safety

- The directory comes from `sessionPersistence.resolveCurrentLog(id)`; the plugin's
  own replica of the layout is only a fallback.
- `lstat` + `realpath` prove the target is a real directory inside the sessions
  root before anything is removed; a junction pointing outside is refused.
- The route accepts POST + `application/json` only, requires a same-origin browser
  request carrying `x-dsh-session-delete-confirmation`, pins the session id to
  `[A-Za-z0-9_-]{1,128}`, and measures the body before parsing it.
- Attachments under `~/.dsh/attachments` are content-addressed and shared, so they
  are never touched.

### Known limits

- A session whose turn will not stop is refused with `session-delete/running`
  (HTTP 409) and no file is touched; the session is left archived, so unarchive it
  from the sidebar filter and retry.
- Cannot be installed alongside
  [`dsh-session-delete`](https://www.npmjs.com/package/dsh-session-delete) (vtxf's
  plugin): both register the same menu slot, so the menu would show two delete rows.

### Development

```sh
npm run build     # regenerate lib/client.js
npm test          # host half (43 checks) + browser half (35 checks)
npm run check     # build:check + test — also runs on prepublishOnly
```

No runtime dependencies: the browser half uses only platform seed modules.

### License

[MIT](LICENSE)
