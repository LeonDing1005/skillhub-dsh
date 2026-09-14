# Agent Note：托管技能中心生命周期 UI

Status: implemented

[English](2026-09-12-managed-skill-center-lifecycle-ui.md) | 中文

## Problem

技能中心需要浏览器生命周期界面，但不能把 Host 专属安装数据或未经验证的 Community 元数据带入 UI。

## Decision

当 Host 提供托管安装方法时，技能中心启用“我的技能”。页面加载安全的安装投影，展示启用和禁用状态，并通过 connection API 执行启用、禁用、卸载、安装和更新操作。社区技能详情对话框通过不可变的 registry identity 和精确版本关联安装。

浏览器只发送安全 identity 字段和生成的幂等键。Host 专属的源 URL、凭据、技能包路径和原始 receipt 不进入 UI 投影。Personal Skill Inventory 现在聚合所有已发现来源，保留被遮蔽的候选以便透明展示，并把当前解析结果与安装状态分开标记。Host 路径只以来源相对的展示路径跨 wire；`skills/change` 会让浏览器重新获取当前会话的 inventory。

## Alternatives considered

**向浏览器暴露完整 receipt。** 否决，因为 receipt 包含本地路径和源元数据，不属于浏览器 contract。

**让浏览器根据显示名称构造生命周期请求。** 否决，因为显示名称不是不可变 identity，可能操作错误的版本。

## Consequences

- 只有 Host 暴露相应方法时，浏览器生命周期操作才可用。
- 精确 registry identity 和生成的幂等键使重试可寻址，同时不暴露 Host 存储细节。
- Inventory 行将托管 receipt 的已安装状态与解析后的 provider winner 分开，因此同名的本地或随包技能不会被误标为托管技能。
- 现在，完整的无密钥 Web 流程会通过真实 Host 与浏览器组合覆盖浏览、安全预览、精确安装、会话插入、禁用／启用可见性以及卸载。
