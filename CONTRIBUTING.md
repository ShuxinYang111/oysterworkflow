# Contributing to OysterWorkflow / 参与 OysterWorkflow

Thank you for helping improve OysterWorkflow. Before opening a pull request,
read [LICENSING.md](./LICENSING.md) because this repository contains
both Apache-2.0 open-core code and PolyForm-covered desktop-product code.

感谢你帮助改进 OysterWorkflow。提交 Pull Request 前请先阅读
[LICENSING.md](./LICENSING.md)，因为本仓库同时包含 Apache-2.0
开放核心和受 PolyForm 约束的桌面产品代码。

## Contribution License

- Contributions to Apache-2.0 files are submitted under Apache-2.0, consistent
  with section 5 of that license.
- Contributions to PolyForm-covered files are submitted under PolyForm
  Noncommercial 1.0.0 unless a separate contributor agreement applies.
- Maintainers may require a separate contributor agreement before accepting a
  desktop-product contribution that must remain available for official
  commercial licensing.
- Third-party code must keep its original license and attribution. Do not copy
  code into this repository unless its license is compatible with the target
  scope.

- 对 Apache-2.0 文件的贡献依照 Apache-2.0 第 5 条，以 Apache-2.0 提交。
- 对 PolyForm 覆盖文件的贡献默认依照 PolyForm Noncommercial 1.0.0 提交，除非
  另有贡献者协议。
- 如果桌面产品贡献需要继续支持官方商业授权，维护者可能要求先签署单独的贡献者协议。
- 第三方代码必须保留原许可证与署名；许可证与目标范围不兼容时，不得复制进入仓库。

## Development Checks

Install dependencies and run the normal checks before submitting:

```bash
npm install
npm run typecheck
npm test
```

按照项目约定，不要默认运行 e2e。只有在维护者或任务明确指定 case、catalog 或专项验证
目标时才运行 e2e，并将产物保存在仓库根目录的 `.runs/` 下。

## Pull Request Scope

- Keep each pull request focused on one problem.
- Explain which layer owns the change: UI, service/runtime, domain/contract, or
  CLI/integration.
- Add or update tests for behavior changes.
- Do not commit credentials, customer data, recordings, generated runs, build
  output, or private URLs.
- User-facing behavior and documentation should remain understandable in both
  English and Chinese.

- 每个 Pull Request 聚焦一个问题。
- 说明改动所属层级：UI、service/runtime、domain/contract 或 CLI/integration。
- 行为发生变化时补充或更新测试。
- 不得提交凭证、客户数据、录屏、生成的 run、构建产物或私有 URL。
- 面向用户的行为和文档应同时兼顾中英文场景。
