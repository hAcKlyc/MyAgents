# MoXBots 管理控制台原型视觉约定

2026-10-13。资产来自本仓库的独立 MoXBots 品牌和既有客户端设计系统；第一版原型直接复用，不重绘 Logo。

- Logo：`assets/moxbots-icon.png`，来源 `src/renderer/assets/brand/moxbots-icon.png`，用于浅色产品导航与 Bot 标识，可嵌入 HTML。
- 产品基线：`specs/DESIGN.md` 与 `src/renderer/theme/themes/myagents-light.css`，阅读优先、状态可信、动作克制，保留浅色表面和清晰层级。
- 参考资料：已有内部桌面品牌验收截图仅可作为布局参考；含真实环境的截图不纳入此公开原型。
- 配色：正文 `#2d2d2b`，次级正文 `#46453f`，页面 `#f9f9f7`，侧栏 `#f5f4f1`；蓝色 accent 参考已有 Logo，作为本原型提案，不声称当前客户端 Theme 已采用。
- 字体：沿用产品 Theme 中的系统中文与西文 fallback；正文 16px、控件 14px、辅助 12px、标题 28px。
- 布局：桌面侧栏与内容区域；手机单列且导航可折叠。审批、邀请和授权范围构成核心信息层次，不加入虚构运营指标。
- 重点：平台管理员跨用户Bots目录与详情、邀请时即时更新共享范围摘要，使用者明确看见自己可以做什么、费用归属和有效期。
- 图像：不使用外部人物图片、stock photos 或生成式素材；合成人名以文字头像表示。
