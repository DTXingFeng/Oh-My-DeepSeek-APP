# Oh-My-DeepSeek-APP

Android 个人聊天客户端，直连 **DeepSeek 官方付费 API**。基于官方 MIT 开源 [chat-demo](https://github.com/deepseek-ai/chat-demo)，将完整前端打包进 APK，提供 Android 文件、麦克风、密钥保存与返回键适配。详见 [来源说明](NOTICE.md)。

客户端不设每日聊天额度、4 万字输入上限或七天会话失效规则。API 本身的计费、上下文、文件与服务端限制仍然适用：[具体边界与核查来源](docs/LIMITS.md)。

## 使用

1. 安装构建得到的 APK，打开 **Oh My DeepSeek**。
2. 在首次出现的「设置 → 数据管理」输入你自己的 DeepSeek API Key。应用先通过 `GET /models` 验证密钥，再保存。
3. 开始对话，可以切换深度思考和智能搜索，添加文件、图片，使用语音输入或朗读。
4. 对话保存在本机；卸载前在「设置 → 数据管理」导出 ZIP。导入历史会替换现有本地历史，应用会先显示确认。

需要 Android 8.0+ 及较新的 Android System WebView / Chrome（构建目标 Chromium 105+）。默认模型是 `deepseek-flash`，服务器是 `https://api.deepseek.com`，没有本项目运营的中转服务器。

## 跨会话记忆

0.2.0 提供「保存的记忆」与「引用历史聊天」。从输入框的记忆图标进入管理界面，可增删改查、关闭自动整理、排除当前对话，以及导出/导入记忆 JSON。回答旁可查看本轮提供的记忆来源。

旧对话只在本机建立文字检索索引；自动整理新记忆会额外调用 DeepSeek 官方 API，设置中可关闭。原理、费用、删除行为和与 ChatGPT 的区别见 [记忆说明](docs/MEMORY.md)。

## 数据

- Android 版 API Key 使用 AES-GCM 加密，解密密钥保存在 Android Keystore，网页 localStorage 不保存 API Key。系统云备份和设备迁移均排除应用数据。
- 对话和附件保存在应用私有 WebView 数据目录。发送、上传、搜索及语音功能会把所需内容发给 DeepSeek 官方服务。
- 没有内置 API Key。API Key 不包含在历史导出或 APK 中。
- 浏览器开发版沿用上游的 localStorage 密钥存储方式；Android 版使用原生加密存储。

## 构建

环境：Node.js 24、JDK 21、Android SDK Platform 35。项目包含 Gradle 8.11.1 Wrapper，使用 AGP 8.7.2。

```powershell
npm ci --ignore-scripts --no-audit --no-fund
npm run type
npm run lint
npm run build

# 在 android/local.properties 写入本机路径，或配置 ANDROID_HOME
# sdk.dir=C:/Users/yourname/AppData/Local/Android/Sdk
cd android
.\gradlew.bat assembleDebug lintDebug
```

APK：`android/app/build/outputs/apk/debug/app-debug.apk`。这是开发调试签名，正式分发前需要自有签名密钥。GitHub Actions 会运行构建和静态检查，保存 APK artifact。

开发网页：`npm run dev`，访问 `http://localhost:8090`。Android 构建自动将 `dist/` 同步到 APK 资源，不加载线上网页。

## 虚拟机检查

```powershell
adb connect 127.0.0.1:5555
adb -s 127.0.0.1:5555 install -r android/app/build/outputs/apk/debug/app-debug.apk
adb -s 127.0.0.1:5555 shell am start -n app.ohmydeepseek.android/.MainActivity
node scripts/android-smoke.mjs
```

验收脚本只能用于**没有真实密钥、没有历史对话的调试安装**，使用本地模拟 SSE 响应验证客户端并清理自己的测试记录，不调用收费模型接口。可通过 `ANDROID_SERIAL` 指定虚拟机。它验证客户端行为，不能证明官方模型实际回答质量。

实际测试范围、未验收项见 [验证记录](docs/VALIDATION.md)。

0.1.1 起，导入历史记录会显示文件名、大小、处理阶段与进度，完成后显示导入数量；失败时显示具体原因。导入在本机进行，无需调用模型 API。

## 许可证

[MIT](LICENSE)。保留上游版权，第三方依赖遵守各自许可证。
