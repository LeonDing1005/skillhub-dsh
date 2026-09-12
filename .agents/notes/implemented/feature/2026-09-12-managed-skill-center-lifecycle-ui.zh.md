# Agent Note：托管技能中心生命周期 UI

[English](2026-09-12-managed-skill-center-lifecycle-ui.md) | 中文

当 Host 提供托管安装方法时，技能中心现在启用“我的技能”。页面加载安全的安装投影，展示启用和禁用状态，并通过 connection API 执行启用、禁用、卸载、安装和更新操作。社区技能详情对话框通过不可变的 registry identity 和精确版本关联安装。

浏览器只发送安全 identity 字段和生成的幂等键。Host 专属的源 URL、凭据、技能包路径和原始 receipt 不进入 UI 投影。当前“我的技能”覆盖托管安装；本地、随包和运行时来源的聚合仍属于 Host 投影职责。
