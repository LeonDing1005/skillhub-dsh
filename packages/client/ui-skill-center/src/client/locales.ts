/** Copy owned by the Skill Center surface. */
export const en = {
  'title': 'Skill Center',
  'tab.community': 'Community Skills',
  'tab.mine': 'My Skills',
  'loading': 'Loading Community Skills',
  'empty.title': 'No Community Skills yet',
  'failure.title': 'Community Skills unavailable',
  'retry': 'Retry',
  'new': 'New',
  'stars': 'stars',
  'downloads': 'downloads',
} as const

/** Simplified Chinese product copy. */
export const zh: Record<keyof typeof en, string> = {
  'title': '技能中心',
  'tab.community': '社区技能',
  'tab.mine': '我的技能',
  'loading': '正在加载社区技能',
  'empty.title': '暂无社区技能',
  'failure.title': '社区技能暂不可用',
  'retry': '重试',
  'new': '新上架',
  'stars': '星标',
  'downloads': '下载',
}

/** Locale keys required by the Skill Center surface. */
export type SkillCenterKey = keyof typeof en
