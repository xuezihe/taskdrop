# TaskDrop database

本目录是 TaskDrop 的 PostgreSQL 部署基础设施，与项目应用代码解耦：
应用通过 `DATABASE_URL` 连接已运行的数据库，不关心数据库如何被拉起。

## 启动数据库

```bash
docker compose --env-file .env -f db/compose.yml up -d
```

启动后 PostgreSQL 18 仅监听 `127.0.0.1:5432`。数据库和用户默认为
`taskdrop`，密码必须通过根目录 `.env` 中的 `POSTGRES_PASSWORD` 显式提供。

对应的连接串（开发用）：

```
DATABASE_URL=postgres://taskdrop:REPLACE_WITH_PASSWORD@localhost:5432/taskdrop
```

## 停止与清理

```bash
docker compose --env-file .env -f db/compose.yml down        # 停止容器，保留数据卷
docker compose --env-file .env -f db/compose.yml down -v     # 同时删除数据卷
```

## 与应用的关系

- 应用进程（`src/production/main.ts`）只读取 `DATABASE_URL`，不启动、停止或销毁容器。
- `pnpm verify` 保持 database-free；需要数据库的验证使用独立显式命令或手动 smoke，不进 `pnpm verify`。
- 本目录不属于 Production runtime 的 import graph 或 build output。
