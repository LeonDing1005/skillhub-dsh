# Agent Note：Managed Skill Lifecycle RPC

[English](2026-09-12-managed-skill-lifecycle-rpc.md) | 中文

Host API 现在通过 typed RPC map 和浏览器 connection client 暴露托管安装列表、安装、更新、启用状态和卸载方法。请求携带不可变 identity、确切版本和调用方幂等键。响应只包含规范名称、启用状态、安装时间和 fingerprint；源 URL、凭据和本地包路径始终留在 Host。

未挂载 managed installation service 时，生命周期调用返回 typed internal-unavailable 结果。浏览器端 contract 仍可供后续部署挂载 service。
