# P09 · 链上数据平台（进阶）

> 状态：未开始 ｜ 里程碑：M2·W9 ｜ 层级：进阶 ｜ 主线：数据 ｜ 依赖：P07
> 一句话目标：自建索引器 + BFF + 看板，把链上事件变成可查询、可对账、可出证的 API（你的 Java 主战场）。

## 目标

自建索引器 + BFF + 看板，把链上事件变成可查询、可对账、可出证的 API（你的 Java 主战场）。

出口能力：见 开发计划.md（属主仓库内容，未随本公开仓库发布） §二 项目总表与 [roadmap.md](../../roadmap.md) 对应阶段。

## 知识点

- [ ] 扫块与日志过滤（address/topics）
- [ ] 区块重组与 confirmations 深度
- [ ] 幂等写入与游标/分页
- [ ] PostgreSQL 表设计（tx/log/asset/holder）
- [ ] REST/GraphQL 与鉴权
- [ ] Spring Boot + web3j 对接

## 技术栈

- Node worker 或 Spring Boot 4.1 + Java 21 + web3j
- PostgreSQL + Flyway
- 看板：React 表格/图表

## 目录（开工时再建）

`README.md` + `contracts/` + `frontend/` + `backend/` + `docs/` + `screenshots/`（按需，不预铺空壳）

## lainchain 对照精读（完成本项目后写 1 篇）

- [ ] 读 `indexer/`（Python + SQLite 手写扫块）与 `backend/`（Ktor MVP）：列出重组处理缺失项，规划 Spring Boot 重写
- 输出：`docs/S3-合约进阶与数据/lainchain对照-P09.md`

## 任务拆解

1. [ ] 脚手架与目录（参考 [项目启动模板](../../templates/项目启动模板.md)）
2. [ ] 核心逻辑
3. [ ] 单元 / fuzz / invariant 测试
4. [ ] 部署脚本（anvil → 测试网 profile）
5. [ ] 前端 / 接口
6. [ ] 数据 / 索引（如需要）
7. [ ] 文档与截图

## 验收（质量门禁）

- [ ] 事件可查询且分页稳定
- [ ] 人为制造分叉后索引能回滚重放
- [ ] 看板按合同号/批次筛选 <1s
- [ ] README 可按步骤复现（他人 30 分钟内跑起来）
- [ ] 仓库零私钥；`.env` 未入库
- [ ] 去代币化检查表通过（如涉及对外交付）

## 复盘

- 卡住的点：
- 与 Java/传统后端的对照：
- 下次可压缩的时间：
