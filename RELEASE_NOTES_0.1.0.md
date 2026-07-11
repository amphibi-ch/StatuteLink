# StatuteLink 0.1.0

StatuteLink 是一个面向中文法学生的 Obsidian 法条引用插件。它可以识别笔记中的中文法条引用，预览对应条文，并将法条正文插入到当前笔记中。

## 本版亮点

- 识别 `民法典第1165条`、`刑诉法第71条第二款`、`刑法第16条第（二）项` 等引用格式。
- 支持 hover 预览和右侧法条引用面板。
- 支持 `已插入 / 未插入` 状态提示。
- 支持 callout、nested bullet、block quote、plain text 四种插入格式。
- 支持设置为仅插入法条正文，省略插件生成的法律名称和条文序号题头。
- 插件启用时自动创建 `Law Sources` 文件夹，并兼容 `lawsources`、`LawSources` 等同义文件夹名。
- 支持可选创建单条法条 note，并将生成的法条引用转换为 Obsidian wikilink。
- 支持 `Ctrl+Enter` 自动补全法条正文，不占用普通换行。
- 支持导入 Word、PDF、TXT、Markdown 法条文件。
- 内置七部法学生常用法律 starter library：
  - 宪法
  - 民法典
  - 刑法
  - 刑事诉讼法
  - 民事诉讼法
  - 行政诉讼法
  - 个人信息保护法

## 安装

下载并解压 `statutelink-0.1.0.zip`，将其中的 `statutelink` 文件夹放入：

```text
<你的 vault>/.obsidian/plugins/
```

然后在 Obsidian Community plugins 中启用 `StatuteLink`。

## 注意

- 内置法条库用于学习和笔记便利；正式引用请核对官方文本。
- 插件默认完全本地运行，不上传笔记或法条内容。
