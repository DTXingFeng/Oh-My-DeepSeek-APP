# 验证记录

日期：2026-11-17。测试对象为 BlueStacks Android 9 / API 28 虚拟机，通过 `127.0.0.1:5555` 连接；WebView 为 Chrome 129。没有进行物理手机实测。

## 已完成

| 检查 | 结果与证据范围 |
| --- | --- |
| TypeScript / oxlint | `npm run type` 和 `npm run lint` 通过，0 错误、0 警告 |
| 网页资源 | `npm run build` 通过，资源随 APK 打包 |
| Android | `assembleDebug`、`lintDebug` 通过；JavaScript 开启的通用 Lint 提示保留，React 聊天界面需要 JavaScript。限制导航到本地资源，外链交给外部浏览器，CSP 禁止第三方脚本和子框架 |
| 安装与启动 | APK 安装成功，横屏与竖屏均能显示；截图见下方 |
| 官方网络 | 从虚拟机请求官方 `GET /models`，测试用无效 Key 收到 HTTP 401。后续探测也遇到一次 15 秒超时，未据此认定网络持续稳定 |
| 密钥 | 本地测试字符串经原生存储写入，杀进程重启后仍能正确读取；网页 localStorage 无此密钥。存储实现含加密后解密校验，失败不报告保存成功 |
| 长输入 | 输入 50,001 个中文字，模拟接口收到完整 50,001 字，无客户端 4 万字截断 |
| 思考和搜索 | 实际前端构建的请求带 thinking enabled、deepseek_web_search 和 deepseek_read_url；接收本地 SSE fixture 验证，不代表真实搜索验收 |
| 流式和 Markdown | 故意跨 UTF-8 字节与 SSE 帧边界分片，中文和粗体 Markdown 正常；无未捕获运行时异常 |
| 旧对话 | 将本地会话创建/更新时间设置为 30 天前，重载、选择并继续发送；模拟请求中保留之前的 user/assistant 上下文 |
| 返回键 | 关闭设置弹窗，保留既有弹窗确认逻辑 |
| 原生文件 | 从 Blob 发起系统保存，下载目录生成含中文的测试文件，内容一致；取消保存正确返回取消状态。系统文件选择器重新选中该文件后，WebView 能读取相同内容 |
| 麦克风权限 | Android 权限弹窗出现，拒绝后返回 NotAllowedError。授权时该虚拟机返回 NotReadableError，未拿到可用音轨 |

自动化复验：`node scripts/android-smoke.mjs`。原始 JSON 和中间截图保存在本机被 Git 忽略的 `evidence/local/`。所有聊天输出均为本地模拟响应，脚本拒绝覆盖真实凭据或已有对话，并清理测试对话和测试密钥。

原生文件检查使用 `scripts/check-native-dialogs.mjs`，需通过 Android 系统界面选择/保存；只读诊断工具为 `scripts/inspect-webview.mjs`。这些工具仅连接本应用的 debug WebView。

## 尚未完成

- 没有有效 DeepSeek API Key，没有调用收费模型、付费搜索、文件解析、ASR 或 TTS。不能将客户端模拟验收视为官方接口全流程验收。
- BlueStacks 未能提供可读麦克风音轨；录音、ASR 和实际朗读需在有可用音频设备及有效 Key 的环境继续验证。
- 历史 ZIP 导入/导出的归档逻辑沿用上游；系统文件保存/读取已实测。历史大文件的本地导入已补充验证，复杂文档的官方 API 解析仍未端到端验收。
- APK 为调试签名；未配置发布签名、应用商店上架、自动升级或后台持续生成服务。

## 0.1.1：导入反馈修复

旧版确认导入后仅禁用按钮，没有读取或解析状态，设置关闭后局部状态也会丢失。修复包括：确认页显示文件名和大小；读取、校验、目录、解析、保存各阶段反馈；按实际 ZIP 目录项目数与压缩数据读取量更新进度；显示已解析的对话及图片数；成功与失败的持续提示及通知；设置关闭重开后保留结果。导入执行期间阻止误关闭设置。

回归命令（独立包，与实际使用的 App 数据隔离）：

```powershell
cd android
.\gradlew.bat assembleDebug -PisolatedImportTest
cd ..
adb -s 127.0.0.1:5555 install -r android/app/build/outputs/apk/debug/app-debug.apk
adb -s 127.0.0.1:5555 shell am start -n app.ohmydeepseek.android.importtest/app.ohmydeepseek.android.MainActivity
$env:ANDROID_APP_ID='app.ohmydeepseek.android.importtest'
node scripts/import-feedback-smoke.mjs
```

该命令在旧版本的实际导入代码路径上捕获到 `hasProgress:false / hasReadingText:false / busyButton:false`。修复后通过：延迟文件读取时持续反馈、实际 ZIP 成功导入与数量提示、执行期间保持设置可见、损坏文件提示具体原因并保留原记录、设置关闭重开后保留结果。另在独立包中使用本地大档案完成真实文件选择、解析与入库；未调用模型 API，原始档案和相关截图均不提交仓库。

## 截图

以下是虚拟机中实际运行的 Android WebView 页面，不是设计图。聊天记录和测试密钥已清除。

![Android 竖屏首页](screenshots/android-home.png)
