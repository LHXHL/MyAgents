# macOS 应用分发方案

## 概述

将 Tauri 应用分发给其他用户安装，需要完成以下步骤：
1. **代码签名** - 使用 Apple Developer ID 签名应用
2. **公证 (Notarization)** - Apple 验证应用安全性
3. **打包** - 生成 .dmg 或 .pkg 安装包

> [!IMPORTANT]
> macOS Catalina (10.15) 及以后版本要求所有分发的应用必须经过代码签名和公证，否则 Gatekeeper 会阻止运行。

---

## 前置条件

- [x] Apple Developer 账号（付费版，$99/年）
- [ ] macOS 电脑（用于生成证书）
- [ ] Xcode 26+ 已安装（当前 apple-metal 原生依赖需要对应 SDK）
- [ ] Tauri 项目可正常构建

---

## 第一步：创建证书签名请求 (CSR)

1. 打开 **钥匙串访问** (Keychain Access)
2. 菜单栏：钥匙串访问 → 证书助理 → 从证书颁发机构请求证书
3. 填写：
   - 用户电子邮件：你的 Apple ID
   - 常用名称：你的名字
   - 选择「存储到磁盘」
4. 保存 `.certSigningRequest` 文件

---

## 第二步：在 Apple Developer 创建证书

1. 登录 [Apple Developer](https://developer.apple.com/account)
2. 进入 **Certificates, Identifiers & Profiles**
3. 点击 **Certificates** → **+** 创建新证书
4. 选择 **Developer ID Application**（App Store 外分发必选）
5. 上传第一步创建的 CSR 文件
6. 下载生成的 `.cer` 证书文件
7. 双击安装到钥匙串

### 验证证书安装

```bash
security find-identity -v -p codesigning
```

应该看到类似输出：
```
1) XXXXXXXX "Developer ID Application: Your Name (TEAM_ID)"
```

---

## 第三步：创建 App Store Connect API 密钥

用于自动化公证流程：

1. 登录 [App Store Connect](https://appstoreconnect.apple.com)
2. 用户和访问 → 集成 → 团队密钥
3. 点击 **+** 生成新密钥
4. 名称：`Notarization Key`
5. 权限：`Developer`（最小权限原则）
6. 下载 `.p8` 私钥文件（**只能下载一次！**）
7. 记录：
   - **Issuer ID**: 页面顶部显示
   - **Key ID**: 密钥列表中显示

---

## 第四步：配置环境变量

在 `~/.zshrc` 或项目 `.env` 文件中添加：

```bash
# 签名身份（从 security find-identity 输出获取）
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAM_ID)"

# Team ID（在 Apple Developer 会员页面查看）
export APPLE_TEAM_ID="XXXXXXXXXX"

# API 密钥认证（推荐方式）
export APPLE_API_ISSUER="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
export APPLE_API_KEY="XXXXXXXXXX"
export APPLE_API_KEY_PATH="/path/to/AuthKey_XXXXXXXXXX.p8"
```

刷新环境：
```bash
source ~/.zshrc
```

---

## 第五步：更新 Tauri 配置

编辑 `src-tauri/tauri.conf.json`：

```json
{
  "bundle": {
    "macOS": {
      "signingIdentity": null,
      "minimumSystemVersion": "13.0",
      "entitlements": "Entitlements.plist",
      "exceptionDomain": null
    }
  }
}
```

> `signingIdentity: null` 表示使用环境变量 `APPLE_SIGNING_IDENTITY`。录音能力要求 `Entitlements.plist` 保留 `com.apple.security.device.audio-input = true`；修改 entitlement 后必须重新构建并启动新的 `.app`，前端热重载不会更新已有进程的签名。构建后应检查实际签名产物，而不只检查源码配置。

---

## 第六步：构建签名并公证的应用

```bash
# 从 .env 加载签名配置，选择 Apple Silicon、Intel 或分别构建两种架构
./build_macos.sh
```

环境变量配置正确后，构建脚本与 Tauri 依次完成：
1. ✅ 构建脚本按目标准备资源，为 DSH 内嵌的 Mach-O 可执行文件、`.node` 与动态库签名
2. ✅ Tauri 使用 Developer ID 签名应用并提交到 Apple 公证
3. ✅ 等待公证完成（通常 2-5 分钟）
4. ✅ Staple 公证票据到应用

---

## 第七步：验证签名和公证

```bash
# 验证签名
codesign --verify --deep --strict --verbose=2 \
  src-tauri/target/universal-apple-darwin/release/bundle/macos/MyAgents.app

# 验证公证
spctl --assess --type exec --verbose=2 \
  src-tauri/target/universal-apple-darwin/release/bundle/macos/MyAgents.app

# 查看公证状态
xcrun stapler validate \
  src-tauri/target/universal-apple-darwin/release/bundle/macos/MyAgents.app
```

---

## 分发方式

### 方式一：.dmg 安装包（推荐）

Tauri 默认会生成 `.dmg` 文件，位于：
```
src-tauri/target/universal-apple-darwin/release/bundle/dmg/
```

### 方式二：直接分发 .app

压缩 `.app` 文件夹为 `.zip` 分发。

---

## 常见问题

### Q: 已编译并签名，但公证报 `HTTPClientError.connectTimeout`

这是 `notarytool` 连接公证服务时失败；`dead_code` 编译警告和 `replacing existing signature` 不是这个错误的原因。仅凭该消息不能确定是 Apple API、上传端点还是代理链路超时，也不能认定 Apple 已拒绝产物。

先检查当前构建终端的网络路径（以下请求不携带凭据）：

```bash
curl --connect-timeout 10 --max-time 20 -I https://appstoreconnect.apple.com/notary/v2/submissions
curl --connect-timeout 10 --max-time 20 -I https://notary-submissions-prod.s3-accelerate.amazonaws.com
```

收到 401/403 等 HTTP 响应代表已建立连接，不代表认证或上传成功；连接/TLS 错误则应检查 VPN、代理、防火墙和网络。浏览器可访问 Apple 不代表构建终端或 `notarytool` 使用了相同网络路径。

网络恢复后重新运行 `./build_macos.sh`，既有 Cargo 缓存可复用。若仅重试打包，必须确认源码、业务 bundle 和 staging 资源仍与失败的同一 target 对应；在加载原 `.env` 后，可用 `npm exec tauri bundle -- --target aarch64-apple-darwin`（Intel 改用 `x86_64-apple-darwin`）。资源或代码已经变化时应重新完整构建，避免打包混合产物。

如已有 submission ID，先用 `notarytool info` / `log` 和原认证方式查询结果。Apple 支持在**手动提交**时用 `--no-s3-acceleration` 排查加速上传链路；当前 Tauri CLI 不提供透传此参数的配置，不能靠给构建脚本设置一个自造环境变量生效。`notarytool --timeout` 控制等待公证结果的时限，不能修复连接超时。不要用跳过签名、公证或 stapling 的方式让正式发布显示成功。

参考：[Apple 公证工作流](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)、[Tauri CLI 2.11.4 公证实现](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.11.4/crates/tauri-macos-sign/src/lib.rs)。

### Q: 编译成功，但打包报 `failed to remove extra attributes from app bundle: failed to run xattr`

Tauri CLI 2.11.4 在签名前对 `.app` 执行 `xattr -crs`，简略错误会隐藏具体文件路径。可对失败的构建副本执行同一命令查看底层错误：

```bash
/usr/bin/xattr -crs src-tauri/target/debug/bundle/macos/MyAgents.app
```

2026-09-06 的 DSH 集成故障由 3 个平台 evidence JSON 的 `0400` 权限引起：导入时保留只读权限，复制进 App 后 `xattr` 返回 `Permission denied`。`ingest:dsh-runtime` 已在临时副本中统一资源权限，保持文件内容和原始交付物不变，并在原子替换前重新校验完整交付包。已有 staging 需用锁定交付物重新运行导入，再运行 `./build_dev.sh`；不要对源交付包递归 chmod，也不要用 `sudo`、跳过签名或忽略 `xattr` 失败来绕过问题。具体权限和校验边界见 [DSH 集成指南](../tech_docs/myagents_dsh_integrated_runtime.md#7-generated-protocol-and-artifact-consumption)。

### Q: 公证失败怎么办？

查看详细错误：
```bash
xcrun notarytool log <submission-id> --keychain-profile "notarytool-profile"
```

### Q: 用户打开时仍显示「无法验证开发者」

可能原因：
1. 公证未完成 - 等待几分钟后重试
2. 需要 staple - 运行 `xcrun stapler staple Your.app`
3. 用户离线 - 首次运行需要联网验证

### Q: CI/CD 中如何配置？

在 GitHub Actions 中设置 secrets：
- `APPLE_CERTIFICATE`: base64 编码的 .p12 文件
- `APPLE_CERTIFICATE_PASSWORD`: 导出密码
- `APPLE_SIGNING_IDENTITY`
- `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_PATH`

---

## 检查清单

- [ ] 创建 CSR 文件
- [ ] 创建 Developer ID Application 证书
- [ ] 安装证书到钥匙串
- [ ] 创建 App Store Connect API 密钥
- [ ] 配置环境变量
- [ ] 运行带签名的构建
- [ ] 用 `codesign -d --entitlements :- MyAgents.app` 确认录音 entitlement 已进入签名产物
- [ ] 验证签名和公证
- [ ] 测试在新 Mac 上安装
