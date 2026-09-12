# Agent Note：Managed Skill Lifecycle RPC

Status: implemented

[English](2026-09-12-managed-skill-lifecycle-rpc.md) | 中文

## Problem

浏览器需要托管安装生命周期操作，但 Host 专属的源数据、凭据和包路径必须保持私有，而且部署可以不挂载安装 service。

## Decision

Host API 现在通过 typed RPC map 和浏览器 connection client 暴露托管安装列表、安装、更新、启用状态和卸载方法。请求携带不可变 identity、确切版本和调用方幂等键。响应只包含规范名称、启用状态、安装时间和 fingerprint；源 URL、凭据和本地包路径始终留在 Host。

未挂载 managed installation service 时，生命周期调用返回 typed internal-unavailable 结果。浏览器端 contract 仍可供后续部署挂载 service。

## Alternatives considered

**通过 RPC 发送原始安装 receipt。** 否决，因为 receipt 包含 Host 本地路径和源服务器元数据。

**要求每个 Host 组合都必须挂载安装 service。** 否决，因为 Community Skill 生命周期能力是可选的，现有部署仍需提供其他 API 方法。

## Consequences

- 浏览器客户端可以使用调用方幂等键重试精确的生命周期操作。
- 缺少 Host 能力时返回 typed 结果，而不是出现未定义的 RPC 方法。
- wire 投影小于 Host receipt，不能暴露本地安装细节。
