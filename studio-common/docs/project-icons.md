# 每游戏图标

公共网站按运行时 `FF7_GAME_ID` 选择 `website/public/branding/{game}.png/.ico`，两个游戏不能共用品牌图标。`/icon.png`、`/favicon.ico` 和页面 metadata 指向当前游戏；metadata 携带游戏和版本参数，刷新后更新浏览器缓存及手机收藏图标。

Rebirth 两份文件从旧 `src/app/icon.png`、`favicon.ico` 原样移动，字节不变。Remake 使用本机游戏 `ff7remake.exe` 的 RT_GROUP_ICON 123 及其 RT_ICON 资源；256px PNG 是原始嵌入字节，ICO只恢复标准目录和原始图像数据，不修改图像。图像属于原游戏，未重新绘制。

Remake PNG SHA256：`56e1184214dd446056f4a58c8e4e5f543ed98609eda7bc5ebc3eca6221a611a5`；Rebirth PNG：`c2ca34bd09ba5745f2422e2d6aefb3b88d08ded4296e2216d80e2033d062e277`。
