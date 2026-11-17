# 应用图标

采用用户确认的蓝发鲸尾女仆图标第二版，尾巴在头发和身体后方。

- `app-icon.png`：确认后的完整图稿，用于项目介绍。
- `app-icon-foreground.png`：通过内置 image_gen 工具仅去除背景，保留角色，用于 Android 自适应图标。
- `favicon.png`：96 px 网页图标。

Android 自适应图标采用渐变蓝色背景和透明角色前景。角色位于 108 dp 图层中央的 66 dp 区域，由系统应用圆形等遮罩；同时提供单色主题层。项目最低支持 Android 8.0，无需额外的旧式密度图标。参照 [Android 官方图标规范](https://developer.android.com/develop/ui/compose/system/icon_design_adaptive)。

在 Windows 上运行 `pwsh -File scripts/build-icons.ps1`，从这两张原图重新生成密度资源和 favicon。PNG 缩放使用 System.Drawing，不再调用图像生成服务。
