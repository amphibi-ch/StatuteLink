# StatuteLink（法条链接）

StatuteLink 是一个面向中文法学生和中文法律研究笔记的 Obsidian 插件。它可以识别笔记里的法条引用，例如 `民法典第1165条`、`刑诉法第71条第二款`、`刑法第16条第（二）项`，并在 Obsidian 内预览、补全、插入对应法条正文。

目标：让课堂笔记、案例阅读、论文 research 里的“法条引用”和“法条正文”不再割裂。

## 主要功能

- 识别中文法条引用。
- 支持条、款、项级别引用。
- 编辑模式和阅读模式下 hover 预览法条。
- 右侧面板集中显示当前笔记中的法条引用。
- 显示每一次引用是否已经插入正文：`已插入 / 未插入`。
- 支持多种插入格式：callout、下一级 bullet、引用块、plain text。
- 支持 `Ctrl+Enter` 法条正文补全，不占用普通换行 Enter。
- 支持从 `.doc`、`.docx`、`.pdf`、`.txt`、`.md` 导入法条文件。
- 内置七部法学生常用法律的 starter library。
## 快速开始

### 手动安装

下载 release 后，把以下内容复制到：

```text
<你的 vault>/.obsidian/plugins/statutelink/
```

需要包含：

- `main.js`
- `manifest.json`
- `styles.css`
- `bundled-laws/`

然后在 Obsidian Community plugins 中启用 `StatuteLink`。
1. 安装并启用插件。
2. 安装内置 starter library，或导入自己的法条文件。
3. 在笔记里写：

```md
- 民法典第1165条
```

4. 可以通过 hover、右侧面板或自动补全插入法条正文。

## 内置 Starter Library

插件包内置以下七部法律的 Markdown 法条库：

- 中华人民共和国宪法
- 中华人民共和国民法典
- 中华人民共和国刑法
- 中华人民共和国刑事诉讼法
- 中华人民共和国民事诉讼法
- 中华人民共和国行政诉讼法
- 中华人民共和国个人信息保护法

安装方式：

1. 打开 Obsidian 设置。
2. 找到 `StatuteLink`。
3. 在 `Library` 分组下点击 `Install bundled laws`。

也可以通过命令面板运行：

```text
StatuteLink: Install bundled starter law library
```

插件会把内置法条复制到：

```text
Legal Library/
```

如果同名文件已经存在，插件会跳过，不会覆盖用户自己的法条库。


## 导入自己的法条文件

把源文件放入：

```text
Law Sources/
```

然后运行命令：

```text
StatuteLink: Import all law sources from Law Sources folder
```

支持格式：

- `.md`
- `.txt`
- `.doc`
- `.docx`
- `.rtf`
- `.pdf`

导入后的 Markdown 法条库会生成在：

```text
Legal Library/
```

建议在桌面端使用导入功能。macOS 上 Word/RTF 提取使用 `textutil`；PDF 优先使用 `pdftotext`，不可用时尝试回退到 `textutil`。

## 自动补全

当光标前出现完整法条引用时，插件会弹出补全候选。

- 接受补全：`Ctrl+Enter`
- 普通 `Enter`：仍然是换行

补全会插入纯文本法条正文，并尽量保留当前 Markdown 缩进结构。

## 插入格式

可以在设置里选择插入格式：

- `Callout`
- `Nested bullet`
- `Block quote`
- `Plain text`

`Plain text` 会从当前光标处插入；如果内容有多行，后续行会继承当前列表/引用块的 continuation indentation，避免正文脱离 bullet。

## 法律别名

设置页支持自定义法律别名，一行一个：

```text
刑诉法=刑事诉讼法
民诉法=民事诉讼法
```

默认内置：

```text
刑诉法=刑事诉讼法
```


## 开发

```bash
npm install
npm run build
```

生成本地 release 包：

```bash
npm run release
```

输出目录：

```text
dist/
```

## 隐私

StatuteLink 默认完全本地运行。插件不会上传你的笔记、法条库或导入的源文件。

目前还无AI辅助相关功能。

## 法条文本说明

内置 starter library 主要用于学习和笔记工作流。正式引用法律条文时，请以官方来源为准。

MIT License 适用于本项目的插件代码和项目文档。本项目不对官方法律文本主张私有版权。

## 已知限制

- PDF 导入效果取决于源文件质量，可能需要人工清理。
- 引用识别是规则驱动，主要面向中文法律引用。
- 课程或老师自定义法律简称可能需要用户手动添加别名。
- 插件不会判断某个法条是否“法律适用正确”，也不构成法律意见。
