# Host onboarding 隔离页面验收

运行：在仓库根目录使用 Node 24，执行 `MYAGENTS_BUILD_PROFILE=moxbot npx vite --config dev-docs/host-onboarding-validation/vite.config.mjs`，打开 http://127.0.0.1:5197/ 。仅绑定本机回环。

页面直接渲染生产 AgentNetwork、HostOnboarding 和 Theme。mock.ts 仅为本夹具覆盖 Tauri core invoke；只允许 network/devices/agents/callable 元数据，不接受授权、模型或写入。不得将夹具配置用于生产。

模式：默认empty、`?mode=callable`、offline、callable-failure、failure。`?lang=en-US` 查看英文。partial模式故意返回重复cursor，用于确认异常分页不能假通过；有效预算截断partial由unit/DOM测试覆盖。

截图与记录由主Agent的Codex内置浏览器在真实渲染页面获得。文件中的设备、网络地址与目录均为合成数据。截图不能证明真实Host安装、登录、权限与模型执行。独立审查结论见 ../host-onboarding-review.md。
