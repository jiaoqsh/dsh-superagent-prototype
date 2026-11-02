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
}

export const TASKS: TaskText[] = [
  { request: '@agent 登录页在 Safari 上“登录”按钮和输入框错位了，帮忙修一下，截图在上面。',
    followups: ['顺便把移动端也看一下，iPhone 上好像也有类似问题', '按钮间距按设计稿 16px 来'],
    cross: ['刚才说的 Safari 登录页错位那个，设计那边说按钮改成主题蓝', '登录页按钮那个问题，产品说这周五前要上线'] },
  { request: '@agent 订单导出 CSV 的时候中文乱码，用 Excel 打开全是问号，能修一下吗',
    followups: ['应该是没加 BOM，加上 UTF-8 BOM 试试', '导出的金额列也请保留两位小数'] ,
    cross: ['订单导出乱码那个，财务说还需要加一列“下单渠道”', '导出 CSV 那个事，记得兼容 WPS'] },
  { request: '@agent 用户列表接口 /api/users 分页参数 page_size 传 0 会直接 500，加个校验',
    followups: ['上限也限制一下，最大 100', '错误信息用统一的 ErrorCode 格式'],
    cross: ['关于 /api/users 分页那个修复，后端规范要求返回 400 不是 422', '用户列表分页那个，顺便把 page 小于 1 也拦掉'] },
  { request: '@agent 把 README 里的本地启动步骤更新一下，现在 node 版本要求已经是 22 了',
    followups: ['pnpm 版本也写上，11.x', '再加一节常见问题：端口被占用怎么办'],
    cross: ['更新 README 那个，记得把 docker 启动方式也写进去', 'README 启动文档那个，Windows 用户需要单独说明'] },
  { request: '@agent 首页加载太慢了，Lighthouse 性能分只有 40，看看能不能把首屏的大图懒加载',
    followups: ['图片也可以转成 webp', '优先处理 banner 区域'],
    cross: ['首页性能那个优化，监控显示主要是那个 2MB 的 vendor 包，也看一下拆包', '首页懒加载那个事，SEO 同学说首屏图片不能懒加载'] },
  { request: '@agent 消息通知的邮件模板里公司名还是旧的，全部替换成新名字“星河科技”',
    followups: ['页脚的版权年份也更新到 2026', '退订链接也检查一下是否可用'],
    cross: ['邮件模板换公司名那个，法务说页脚还要加上备案号', '改邮件模板那个任务，logo 也要换成新的'] },
  { request: '@agent 搜索框输入特殊字符比如 % 会报错，帮忙转义一下',
    followups: ['下划线 _ 也有同样问题', '加个单测覆盖这些字符'],
    cross: ['搜索框特殊字符那个 bug，客服又反馈了反斜杠也会出错', '搜索转义那个修复，记得前后端都要处理'] },
  { request: '@agent 给定时任务 cleanup-sessions 加一个告警，失败的时候发到运维群',
    followups: ['连续失败 3 次再告警，不要每次都发', '告警里带上失败原因'],
    cross: ['cleanup-sessions 告警那个，运维说告警发到 oncall 机器人就行，不用发群', '定时任务告警那个事，周末也要发'] },
  { request: '@agent 设置页的“深色模式”开关刷新后会丢失，状态没持久化，修一下',
    followups: ['存 localStorage 就行', '跟随系统也作为一个选项'],
    cross: ['深色模式开关那个，设计说默认跟随系统', '深色模式持久化那个问题，登录后要同步到账号设置'] },
  { request: '@agent 依赖里 lodash 版本有安全漏洞告警，升级到最新的 4.x',
    followups: ['升级完跑一遍全量测试', 'lockfile 一起提交'],
    cross: ['lodash 升级那个，安全组说 axios 也有个高危，一起升了吧', '升级 lodash 那个，注意别动 major 版本'] },
  { request: '@agent 报表页日期选择器默认是美国格式，改成 YYYY-MM-DD',
    followups: ['周一作为每周第一天', '快捷选项加上“本季度”'],
    cross: ['报表日期格式那个，海外版还是要保留原格式，按语言区分', '日期选择器那个改动，导出的文件名日期也统一一下'] },
  { request: '@agent CI 里 e2e 测试经常超时，看看能不能把超时调大并加重试',
    followups: ['重试最多 2 次', '超时先调到 60 秒'],
    cross: ['e2e 超时那个，我发现是测试库没清理导致的，可以顺便加个清理步骤', 'CI e2e 那个事，别影响主干的合并速度'] },
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
