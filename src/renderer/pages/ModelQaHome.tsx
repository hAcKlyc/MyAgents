export default function ModelQaHome() {
  return <main className="mx-auto max-w-3xl p-8 space-y-6">
    <h1 className="text-xl font-semibold">MoXBots · 独立验收环境</h1>
    <p>使用独立数据与凭据空间。本地模型仅允许无工具的文本生成，不执行普通任务；合成前序对话与真实生成结果分别记录。</p>
    <nav aria-label="验收入口" className="flex flex-col gap-4">
      <a href="?surface=next-prompt">下一步建议：真实模型与可编辑草稿</a>
      <a href="?surface=title-utility">任务标题：真实模型与隔离记录</a>
      <a href="?surface=app">打开隔离客户端：账号与 Host 联调</a>
    </nav>
  </main>;
}
