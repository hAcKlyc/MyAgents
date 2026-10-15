<!-- git-project-sync-task:version=1 -->
<!-- git-project-sync-task:branch=codex/release-056-final-20261016 -->
<!-- git-project-sync-task:base=178b8047f78e51f843e5c0636d2e0182f192c8b1 -->
<!-- git-project-sync-task:status=complete -->

# MOXBOTS-056-REMOTE-RELEASE-20261016

## Objective

按用户当前直接要求，将固定main源码a81d2509的0.5.6正式签名、公证并发布既有macOS arm64更新服务器。Root为唯一发布聊天；不退出、不停止、不安装或重启日常客户端。Project Context等后续改动单独排队。

## Acceptance criteria

- [x] 负责人PR67/main178b8047及精确候选六CI、生产profile/Reader/own key连续性。
- [x] 固定4282输入正式构建；Developer ID、Apple Accepted+staple/Gatekeeper、最终TAR/ZIP内容与own signature、独立验包。
- [x] 既有服务器同任务锁、不可变056完整上传及全hash/size，055原清单与可验签回滚包保留。
- [x] 独立Linux正常TLS完整GET、实际文件stat/hash来源与签名身份独立审阅。
- [x] 同锁055回滚前置核验、旧stable CAS/备份/fsync/原子切换及公开接口复验，释放自有锁。
- [x] 最终记录与制品/服务器证据对应；本记录通过正常PR/CI交main，最终远端包含核验由外部DELIVERY回执和Git历史记录。安装及原生业务验收不在本次范围。

## Completed

正式源码a81d2509fa92968ddaaed63416a2478d21b8a373；App binary98cddba4fbfe55d7089fac9b765869a662395884c16a83ae47af12c8f4625e75。Apple Accepted24390592-089c-4557-a0d8-7e7b46ba5204。TAR685134d0a5129cf7d150b20c86e73736db4142ae150376eb8edeea077a6c8549/336158365B；ZIPf9b31491e5bf15b3073c41cd483833ae9c58b99c246b099e3c8f1256d493bdb4/344739590B。服务器stable已原子切056并复验，055回滚完整，自有锁已释放。

## Verification

独立源码审阅、合成React六旅程、正式构建、22嵌套/outer严格签名、生产Reader字节固定、精确Apple归档关联、独立TAR/ZIP解包12493文件/link/execbit及真实minisign0.2.5通过。独立实际发布脚本审阅四文件SHA已固定；Root唯一Linux GET完整收齐336158365字节，实际原始stat/hash及签名身份独审通过。私有原始证据见项目指针work/release-056-20261016/owner/，发行权威记录dev-docs/releases/moxbots-0.5.6.md。

## Blockers and unknowns

本次服务器发行门禁已通过；后续真实客户端安装与业务路径不在本次范围。只读发现日常实际已055/正式binary一致，安装发生方式及安全事务未由本任务验证，不倒推通过；旧054/PID记录均是历史。真实Host、薪资/有数据原生看板、精确IME以及有任务/录音/草稿的更新恢复仍未验。本次不调用安装、不绕锁屏。

## Next step

客户端安装须由用户确认；不得自动停止任务。真实Host/薪资/有数据原生与有任务保存恢复另验，读取dev-docs/releases/moxbots-0.5.6.md的边界后接续。正式056与055不可变，后续源码改动使用新补丁版本；Project Context另批，不回写056。
