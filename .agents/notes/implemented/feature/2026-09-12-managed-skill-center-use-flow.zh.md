English | [中文](2026-09-12-managed-skill-center-use-flow.md)

---
kind: feature
status: implemented
date: 2026-09-12
---

# 托管技能中心的会话使用流程

技能中心现在要求用户在安装或更新托管版本前显式确认。启用的安装项存在时，详情对话框可以通过现有的 `conversation.insertSkillToken` seam 返回当前会话。该操作复用输入状态机已有的空格边界 token 插入和 composer 聚焦行为；技能中心只负责解析当前 Session 并恢复会话页面。缺少当前会话或会话 scope 不可用时会明确失败。

浏览器路由通过 sessions service 查找当前会话；没有当前选择时复用最近活跃的普通 Session，若不存在则创建并打开空白普通 Session。不读取 Host 路径、凭据、SkillHub URL 或原始响应。组件测试覆盖确认门控和启用安装项的会话使用动作；路由测试覆盖当前 scope 插入和空白 Session 回退。
