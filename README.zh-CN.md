# MCP Tools Controller(MCP 插件管理与聚合网关)

把每个 MCP server 当作**插件**管理,并通过**一个支持热更新的 MCP 网关**统一对外聚合。

每个下游 MCP server 作为插件接入时都会被**校验合法性**(完整 MCP 握手 + 工具发现)、**记录在案**(注册表 + 审计日志),其工具以 `<插件名>__<工具名>` 的形式通过单一 MCP 端点统一暴露。插件可以在网关**运行中增删**——既可以通过 shell(`mcpctl`),也可以由连接中的模型自己操作(内置 `plugin_*` 管理工具)——所有已连接客户端都会通过 `notifications/tools/list_changed` 实时感知变化。

[English README](./README.md) · [模型接入指南(写给 AI)](./docs/AGENT_GUIDE.md)

## 一键导入 Claude Code

```sh
claude mcp add mcp-controller -- npx -y mcp-tools-controller serve
```

或者让 CLI 为你生成精确命令:

```sh
npx -y mcp-tools-controller install claude --print
```

## 一键导入 Claude Desktop

Claude Desktop 没有注册 MCP server 的命令行,所以由本工具直接代写它的 `claude_desktop_config.json`(与已有条目合并,不会覆盖其它配置):

```sh
npx -y mcp-tools-controller install claude-desktop          # 直接写入配置
npx -y mcp-tools-controller install claude-desktop --print  # 只打印 JSON 片段和路径
```

写入后**彻底重启 Claude Desktop**(从托盘/菜单栏退出,只关窗口不生效)。配置文件位置:

| 系统 | 路径 |
| --- | --- |
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |
| Linux | `$XDG_CONFIG_HOME/Claude/claude_desktop_config.json`(默认 `~/.config/Claude/...`) |

> Claude Desktop 以极简 `PATH` 启动 MCP server,若它找不到 `npx`,把条目里的 `"command": "npx"` 换成 `which npx`(或 `which node`)输出的绝对路径。

## 架构

```
            (管理)                          (聚合)
 ┌─────────┐  mcpctl   ┌─────────────────┐   MCP    ┌──────────────────┐
 │  shell  ├──────────►│  plugins.json   │◄────────►│      网关        │
 └─────────┘           │  (注册表,       │  监听 /  │  stdio 和/或     │
 ┌─────────┐ plugin_*  │   唯一事实源)   │  写入    │  Streamable HTTP │
 │  模型   ├──────────►│                 │          └───────┬──────────┘
 └─────────┘  工具     └─────────────────┘                  │ 代理转发
                              audit.log            ┌────────┼────────┐
                              (JSONL 审计)         ▼        ▼        ▼
                                                插件 A    插件 B    插件 C
```

- **注册表文件**(默认 `~/.mcp-controller/plugins.json`)是唯一事实源:CLI 写入,网关监听(防抖、兼容原子重命名)并据此调和实际连接。
- shell 与模型两个控制面汇聚到同一个文件,任何一方的修改对另一方实时可见。
- **审计日志**(注册表旁的 `audit.log`,JSONL)记录全部插件生命周期事件和每次代理调用,`actor` 字段(`cli` / `gateway` / `mcp-tool`)区分操作来源。

## 快速开始

```sh
# 需要 Node.js >= 18。Task(taskfile.dev)是标准入口;
# 每个 task 包装一个 npm script,没装 Task 用 npm run 即可。
task install   # 或 npm install
task build     # 或 npm run build

# 1. 接入第一个插件——对方提供启动命令,写在 '--' 之后
node dist/cli.js add demo -- node dist/examples/demo-server.js

# 2. 查看
node dist/cli.js list
node dist/cli.js logs

# 3. 启动聚合网关
node dist/cli.js serve                       # stdio 模式
node dist/cli.js serve --http --port 3000    # Streamable HTTP,多客户端共享

# 4. 热更新:网关运行中,另开终端:
node dist/cli.js add other -- npx -y some-mcp-server
# 已连接客户端约 300ms 内收到 tools/list_changed——无需重启
```

从 npm 安装后,`node dist/cli.js` 换成 `mcpctl`(全局安装)或 `npx -y mcp-tools-controller`。

## CLI 命令一览

| 命令 | 说明 |
| --- | --- |
| `mcpctl add <name> [选项] -- <command> [args...]` | 接入 stdio 插件,保存前先校验(`--skip-validate` 跳过)。选项:`--env K=V`(可重复)、`--cwd <dir>`、`--force` |
| `mcpctl add <name> --url <endpoint> [--header K=V]` | 接入远程 Streamable HTTP 插件 |
| `mcpctl remove <name>` | 删除插件,运行中的网关立即断开它 |
| `mcpctl list [--json]` | 列出插件:传输方式、启用状态、校验结果、工具数、目标 |
| `mcpctl validate <name> \| --all` | 重新校验合法性并持久化结果 |
| `mcpctl enable <name>` / `disable <name>` | 启用/停用插件(配置保留) |
| `mcpctl call <plugin> <tool> [--args '{...}']` | 直连插件做一次性调试调用 |
| `mcpctl serve [--http] [--port N] [--no-management]` | 启动聚合网关 |
| `mcpctl import <.mcp.json>` | 从 Claude Code 配置批量导入(同款 `{command, args, env}` 结构) |
| `mcpctl install claude [--http] [--print]` | 打印/执行 Claude Code 一键导入命令 |
| `mcpctl install claude-desktop [--print]` | 写入(或打印)Claude Desktop 的 `claude_desktop_config.json` 条目 |
| `mcpctl logs [-n 50]` | 查看最近的审计日志 |

所有命令支持全局 `--registry <path>`;否则按 `$MCP_CONTROLLER_HOME` → 项目本地 `./.mcp-controller/plugins.json`(存在时)→ `~/.mcp-controller/plugins.json` 解析。

## 合法性校验

`add` 和 `validate` 在注册前会做真实连接检查:

1. 静态检查——插件名须匹配 `^[a-z][a-z0-9-]{0,31}$`(禁止下划线:它是 `plugin__tool` 命名空间分隔符),传输配置须完整;
2. 完整 MCP `initialize` 握手(15 秒超时,挂死的子进程会被强制回收);
3. 服务端必须声明 `tools` 能力;
4. 拉取全部 `tools/list`(跟随分页),逐个检查工具名字符集与 128 字符命名空间预算。

校验记录(服务端名称/版本、协商的协议版本、工具清单、时间戳)写入插件条目并追加到审计日志。

## 热更新

两条路径,同一机制:

- **shell**:任何 `mcpctl add/remove/enable/disable` 原子写入注册表;运行中的网关监听注册表目录,将期望状态与实际连接做 diff,只连/断发生变化的插件。
- **模型**:网关内置 `plugin_add`、`plugin_remove`、`plugin_enable`、`plugin_disable`、`plugin_reload`、`plugin_validate`、`plugin_list` 管理工具,全部写穿到同一个注册表文件。

无论哪条路径,网关都会向**所有**已连接客户端广播 `notifications/tools/list_changed`,客户端随即重新拉取 `tools/list`。下游热更新同样向上传播:插件自己在运行时变更工具列表,网关会重新拉取并继续向上通知。

插件崩溃绝不拖垮网关:它会被标记为不健康、其工具从聚合列表中撤下,并按 1s → 2s → 5s → 15s → 30s 退避重连。调用不健康插件的工具会返回带恢复提示的 `isError` 结果,而非协议错误。

## 在 Claude Code 中使用

stdio(最简单,Claude Code 自己拉起网关):

```sh
claude mcp add mcp-controller -- npx -y mcp-tools-controller serve
```

Streamable HTTP(一个常驻网关服务多个客户端,热更新即时广播):

```sh
npx -y mcp-tools-controller serve --http --port 3000   # 保持运行
claude mcp add --transport http mcp-controller http://127.0.0.1:3000/mcp
```

之后在 Claude Code 里 `/mcp` 即可看到聚合的全部工具。让模型调用 `plugin_list` 查看插件健康状况,或在对话中用 `plugin_add` 现场接入新的 MCP server——详见[模型接入指南](./docs/AGENT_GUIDE.md)。

## 开发

```sh
task build      # 编译
task dev        # 监听编译
task e2e        # 构建 + 端到端测试(聚合、两条热更新路径、故障处理、审计)
task demo       # 单独运行内置演示 MCP server
task start      # stdio 网关
task serve:http # HTTP 网关
```

## 许可证

MIT
