# Agent Note: 复制仓库的 Windows 故障切换

Status: implemented

[English](2026-08-26-copied-repository-windows-failover.md) | 中文

## 问题

[复制仓库 CI 回退](2026-08-26-copied-repository-ci-fallback.md)会在计算 `DSH_CI_FAILOVER_WINDOWS` 之前选择 `windows-latest`。即使复制仓库已经部署文档规定的 `[self-hosted, dsh-win-ci, windows]` runner，也无法选择该 runner；仓库变量不会生效，原生 Windows 检查会继续使用 GitHub 托管容量。

## 决策

`windows-native` 的 runner 表达式在仓库名称回退之前计算 `DSH_CI_FAILOVER_WINDOWS=selfhosted`。对于非 Dependabot PR，该值在规范仓库和复制仓库中均选择 `[self-hosted, dsh-win-ci, windows]`。未设置该值时，复制仓库使用 `windows-latest`，规范仓库使用 `dsh-windows-2025-16core`。

Dependabot 仍然使用托管 Windows，因为不受信任的依赖更新 PR 不会在自托管池中运行。工作流测试同时锁定选择器是否存在及其顺序，防止仓库名称回退遮蔽显式故障切换选择。

## 曾考虑的替代方案

**让复制仓库固定使用 `windows-latest`。** 否决，因为即使仓库已经部署文档规定的 runner 标签，这也会使已配置的故障切换变量失效。

**让所有复制仓库默认使用自托管标签。** 否决，因为复制仓库不会继承 runner 注册信息，未完成部署时 job 会无限排队。

**增加复制仓库专用变量。** 否决，因为现有 Windows 开关已经表达该部署选择，runner 标签也完全相同。

## 后果

复制仓库保留零配置的托管回退，同时可以通过与规范仓库相同的开关选择自己的 Windows 池。仓库所有者必须先注册全部三个标签，再设置该变量。该选择规则继续独立于 `DSH_CI_FAILOVER_LINUX`。
