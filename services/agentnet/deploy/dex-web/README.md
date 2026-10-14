# MoXBots 身份登录页

基于 Dex v2.46.0 官方 web/templates、static 及 robots.txt（Apache-2.0，见 LICENSE.dex）；保留 Go 模板变量、原 POST 路径、账号字段及授权提交语义，仅定制中文页面和品牌。来源 https://github.com/dexidp/dex/tree/v2.46.0/web/templates ，配置方法 https://dexidp.io/docs/guides/templates/ 。

部署时将本目录作为 `frontend.dir`，`frontend.theme: moxbots`、`frontend.issuer: MoXBots`。此处不承接凭据、不新增认证接口、不改变 client id、secret、redirectURIs 或 approval 策略。未启用的设备/MFA模板保留上游内容；当前邮箱/密码、授权、错误路径中文化。
