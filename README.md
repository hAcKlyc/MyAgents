# MoXBots

连接 Bot 团队、桌面任务与云端协作的 AI 工作台。人设定目标，Bots 在项目、会话和可追踪的任务中推进工作。

[English](README.en.md) · [官网与下载](https://140.143.183.232/) · [源代码](https://github.com/heavenzhang/MoXBots)

## 桌面与云服务

- 在本地处理文件、配置模型供应商，并使用 Skills、工具及已支持的 Agent Runtime。
- 组织项目和任务，查看执行进度，通过 Bots Net 连接已授权的设备与 Host。
- 使用配置的 MoXBots 云账号进入协作社区及私有的帮助与反馈。管理员在同一后台管理社区、反馈、Bots、Hosts 和模型。

协作社区提供讨论、问答、实践分享、回复及管理员管理。云端请求使用配置的所属服务。上游 Space 及其账号属于另一套服务；本次不迁移上游内容，也不将其数据改称 MoXBots 数据。

源码、桌面安装包和云服务分别发布；实际交付状态以任务记录及验收报告为准。模型/API 服务按各自规则计费。执行能力取决于工具、设备和权限；后台任务要求其执行设备保持可用。

## 开发与运维

参阅[项目地图](.agent-sync/project-map.md)、[架构](specs/ARCHITECTURE.md)、[云管理后台](services/agentnet/ADMINISTRATION.md)、[协作社区](services/agentnet/COMMUNITY.md)和[帮助与反馈](services/agentnet/FEEDBACK.md)。独立桌面版本使用 `npm run tauri:build:moxbot` 构建，并保持应用身份和数据目录隔离。

## 许可证

MyAgents 采用 [GNU Affero General Public License v3.0](LICENSE)
（`AGPL-3.0-only`）。个人和企业都可以免费使用，也可以商业使用；分发修改版、通过网络向
用户提供修改版等场景需要完整履行 AGPL，包括在适用时提供对应源码。

如果你希望在不履行 AGPL 开源义务的情况下闭源修改、嵌入、OEM、分发或托管 MyAgents，
需要取得单独的商业许可证。请联系
[myagents.io@gmail.com](mailto:myagents.io@gmail.com)。

完整说明见 [LICENSING.md](LICENSING.md)，商业许可概要见
[COMMERCIAL-LICENSING.md](COMMERCIAL-LICENSING.md)。第三方组件继续适用各自许可证，详见
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

<a id="english"></a>

[Read this document in English →](README.en.md)
