# Bots Ready / 0.5.6 验收

用户确认菜单Bots Ready、页面/标签Bots 网络、欢迎语Your bots are ready.。英文locale页面/标签使用Bots Network，菜单及欢迎语保持品牌原文。

主Agent负责本次小范围UI回归，零额外worker：现有i18n边界与网络组件改动紧密，无额外协调收益。实际NetworkHeader/NetworkSelector和真实i18n/CSS在隔离Vite/Chromium渲染；外围侧栏按钮和设备目录是合成fixture，不是完整App、真实账号或原生客户端截图。侧栏真实GlobalSidebar的66 DOM回归和两profile品牌资源测试另行通过。

browser-acceptance.json包含4组实际浏览器用例：1280x900/900x700/640x800，中英文、浅深主题、选网络弹层与Escape、说明弹层与Escape、连接名保持、长名称无横向溢出、未知计数保持—。人工复看4图通过；有且仅有一个页面h1，计数在窄窗口自然换行。无pageerror或外部HTTP请求。欢迎语是普通品牌文字，不是健康状态，网络名称和未知计数保持真实含义。

初次fixture位于macOS临时路径的非canonical别名，Vite找不到entry；改用realpath。首次截图检查又发现Tailwind未扫描外部源码目录，自动DOM用例本身通过但样式未加载；补显式source扫描及computed-style断言后全量复验/复看通过。旧未完整样式截图已被本目录的最终回执替代，不作为验收证据。没有为通过测试修改产品语义或放宽状态门禁。

本任务不改变网络协议、账户/连接持久化或Host能力，不运行模型，不读凭据/Keychain，不启动或安装App。MyAgents profile、上游连接及版权/许可名称保留；MoXBots当前网络自定义名称保留。0.5.5冻结制品、stable和官网下载更新由原发布任务继续；本次只交付0.5.6源码，原生包/安装需统一负责人另行交付。

检查：applicationBrand2 unit、NetworkHeader3 DOM、NetworkSelector19 DOM、AgentNetwork29 DOM、GlobalSidebar66 DOM，总计119；tsc和changed-file ESLint通过。初次header品牌测试继承了setup默认profile缓存，增加每case独立module reset后通过。浏览器命令/日志和完整可复现私有runner位于WPS项目pointer output/bots-ready-056-20261015/browser-check.mjs及/tmp/moxbots-bots-ready-*.log。
