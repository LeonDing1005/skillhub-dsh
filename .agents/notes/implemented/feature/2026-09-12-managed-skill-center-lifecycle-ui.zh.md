# Agent Note：托管技能中心生命周期 UI

Status: implemented

[English](2026-09-12-managed-skill-center-lifecycle-ui.md) | 中文

## Problem

技能中心需要浏览器生命周期界面，但不能把 Host 专属安装数据或未经验证的 Community 元数据带入 UI。

## Decision

当 Host 提供托管安装方法时，技能中心启用“我的技能”。页面加载安全的安装投影，展示启用和禁用状态，并通过 connection API 执行启用、禁用、卸载、安装和更新操作。社区技能详情对话框通过不可变的 registry identity 和精确版本关联安装。

浏览器只发送安全 identity 字段和生成的幂等键。Host 专属的源 URL、凭据、技能包路径和原始 receipt 不进入 UI 投影。当前“我的技能”覆盖托管安装；本地、随包和运行时来源的聚合仍属于 Host 投影职责。

## Alternatives considered

**向浏览器暴露完整 receipt。** 否决，因为 receipt 包含本地路径和源元数据，不属于浏览器 contract。

**让浏览器根据显示名称构造生命周期请求。** 否决，因为显示名称不是不可变 identity，可能操作错误的版本。

## Consequences

- 只有 Host 暴露相应方法时，浏览器生命周期操作才可用。
- 精确 registry identity 和生成的幂等键使重试可寻址，同时不暴露 Host 存储细节。
- 更完整的 Personal Skill Inventory 聚合仍属于 Host 投影职责。
- 现在，完整的无密钥 Web 流程会通过真实 Host 与浏览器组合覆盖浏览、安全预览、精确安装、会话插入、禁用／启用可见性以及卸载。
