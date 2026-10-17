# FF7 Rebirth Voice Studio

FF7 Rebirth 中文配音修订工作台：管理逐句音频、生成与审核 TTS、整理字幕，并制作游戏补丁。

本仓库只保存代码、数据库结构、提示词模板、测试和文档。游戏文件、音频、模型权重、数据库数据、调用日志及实际部署配置均不上传。

| 目录 | 内容 |
|---|---|
| `programs/` | 音频容器、字幕与 IoStore 工具的 Python 封装 |
| `studio-ff7-rb/` | Compose、数据库迁移、worker、备份脚本 |
| `studio-ff7-rb/website/` | Next.js 网站、TTS 自动流程、提示词管理与模型调用 |
| `gpu/` | ASR、TTS、音色转换等推理服务包装与部署模板 |

## 本地配置

```bash
cp studio-ff7-rb/.env.example studio-ff7-rb/.env
cp studio-ff7-rb/website/.env.example studio-ff7-rb/website/.env.local
cp gpu/.env.example gpu/.env
```

只在本地文件中填写数据库密码、推理服务地址及 API 密钥。环境模板不包含可用凭证或真实部署地址。网站单独开发时使用主机可访问的 `DATABASE_URL`；Compose 中的网站使用容器可访问的连接串。密码包含特殊字符时需要进行 URL 编码。

```bash
cd studio-ff7-rb
# 先填好 .env；这里仅启动数据库和管理界面
# 历史迁移包含数据回填，新空库应先完成目录导入，再按各迁移说明检查回填结果。
docker compose up -d db pgadmin

cd website
npm ci
npm run dev
```

网站默认端口为 8765，数据库管理界面默认端口为 8766。完整部署还需要配置 worker、拍数服务、推理服务和本地音频目录，见各目录文档。推理镜像与权重需自行准备；第三方源码和工具二进制不随仓库分发，见 [依赖说明](docs/dependencies.md)。

## 校验

```bash
python3 scripts/check-source-safety.py
cd studio-ff7-rb/website
node --experimental-strip-types --test src/lib/*.test.cjs
```

安全扫描只输出文件名、行号和命中类型，不输出凭证内容。上传前也应使用 Gitleaks 扫描。测试需要支持类型擦除的 Node.js；网站依赖版本以 `package-lock.json` 为准。

## 与现有部署的关系

这是经过脱敏的统一代码仓库，首次提交采用当前工作树的代码快照，没有导入旧仓库历史。已有网站与推理服务继续使用各自原部署目录；创建此仓库不会修改、重启或替换它们。以后从这里部署时，应先审阅代码差异，保留目标机器的 `.env`、数据、模型、缓存和密钥，再按正常流程构建发布。

游戏资源只在用户自己的本地环境处理。安装和打包约束见 [AGENTS.md](AGENTS.md)。
