# DOOM 覆盖层演示

在 pi 中以覆盖层方式玩 DOOM。证明覆盖层系统可以处理 35 FPS 的实时游戏渲染。

## 用法

```bash
pi --extension ./examples/extensions/doom-overlay
```

然后运行：
```
/doom-overlay
```

共享版 WAD 文件（约 4MB）会在首次运行时自动下载。

## 操作

| 动作 | 按键 |
|--------|------|
| 移动 | WASD 或方向键 |
| 跑动 | Shift + WASD |
| 开火 | F 或 Ctrl |
| 使用/开门 | 空格 |
| 武器 | 1-7 |
| 地图 | Tab |
| 菜单 | Escape |
| 暂停/退出 | Q |

## 工作原理

DOOM 以 WebAssembly 形式运行，编译自 [doomgeneric](https://github.com/ozkl/doomgeneric)。每一帧用半块字符（▀）加 24 位颜色渲染：上像素是前景色，下像素是背景色。

覆盖层使用：
- `width: "90%"` - 终端宽度的 90%
- `maxHeight: "80%"` - 最高为终端高度的 80%
- `anchor: "center"` - 在终端中居中

高度由宽度计算得出，以保持 DOOM 的 3.2:1 宽高比（考虑半块渲染）。

## 致谢

- [id Software](https://github.com/id-Software/DOOM)，原版 DOOM
- [doomgeneric](https://github.com/ozkl/doomgeneric)，可移植的 DOOM 实现
- [pi-doom](https://github.com/badlogic/pi-doom)，最初的 pi 集成
