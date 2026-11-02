/**
 * Message texts for synthetic scenarios: a Chinese-speaking product team's group chat. A model Router judges these texts, so
 * each kind reads like the real thing: a work request, more input on the same thread, a follow-up written elsewhere that
 * names the task only by what it is about, ordinary chatter (some of it technical), and messages that address the agent
 * without asking for work. The oracle Router ignores the text.
 */

export interface TaskText {
  /** Addressed request that starts the task. */
  request: string
  /** More input on the task's own thread (replies to the request). */
  followups: string[]
  /** Input written as a new message in the group, naming the task only by its subject; the generator adds `@agent ` when addressed. */
  cross: string[]
  /** Hard cases about this task, each a new addressed message in the group (see `TaskProbe`). */
  probes: Record<TaskProbe, string>
}
/**
 * Hard cases tied to an open task: a person asks to stop it, asks how it is going, asks for the same thing again in other
 * words (often another person), or asks for something new on a similar subject.
 */
export type TaskProbe = 'stop' | 'status' | 'duplicate' | 'similarNew'
/** Hard cases tied to no task: a reference with no referent, a question, a request on hold, a refusal, an indirect request. */
export type GlobalProbe = 'vague' | 'question' | 'hold' | 'decline' | 'polite'

export const TASKS: TaskText[] = [
  { request: '@agent 登录页在 Safari 上“登录”按钮和输入框错位了，帮忙修一下，截图在上面。',
    followups: ['顺便把移动端也看一下，iPhone 上好像也有类似问题', '按钮间距按设计稿 16px 来'],
    cross: ['刚才说的 Safari 登录页错位那个，设计那边说按钮改成主题蓝', '登录页按钮那个问题，产品说这周五前要上线'],
    probes: { stop: '@agent Safari 登录页错位那个先别改了，前端组说下个版本整体重构登录页', status: '@agent Safari 登录按钮那个现在什么进度了？', duplicate: '@agent 用 Safari 打开登录页，按钮和输入框对不齐，能处理下吗', similarNew: '@agent 注册页在 Safari 上也有错位，“下一步”按钮跑到输入框下面了，帮忙修一下' } },
  { request: '@agent 订单导出 CSV 的时候中文乱码，用 Excel 打开全是问号，能修一下吗',
    followups: ['应该是没加 BOM，加上 UTF-8 BOM 试试', '导出的金额列也请保留两位小数'] ,
    cross: ['订单导出乱码那个，财务说还需要加一列“下单渠道”', '导出 CSV 那个事，记得兼容 WPS'],
    probes: { stop: '@agent 订单导出乱码那个不用修了，财务改用 BI 系统直接看了', status: '@agent 导出乱码那个修好了吗？财务在催', duplicate: '@agent 订单 CSV 用 Excel 打开中文全是问号，帮忙看看', similarNew: '@agent 用户导出的 CSV 也要做手机号脱敏，中间四位打星号' } },
  { request: '@agent 用户列表接口 /api/users 分页参数 page_size 传 0 会直接 500，加个校验',
    followups: ['上限也限制一下，最大 100', '错误信息用统一的 ErrorCode 格式'],
    cross: ['关于 /api/users 分页那个修复，后端规范要求返回 400 不是 422', '用户列表分页那个，顺便把 page 小于 1 也拦掉'],
    probes: { stop: '@agent /api/users 分页校验那个先停一下，后端同学自己改了', status: '@agent 用户列表分页那个 PR 提了吗？', duplicate: '@agent /api/users?page_size=0 会 500，加个参数校验吧', similarNew: '@agent /api/orders 的分页也加一下同样的参数校验' } },
  { request: '@agent 把 README 里的本地启动步骤更新一下，现在 node 版本要求已经是 22 了',
    followups: ['pnpm 版本也写上，11.x', '再加一节常见问题：端口被占用怎么办'],
    cross: ['更新 README 那个，记得把 docker 启动方式也写进去', 'README 启动文档那个，Windows 用户需要单独说明'],
    probes: { stop: '@agent README 那个先不用更新了，文档要迁移到 Wiki', status: '@agent README 更新那个弄完了吗？', duplicate: '@agent README 里写的还是 node 18，更新成 22 吧', similarNew: '@agent CONTRIBUTING.md 也补一下提交信息规范' } },
  { request: '@agent 首页加载太慢了，Lighthouse 性能分只有 40，看看能不能把首屏的大图懒加载',
    followups: ['图片也可以转成 webp', '优先处理 banner 区域'],
    cross: ['首页性能那个优化，监控显示主要是那个 2MB 的 vendor 包，也看一下拆包', '首页懒加载那个事，SEO 同学说首屏图片不能懒加载'],
    probes: { stop: '@agent 首页懒加载那个暂停吧，下周统一做性能专项', status: '@agent 首页性能那个优化后 Lighthouse 多少分了？', duplicate: '@agent 首页首屏图片太大加载很慢，做下懒加载', similarNew: '@agent 商品详情页加载也很慢，帮忙看看能不能优化' } },
  { request: '@agent 消息通知的邮件模板里公司名还是旧的，全部替换成新名字“星河科技”',
    followups: ['页脚的版权年份也更新到 2026', '退订链接也检查一下是否可用'],
    cross: ['邮件模板换公司名那个，法务说页脚还要加上备案号', '改邮件模板那个任务，logo 也要换成新的'],
    probes: { stop: '@agent 邮件模板换名字那个先停，品牌名还没最终定', status: '@agent 邮件模板那个改完了吗？', duplicate: '@agent 通知邮件里还是旧公司名，换成“星河科技”', similarNew: '@agent 短信模板里的签名也换成“星河科技”' } },
  { request: '@agent 搜索框输入特殊字符比如 % 会报错，帮忙转义一下',
    followups: ['下划线 _ 也有同样问题', '加个单测覆盖这些字符'],
    cross: ['搜索框特殊字符那个 bug，客服又反馈了反斜杠也会出错', '搜索转义那个修复，记得前后端都要处理'],
    probes: { stop: '@agent 搜索框特殊字符那个不用改了，搜索要换成 ES 了', status: '@agent 搜索转义那个修复上线了吗？', duplicate: '@agent 搜索框里输入 % 直接报错了，修一下', similarNew: '@agent 搜索结果的高亮也有问题，关键词没有标红' } },
  { request: '@agent 给定时任务 cleanup-sessions 加一个告警，失败的时候发到运维群',
    followups: ['连续失败 3 次再告警，不要每次都发', '告警里带上失败原因'],
    cross: ['cleanup-sessions 告警那个，运维说告警发到 oncall 机器人就行，不用发群', '定时任务告警那个事，周末也要发'],
    probes: { stop: '@agent cleanup-sessions 告警那个取消吧，这个任务下个月下线', status: '@agent 定时任务告警那个配好了吗？', duplicate: '@agent cleanup-sessions 失败了没人知道，加个失败告警', similarNew: '@agent sync-orders 这个定时任务也加一下失败告警' } },
  { request: '@agent 设置页的“深色模式”开关刷新后会丢失，状态没持久化，修一下',
    followups: ['存 localStorage 就行', '跟随系统也作为一个选项'],
    cross: ['深色模式开关那个，设计说默认跟随系统', '深色模式持久化那个问题，登录后要同步到账号设置'],
    probes: { stop: '@agent 深色模式开关那个先别弄了，设计还在改方案', status: '@agent 深色模式那个 bug 修到哪了？', duplicate: '@agent 设置里开了深色模式，一刷新又变回浅色了', similarNew: '@agent 设置页的语言切换刷新后也会丢，一样存一下' } },
  { request: '@agent 依赖里 lodash 版本有安全漏洞告警，升级到最新的 4.x',
    followups: ['升级完跑一遍全量测试', 'lockfile 一起提交'],
    cross: ['lodash 升级那个，安全组说 axios 也有个高危，一起升了吧', '升级 lodash 那个，注意别动 major 版本'],
    probes: { stop: '@agent lodash 升级那个先停，等发版后再升', status: '@agent lodash 升级完了吗？安全组在问', duplicate: '@agent 安全扫描报 lodash 有漏洞，升一下版本', similarNew: '@agent moment 也有安全告警，升级一下' } },
  { request: '@agent 报表页日期选择器默认是美国格式，改成 YYYY-MM-DD',
    followups: ['周一作为每周第一天', '快捷选项加上“本季度”'],
    cross: ['报表日期格式那个，海外版还是要保留原格式，按语言区分', '日期选择器那个改动，导出的文件名日期也统一一下'],
    probes: { stop: '@agent 报表日期格式那个不用改了，产品决定保持原样', status: '@agent 日期选择器那个改好了吗？', duplicate: '@agent 报表页日期显示成 MM/DD/YYYY 了，改成 YYYY-MM-DD', similarNew: '@agent 报表页的金额也加上千分位分隔符' } },
  { request: '@agent CI 里 e2e 测试经常超时，看看能不能把超时调大并加重试',
    followups: ['重试最多 2 次', '超时先调到 60 秒'],
    cross: ['e2e 超时那个，我发现是测试库没清理导致的，可以顺便加个清理步骤', 'CI e2e 那个事，别影响主干的合并速度'],
    probes: { stop: '@agent e2e 超时那个先不用了，测试同学在重写这批用例', status: '@agent e2e 超时那个调了吗？', duplicate: '@agent CI 的 e2e 总是超时挂掉，调大超时加个重试吧', similarNew: '@agent CI 里单元测试也很慢，看看能不能并行跑' } },
  // Siblings of tasks 0 and 1: the same page or feature, another problem, so a follow-up must be read for which one it means.
  { request: '@agent 登录页的图形验证码在深色模式下几乎看不清，调一下对比度',
    followups: ['验证码的刷新按钮也太小了', '对比度按 WCAG AA 来'],
    cross: ['登录页验证码那个，产品说干脆换成滑块验证', '验证码看不清那个问题，浅色模式下也检查一下'],
    probes: { stop: '@agent 验证码对比度那个不用做了，要换第三方验证码', status: '@agent 验证码看不清那个处理了吗？',
      duplicate: '@agent 深色模式下登录验证码看不清', similarNew: '@agent 找回密码页也加上图形验证码' } },
  { request: '@agent 订单导出成 Excel 的时候“下单时间”列变成了一串数字，修一下',
    followups: ['时区用北京时间', '空值显示为空白，不要显示 0'],
    cross: ['订单导出时间列那个，格式用 YYYY-MM-DD HH:mm', '导出时间变数字那个，秒也要保留'],
    probes: { stop: '@agent Excel 导出时间列那个先别改了，财务说他们自己用公式转', status: '@agent 导出时间列那个修好了吗？',
      duplicate: '@agent 导出的 Excel 里下单时间是一串数字，修一下', similarNew: '@agent 订单导出也支持一下按时间范围筛选' } },
]

/** Unaddressed group chatter; several lines sound like work but ask no one in particular, or ask a person. */
export const NOISE: string[] = [
  '中午吃什么？楼下新开了家面馆', '周五团建去爬山还是去密室？', '今天的站会改到 10:30', '有人看到我的充电器了吗',
  '刚发版了，大家留意一下监控', '这周的周报记得周五前交', '新来的同学欢迎一下 🎉', '会议室 3 被占了，我们去 5 吧',
  '昨天那个线上问题的复盘文档我写好了，大家有空看看', '@bob 你的 PR 我看完了，有两个小问题', '谁有 staging 环境的账号？',
  '下午三点和设计评审新版首页', '这个需求优先级是不是要和产品再确认一下', '今天咖啡机又坏了', '我觉得我们应该把日志级别统一一下',
  '有没有人熟悉 k8s 的 HPA 配置', '@carol 那个接口文档能发我一份吗', '明天我请假一天，有事微信', '新版本的 changelog 谁来写？',
  '测试环境数据库好像有点慢', '我们是不是该升级 TypeScript 了', '下周一有个安全培训，必须参加', '这个 bug 是我写的，我来修',
  '大家觉得 monorepo 拆不拆？', '提醒：今晚 8 点数据库维护', 'Q3 OKR 草稿发群文件了', '有人用过 Bun 吗，体验怎么样',
  '刚才那个报警是误报，已经处理了', '记得给新同学开 GitHub 权限', '周会纪要：下周重点是支付模块', '谁订一下下周的会议室',
  '这个页面的文案我改了一下', '前端构建又变慢了，有空再看', '我在写迁移脚本，晚点提 PR', '客户反馈的那个问题我先跟进一下',
  '代码规范文档更新了', '下班前把分支合一下', '这个方案我不太同意，会上再聊', '测试同学辛苦了 👍', '服务器账单这个月涨了不少',
]
/** Messages that address the agent but ask for no work: thanks, opinions, status questions, small talk. */
export const ADDRESSED_NOISE: string[] = [
  '@agent 谢谢！', '@agent 辛苦了 👍', '@agent 你觉得 Redis 和 Memcached 哪个更适合做会话缓存？', '@agent 早上好',
  '@agent 收到', '@agent 哈哈好的', '@agent 你是用什么模型？', '@agent 👍', '@agent 不用了，我自己处理了这个', '@agent 周末愉快',
  '@agent 这个解释很清楚，学到了', '@agent 你能做什么？',
]

/** Task order for hard scenarios: siblings arrive next to each other, so both are open when their follow-ups come. */
export const HARD_ORDER = [0, 12, 1, 13, 2, 8, 5, 9, 3, 4, 6, 7, 10, 11]

/** Hard cases tied to no task, and what a correct Router does with each (dispatch.md): */
export const GLOBAL_PROBES: Record<GlobalProbe, string[]> = {
  /** No referent among several open tickets: ask, do not guess (ignore with a reply). */
  vague: ['@agent 刚才那个也顺便处理一下吧', '@agent 那个问题还是有，再看看', '@agent 上面说的那个改一下'],
  /** A question that asks for no change: answer it, no ticket. */
  question: ['@agent CSV 导出用 UTF-8 BOM 还是 GBK 比较好？', '@agent 我们项目里 page_size 一般限制多少合适？', '@agent lodash 和 es-toolkit 你推荐哪个？'],
  /** A request a person puts on hold: no ticket until they lift it. */
  hold: ['@agent 先别动手，等我和产品确认完再说：支付页按钮改成绿色', '@agent 这个先记下，下周再做：把日志级别统一成 info'],
  /** A person declines the agent's help. */
  decline: ['@agent 这个 bug 我自己来修，你不用管', '@agent 不用你弄了，bob 已经在改了'],
  /** New work phrased indirectly: a ticket. */
  polite: ['@agent 有空的话能不能把日志里打印手机号的地方都脱敏一下？', '@agent 麻烦看下 staging 的健康检查为什么一直失败', '@agent 帮忙给 /api/health 加个数据库连通性检查'],
}
