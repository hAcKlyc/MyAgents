# MOXBOTS-UI-ZOOM-002

2026-10-16 用户报告Ctrl+放大后文本输入区出现水平滚动条。修复将文本域和下一步建议限定为自动换行、仅纵向滚动，补齐grid的minmax(0,1fr)轨道和min-w-0，避免长文本的固有宽度撑开输入区。字号策略、发送、IME与草稿状态不变。

## 可复验检查

- `node scripts/verify-chat-input-zoom.mjs chromium`或`webkit`：真实SimpleChatInput与appShortcuts，无模型/真实账号/业务写入。844/520宽，75/100/110/125/150/200%，空文本、loading、长URL、多行、建议五种场景，每引擎60组。检查值保留、宽度约束、横轴hidden、纵轴auto与长文可上下滚动，并保存125%截图和metrics。
- 可选`MOXBOTS_ZOOM_TEST_BROWSER`指定已有官方测试浏览器可执行文件；不使用个人Chrome/profile。Chromium153.0.8010.12和官方WebKit26.0各60/60通过，总120组。
- 修改前的真实组件计算overflowX为auto，回归检查失败；这是策略缺口的证据，不等同于已复现用户安装版的WebView渲染。修复后Chromium的内容宽度、值与纵向滚动通过，125%截图已由主Agent查看，无横条。
- WebKit在110%空输入下观察到clientWidth702/scrollWidth772；CSS zoom混合坐标不能直接作为横向溢出的度量。回归检查实际绘制边界、横向wheel后scrollLeft=0（建议层也必须为0），并验证长URL产生多行、值未改、长文可纵向滚动。两引擎125%截图主Agent已实看，输入区无横条。
- WebKit第一次启动的dev页面在请求拦截/等待load时超时；改为普通loopback加载并等待实际文本域，不放宽布局/交互标准。正式脚本两引擎均可完成。
- 相关DOM/unit六文件107项、完整typecheck/lint、MoXBots生产web构建及8项主题测试通过。最终CI/main以[PR76](https://github.com/heavenzhang/MoXBots/pull/76)状态和远端包含核验为准；不会仅凭样式断言宣布原生问题已验收。
- 本机合成证据：`/Users/zhangshaohua/Documents/Codex/2026-10-16/ui-zoom002-evidence/`，包含两引擎metrics与125%截图。原用户截图未写入Git。

## 发布边界与执行记录

主Agent直接实现和自验，零子Agent；改动集中于一个组件，保持单Agent。未升级或外调模型，具体型号/推理档位、用量和费用无运行时实测。沿用ai-yaoren-local纯内置模式；将真实布局回归保留为后续缩放检查入口。

055/056已经冻结，补丁只进入下一未冻结批次。统一部署owner由main计划指定，本任务只交付代码和queued请求，不操作客户端、签名、版本或服务器。原生WKWebView/Windows page zoom、安装版与用户实际场景仍由发布窗口另验；headless浏览器的CSS zoom不是这些门禁的替代品。
