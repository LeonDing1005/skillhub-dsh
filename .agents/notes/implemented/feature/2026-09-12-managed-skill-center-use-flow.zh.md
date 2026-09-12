# Agent Note：托管技能中心的会话使用流程

Status: implemented

[English](2026-09-12-managed-skill-center-use-flow.md) | 中文

## Problem

技能中心需要从已安装的 Community Skill 安全返回当前会话，不能绕过安装确认或会话 scope 规则。

## Decision

技能中心现在要求用户在安装或更新托管版本前显式确认。启用的安装项存在时，详情对话框可以通过现有的 `conversation.insertSkillToken` seam 返回当前会话。该操作复用输入状态机已有的空格边界 token 插入和 composer 聚焦行为；技能中心只负责解析当前 Session 并恢复会话页面。缺少当前会话或会话 scope 不可用时会明确失败。

浏览器路由通过 sessions service 查找当前会话；没有当前选择时复用最近活跃的普通 Session，若不存在则创建并打开空白普通 Session。不读取 Host 路径、凭据、SkillHub URL 或原始响应。组件测试覆盖确认门控和启用安装项的会话使用动作；路由测试覆盖当前 scope 插入和空白 Session 回退。

## Alternatives considered

**在安装完成前插入 skill token。** 否决，因为未提交或已禁用的安装不能变成模型可见内容。

**要求必须已有选中的会话。** 否决，因为现有 shell 支持无会话视图，路由可以通过 sessions service 创建空白普通会话。

## Consequences

- 安装和更新操作在会话使用前保持确认门控。
- 会话创建和 scope 解析仍由 sessions service 负责；技能中心不处理 Host 路径或凭据。
- 现有 conversation token editor 继续负责空格边界和聚焦行为。
