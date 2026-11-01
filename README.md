# 通用 PCB 贴片定位工具（GerberPick）

**导入板图，找到每颗物料。（Gerber in. Parts in place.）**

[在线使用（Live demo）](https://lizilaila.github.io/gerber-pick/) · [下载版本（Download）](https://github.com/LiziLaiLa/gerber-pick/releases) · [英文说明（English）](README.en.md)

![GerberPick 合成示例板工作台](docs/screenshot.png)

这是一个浏览器本地运行的 Gerber 查看和手工贴片定位工具。导入 Gerber、BOM 和贴片坐标，选择一种物料，就能在正反面板图上看到全部位置与数量。

## 怎么用（Quick start）

1. 拖入一个 ZIP，或一起选择 Gerber/钻孔文件、BOM CSV 和贴片坐标 CSV / KiCad `.pos`。
2. 点击左侧物料，在两面图上查看对应位置。可按规格、位号或料号搜索。
3. 表头或单位不匹配时，展开“文件、列映射与坐标校准”，选择文件/列、单位和原点偏移。
4. 需要留档时点“导出离线贴片图”。将下载包**全部解压**，直接打开其中的 `index.html`，无需脚本或服务器。

普通 Gerber 通常只有光绘板图，不含完整 BOM 和器件中心。因此：只有 Gerber 时可看板图；有 BOM 才有可靠物料参数；有 CPL/PnP/`.pos` 才能准确定位。没有坐标的位号仍保留在清单中，不编造位置。X2 引脚属性不当作器件中心，当前尚不完整支持 X3 元件层。

## 支持什么（Features）

- RS-274X Gerber、Excellon 钻孔、ZIP、CSV / TSV、KiCad `.pos`。
- 常见 KiCad、EasyEDA / 嘉立创、JLCPCB 和 Altium 导出的中英表头；未知表头可手动映射。
- mm / inch / mil、正负原点、Y 方向、已镜像的背面 X 坐标校正。
- 正反面位置、同物料归组数量、DNP 标记、独立离线贴片图导出。
- 中英界面，电脑和窄屏布局。

XLSX、ODB++、IPC-2581、3D 模型不在当前范围内。请导出 CSV/TSV。Gerber 与贴片坐标必须使用相同原点，焊接前用实际非对称器件检查方向。DNP 表示不贴：界面和导出图均有明确标记。

<a id="exporting-your-files"></a>

## 从设计软件导出（Exporting your files）

Gerber 和贴片坐标必须使用同一原点，并保留板框。BOM 和坐标文件的位号需要一致。

| 设计软件 | 导出的文件 |
| --- | --- |
| KiCad | Gerber、Excellon 钻孔、BOM CSV，以及含单位信息的 `.pos` 或坐标 CSV |
| 嘉立创 / EasyEDA / JLCPCB | Gerber ZIP、BOM CSV、贴片坐标 CPL CSV，常见列为 Designator、Mid X、Mid Y、Layer、Rotation |
| Altium 或其他软件 | Gerber、钻孔、BOM CSV/TSV 和贴片坐标 CSV；表头不匹配时手动映射 |

只有 Gerber 时先查看板图；如需物料归组和位置，请一起导入 BOM 与贴片坐标。导入前不需要把文件上传到任何服务器。

## 隐私（Privacy）

板文件只在浏览器内存中读取，不上传、无账号、无统计追踪、不写本地存储。运行依赖都打包在本站，不依赖外部 CDN。刷新后会清空当前导入，需保留时请导出贴片图。站点仅加载自己的静态应用和合成示例。

限制：单个展开文件 10 MiB、总选择 20 MiB、总展开 50 MiB、ZIP 500 项、每项展开比不超过 200 倍；拒绝加密、ZIP64、重名和路径穿越。失败会说明原因，并保留上一块成功显示的板图。

## 本地运行（Run locally）

需要 Node.js 22+：

```sh
npm ci
npm test
npm run build
npm run dev
```

打开终端输出的本机地址。Release 的 `gerber-pick-web.zip` 是完整静态应用，解压后用任意静态服务器打开，例如 `python -m http.server 8080`。若要双击直接查看，请用应用导出的“离线贴片图”。

本项目为 v0.1 装配辅助工具，不代替 CAM/DRC 或制造验收。更多格式限制、架构及依赖致谢见[英文说明（English）](README.en.md)。示例板全部为自造测试数据。

MIT 开源。如果它帮你少找几颗电阻，欢迎点个 ⭐，让更多做硬件的人看到。

## 开发与贡献（Development & contributing）

本项目使用 MIT 协议。欢迎提交 Issue 和 PR；请使用可公开分享的最小示例，不要上传保密板文件。详细开发、格式限制和第三方致谢见[英文说明（English）](README.en.md)及[贡献指南（Contributing）](CONTRIBUTING.md)。
