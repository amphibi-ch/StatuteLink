import { acceptCompletion, autocompletion, completionKeymap, CompletionContext, CompletionResult, startCompletion } from "@codemirror/autocomplete";
import { EditorView, keymap } from "@codemirror/view";
import {
  App,
  ButtonComponent,
  Editor,
  ItemView,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf
} from "obsidian";

const VIEW_TYPE_LEGAL_REFERENCE = "legal-reference-view";
const LEGAL_LIBRARY_DIR = "Legal Library";
const LAW_SOURCE_DIR = "Law Sources";
const BUNDLED_LAWS_DIR = "bundled-laws";
const BUNDLED_LAW_FILES = [
  "中华人民共和国个人信息保护法.md",
  "中华人民共和国刑事诉讼法.md",
  "中华人民共和国刑法.md",
  "中华人民共和国宪法.md",
  "中华人民共和国民事诉讼法.md",
  "中华人民共和国民法典.md",
  "中华人民共和国行政诉讼法.md"
];
const DATABASE_PATHS = ["legal_database.md", "sample_database.md"];

interface LegalItem {
  number: number;
  text: string;
}

interface LegalParagraph {
  number: number;
  text: string;
  items: LegalItem[];
}

interface LegalArticle {
  law: string;
  lawKey: string;
  article: number;
  articleLabel: string;
  text: string;
  paragraphs: LegalParagraph[];
}

interface LegalReference {
  raw: string;
  lawAlias: string | null;
  article: number;
  articleLabel: string;
  paragraph: number | null;
  item: number | null;
  start: number;
  end: number;
}

interface ResolvedReference {
  reference: LegalReference;
  article: LegalArticle;
  isInserted?: boolean;
}

interface PopoverOptions {
  showInsert: boolean;
}

interface ImportedArticle {
  number: number;
  heading: string;
  body: string;
}

interface ImportedLawSource {
  law: string;
  articles: ImportedArticle[];
}

type InsertionFormat = "callout" | "bullet" | "quote" | "plaintext";

interface LegalReferenceSettings {
  insertionFormat: InsertionFormat;
  contentOnlyInsertion: boolean;
  enableStatuteNotes: boolean;
  statuteNotesFolder: string;
  lawAliases: string;
}

const DEFAULT_SETTINGS: LegalReferenceSettings = {
  insertionFormat: "callout",
  contentOnlyInsertion: false,
  enableStatuteNotes: false,
  statuteNotesFolder: "Legal Notes",
  lawAliases: "刑诉法=刑事诉讼法"
};

export default class LegalReferencePlugin extends Plugin {
  private articles: LegalArticle[] = [];
  private lastEditor: Editor | null = null;
  private lastMarkdownFile: TFile | null = null;
  settings: LegalReferenceSettings = { ...DEFAULT_SETTINGS };
  private activePopover: HTMLElement | null = null;
  private activePopoverResolved: ResolvedReference | null = null;
  private activePopoverCanInsert = false;
  private popoverCloseTimer: number | null = null;

  async onload() {
    await this.loadSettings();
    await this.ensureFolder(LAW_SOURCE_DIR);
    this.addSettingTab(new LegalReferenceSettingTab(this.app, this));
    this.registerView(
      VIEW_TYPE_LEGAL_REFERENCE,
      (leaf) => new LegalReferenceView(leaf, this)
    );

    this.addRibbonIcon("scroll-text", "Open legal references", () => {
      void this.activateReferenceView();
    });

    this.addCommand({
      id: "open-legal-reference-panel",
      name: "Open legal reference panel",
      callback: () => {
        void this.activateReferenceView();
      }
    });

    this.addCommand({
      id: "rescan-legal-database",
      name: "Rescan legal database",
      callback: async () => {
        await this.loadDatabase();
        this.refreshReferenceLeaves();
        new Notice(`Indexed ${this.articles.length} legal articles.`);
      }
    });

    this.addCommand({
      id: "import-active-law-source",
      name: "Import active law source",
      callback: async () => {
        await this.importActiveLawSource();
      }
    });

    this.addCommand({
      id: "import-law-sources-folder",
      name: "Import all law sources from Law Sources folder",
      callback: async () => {
        await this.importLawSourcesFolder();
      }
    });

    this.addCommand({
      id: "install-bundled-law-library",
      name: "Install bundled starter law library",
      callback: async () => {
        await this.installBundledLawLibrary();
      }
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (file instanceof TFile && isSupportedLawSource(file)) {
          menu.addItem((item) => {
            item
              .setTitle("Import as law source")
              .setIcon("scroll-text")
              .onClick(() => {
                void this.importLawSourceFile(file);
              });
          });
        }
      })
    );

    this.registerEvent(
      this.app.workspace.on("editor-change", (editor, view) => {
        this.rememberEditor(editor, view instanceof MarkdownView ? view.file : null);
      })
    );

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        if (leaf?.view instanceof MarkdownView) {
          this.rememberEditor(leaf.view.editor, leaf.view.file);
        }
      })
    );

    this.registerMarkdownPostProcessor((element) => {
      this.decorateRenderedMarkdown(element);
    });

    this.registerEditorExtension([
      this.createEditorHoverExtension(),
      this.createAutocompleteExtension()
    ]);

    this.registerDomEvent(document, "click", (event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.closest(".legal-reference-popover")) {
        this.closePopover();
      }
    });
    this.registerDomEvent(document, "keydown", (event) => {
      if (event.key === "Enter" && this.activePopoverResolved && this.activePopoverCanInsert) {
        event.preventDefault();
        event.stopPropagation();
        const resolved = this.activePopoverResolved;
        void this.insertArticleCallout(resolved.article, resolved.reference);
        this.closePopover();
        return;
      }

      this.closePopover();
    });
    this.registerDomEvent(window, "scroll", () => {
      this.closePopover();
    }, true);

    this.rememberCurrentEditor();
    await this.loadDatabase();
  }

  onunload() {
    this.closePopover();
  }

  async loadSettings() {
    this.settings = { ...DEFAULT_SETTINGS, ...(await this.loadData()) };
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async loadDatabase() {
    const libraryArticles = await this.loadLegalLibraryArticles();
    if (libraryArticles.length > 0) {
      this.articles = libraryArticles;
      return;
    }

    const databaseFiles = DATABASE_PATHS
      .map((databasePath) => this.app.vault.getAbstractFileByPath(databasePath))
      .filter((file): file is TFile => file instanceof TFile);

    if (databaseFiles.length === 0) {
      this.articles = [];
      new Notice(`Legal database not found: ${LEGAL_LIBRARY_DIR}, ${DATABASE_PATHS.join(", ")}`);
      return;
    }

    const contents = await Promise.all(databaseFiles.map((file) => this.app.vault.read(file)));
    this.articles = dedupeLegalArticles(contents.flatMap((content) => parseDatabase(content)));
  }

  async importActiveLawSource() {
    const activeFile = this.app.workspace.getActiveFile();
    if (!(activeFile instanceof TFile)) {
      new Notice(`Open a Markdown/TXT source, right-click a source file, or place DOC/DOCX/PDF files in ${LAW_SOURCE_DIR}.`);
      return;
    }

    await this.importLawSourceFile(activeFile);
  }

  async importLawSourcesFolder() {
    const files = this.app.vault.getFiles().filter((file) => {
      return isInLawSourceFolder(file) && isSupportedLawSource(file);
    });

    if (files.length === 0) {
      await this.ensureFolder(LAW_SOURCE_DIR);
      new Notice(`No law sources found. Put .doc, .docx, .pdf, .txt, or .md files in ${LAW_SOURCE_DIR}.`);
      return;
    }

    let importedCount = 0;
    let articleCount = 0;

    for (const file of files) {
      try {
        const imported = await this.importLawSourceFile(file, false);
        if (imported) {
          importedCount += 1;
          articleCount += imported.articles.length;
        }
      } catch (error) {
        console.error("Legal Reference import failed", file.path, error);
        new Notice(`Failed to import ${file.name}: ${error instanceof Error ? error.message : "unknown error"}`);
      }
    }

    await this.loadDatabase();
    this.refreshReferenceLeaves();
    new Notice(`Imported ${articleCount} articles from ${importedCount} source file(s).`);
  }

  async installBundledLawLibrary() {
    await this.ensureFolder(LEGAL_LIBRARY_DIR);

    const adapter = this.app.vault.adapter;
    const pluginDir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    let installedCount = 0;
    let skippedCount = 0;

    for (const fileName of BUNDLED_LAW_FILES) {
      const targetPath = `${LEGAL_LIBRARY_DIR}/${fileName}`;
      const existing = this.app.vault.getAbstractFileByPath(targetPath);
      if (existing instanceof TFile) {
        skippedCount += 1;
        continue;
      }

      const bundledPath = `${pluginDir}/${BUNDLED_LAWS_DIR}/${fileName}`;
      let content: string;
      try {
        content = await adapter.read(bundledPath);
      } catch (error) {
        console.error("Legal Reference bundled law install failed", bundledPath, error);
        new Notice(`Bundled law file not found: ${fileName}`);
        continue;
      }

      await this.app.vault.create(targetPath, content);
      installedCount += 1;
    }

    await this.loadDatabase();
    this.refreshReferenceLeaves();
    new Notice(`Installed ${installedCount} bundled law file(s); skipped ${skippedCount} existing file(s).`);
  }

  async importLawSourceFile(file: TFile, refresh = true) {
    if (!isSupportedLawSource(file)) {
      new Notice(`Unsupported law source type: .${file.extension}`);
      return null;
    }

    const text = await this.extractLawSourceText(file);
    const imported = parseImportedLawSource(text, file.basename);
    if (imported.articles.length === 0) {
      new Notice(`No articles detected in ${file.name}. Expected lines like 第一千一百六十五条.`);
      return null;
    }

    await this.ensureFolder(LEGAL_LIBRARY_DIR);
    const libraryPath = `${LEGAL_LIBRARY_DIR}/${safeFileName(imported.law)}.md`;
    const existing = this.app.vault.getAbstractFileByPath(libraryPath);
    const markdown = renderLibraryMarkdown(imported.law, imported.articles);

    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, markdown);
    } else {
      await this.app.vault.create(libraryPath, markdown);
    }

    if (refresh) {
      await this.loadDatabase();
      this.refreshReferenceLeaves();
      new Notice(`Imported ${imported.articles.length} articles from ${file.name}.`);
    }

    return imported;
  }

  async scanActiveFile(): Promise<ResolvedReference[]> {
    this.rememberCurrentEditor();
    const activeFile = this.app.workspace.getActiveFile();
    const file = activeFile instanceof TFile && activeFile.extension === "md"
      ? activeFile
      : this.lastMarkdownFile;

    if (!(file instanceof TFile) || file.extension !== "md") {
      return [];
    }

    const content = await this.app.vault.read(file);
    return this.resolveTextReferences(stripGeneratedLawInsertionsPreserveOffsets(content), {
      includeInsertionStatus: true,
      sourceText: content
    });
  }

  resolveTextReferences(text: string, options: { includeInsertionStatus?: boolean; sourceText?: string } = {}): ResolvedReference[] {
    return this.resolveReferences(
      parseReferences(text),
      options.includeInsertionStatus ? options.sourceText ?? text : undefined
    );
  }

  async insertArticleCallout(article: LegalArticle, reference?: LegalReference) {
    const editor = this.app.workspace.activeEditor?.editor ?? this.lastEditor;
    if (!editor) {
      new Notice("Open a Markdown editor before inserting legal text.");
      return;
    }

    const cursor = editor.getCursor("from");
    const beforeCursor = editor.getLine(cursor.line).slice(0, cursor.ch);
    const statuteLink = this.settings.enableStatuteNotes && reference
      ? await this.ensureStatuteNote(article, reference)
      : undefined;
    editor.replaceSelection(formatArticleInsertion(
      article,
      reference,
      this.settings.insertionFormat,
      this.settings.contentOnlyInsertion,
      statuteLink,
      beforeCursor
    ));
  }

  async ensureStatuteNote(article: LegalArticle, reference: LegalReference) {
    const folder = normalizeVaultFolderPath(this.settings.statuteNotesFolder || DEFAULT_SETTINGS.statuteNotesFolder);
    const lawFolder = `${folder}/${safeFileName(article.law)}`;
    await this.ensureFolderPath(lawFolder);

    const notePath = `${lawFolder}/${safeFileName(formatArticleLabel(article))}.md`;
    const existing = this.app.vault.getAbstractFileByPath(notePath);
    if (!(existing instanceof TFile)) {
      await this.app.vault.create(notePath, renderStatuteNote(article));
    }

    return formatStatuteWikilink(notePath, article, reference);
  }

  async copyArticle(article: LegalArticle, reference?: LegalReference) {
    await navigator.clipboard.writeText(formatPlainArticle(article, reference));
    new Notice("Copied legal text.");
  }

  getArticleCount() {
    return this.articles.length;
  }

  async activateReferenceView() {
    this.rememberCurrentEditor();
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) {
      return;
    }

    await leaf.setViewState({
      type: VIEW_TYPE_LEGAL_REFERENCE,
      active: true
    });
    this.app.workspace.revealLeaf(leaf);
  }

  showPopover(anchor: HTMLElement, resolved: ResolvedReference, options: PopoverOptions = { showInsert: false }) {
    this.showPopoverAtRect(anchor.getBoundingClientRect(), resolved, options);
  }

  showPopoverAtRect(rect: DOMRect, resolved: ResolvedReference, options: PopoverOptions = { showInsert: false }) {
    this.cancelScheduledPopoverClose();
    this.closePopover();

    const popover = document.body.createDiv({ cls: "legal-reference-popover" });
    popover.appendChild(this.createPopoverContent(resolved, options));
    document.body.appendChild(popover);
    this.activePopover = popover;
    this.activePopoverResolved = resolved;
    this.activePopoverCanInsert = options.showInsert;

    positionPopover(rect, popover);

    popover.addEventListener("mouseenter", () => {
      this.cancelScheduledPopoverClose();
    });
    popover.addEventListener("mouseleave", () => {
      this.schedulePopoverClose();
    });
  }

  schedulePopoverClose() {
    this.cancelScheduledPopoverClose();
    this.popoverCloseTimer = window.setTimeout(() => {
      this.closePopover();
    }, 35);
  }

  closePopover() {
    this.cancelScheduledPopoverClose();
    this.activePopover?.remove();
    this.activePopover = null;
    this.activePopoverResolved = null;
    this.activePopoverCanInsert = false;
  }

  private cancelScheduledPopoverClose() {
    if (this.popoverCloseTimer !== null) {
      window.clearTimeout(this.popoverCloseTimer);
      this.popoverCloseTimer = null;
    }
  }

  private createPopoverContent(resolved: ResolvedReference, options: PopoverOptions) {
    const content = createDiv({ cls: "legal-reference-popover-content" });
    const title = content.createDiv({
      cls: "legal-reference-popover-title",
      text: formatReferenceTitle(resolved)
    });
    title.setAttr("title", `《${resolved.article.law}》${formatReferenceLabel(resolved.reference)}`);
    const meta = content.createDiv({ cls: "legal-reference-popover-meta-row" });
    meta.createDiv({
      cls: "legal-reference-popover-meta",
      text: `Matched: ${resolved.reference.raw}`
    });
    if (resolved.isInserted !== undefined) {
      meta.createDiv({
        cls: getInsertionStatusClass(resolved),
        text: getInsertionStatusText(resolved)
      });
    }
    content.createDiv({
      cls: "legal-reference-popover-text",
      text: getResolvedReferenceText(resolved)
    });

    const actions = content.createDiv({ cls: "legal-reference-popover-actions" });
    if (options.showInsert) {
      new ButtonComponent(actions)
        .setButtonText("Insert ↵")
        .setCta()
        .onClick(() => {
          void this.insertArticleCallout(resolved.article, resolved.reference);
          this.closePopover();
        });
    }

    new ButtonComponent(actions)
      .setButtonText("Copy")
      .onClick(() => {
        void this.copyArticle(resolved.article, resolved.reference);
        this.closePopover();
      });

    return content;
  }

  private createAutocompleteExtension() {
    return [
      autocompletion({
        override: [
          (context) => this.completeLegalReferenceContent(context)
        ],
        activateOnTyping: true,
        defaultKeymap: false
      }),
      keymap.of([
        ...completionKeymap.filter((binding) => binding.key !== "Enter"),
        { key: "Ctrl-Enter", run: acceptCompletion }
      ]),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) {
          return;
        }

        const head = update.state.selection.main.head;
        const line = update.state.doc.lineAt(head);
        const beforeCursor = line.text.slice(0, head - line.from);
        const fragment = findReferenceFragmentBeforeCursor(beforeCursor);
        if (!fragment) {
          return;
        }

        const hasResolvedReference = this.resolveTextReferences(fragment.text)
          .some((candidate) => candidate.reference.end === fragment.text.length);
        if (!hasResolvedReference) {
          return;
        }

        window.setTimeout(() => {
          startCompletion(update.view);
        }, 0);
      })
    ];
  }

  private completeLegalReferenceContent(context: CompletionContext): CompletionResult | null {
    const line = context.state.doc.lineAt(context.pos);
    const beforeCursor = line.text.slice(0, context.pos - line.from);
    const fragment = findReferenceFragmentBeforeCursor(beforeCursor);
    if (!fragment) {
      return null;
    }

    const references = this.resolveTextReferences(fragment.text);
    const resolved = references.find((candidate) => candidate.reference.end === fragment.text.length);
    if (!resolved) {
      return null;
    }

    const insertion = formatAutocompleteTextInsertion(
      `${this.settings.enableStatuteNotes ? formatStatuteLinkText(this.settings.statuteNotesFolder, resolved) : fragment.text} ${getResolvedReferenceText(resolved, this.settings.contentOnlyInsertion)}`,
      line.text.slice(0, fragment.start)
    );
    const label = `Fill 《${resolved.article.law}》${formatReferenceLabel(resolved.reference)}`;

    return {
      from: line.from + fragment.start,
      options: [
        {
          label,
          type: "text",
          detail: "Ctrl ↵",
          apply: (view, _completion, from, to) => {
            if (this.settings.enableStatuteNotes) {
              void this.ensureStatuteNote(resolved.article, resolved.reference);
            }
            view.dispatch({
              changes: { from, to, insert: insertion.trimStart() }
            });
          }
        }
      ],
      validFor: /[\u4e00-\u9fa5零〇一二三四五六七八九十百千万两\d第条款项（）()《》]*$/
    };
  }

  private createEditorHoverExtension() {
    let hoveredRange: string | null = null;

    return EditorView.domEventHandlers({
      mousemove: (event, view) => {
        const target = event.target;
        if (!(target instanceof HTMLElement) || target.closest(".legal-reference-popover")) {
          return false;
        }

        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
        if (pos === null) {
          hoveredRange = null;
          this.schedulePopoverClose();
          return false;
        }

        const documentText = view.state.doc.toString();
        const line = view.state.doc.lineAt(pos);
        const offset = pos - line.from;
        const resolved = this.resolveTextReferences(line.text).find((candidate) => {
          return offset >= candidate.reference.start && offset <= candidate.reference.end;
        });
        const resolvedWithStatus = resolved
          ? {
            ...resolved,
            reference: {
              ...resolved.reference,
              start: line.from + resolved.reference.start,
              end: line.from + resolved.reference.end
            },
            isInserted: isReferenceTextInserted(documentText, {
              ...resolved,
              reference: {
                ...resolved.reference,
                start: line.from + resolved.reference.start,
                end: line.from + resolved.reference.end
              }
            })
          }
          : null;

        if (!resolvedWithStatus) {
          hoveredRange = null;
          this.schedulePopoverClose();
          return false;
        }

        const rangeKey = `${line.number}:${resolvedWithStatus.reference.start}:${resolvedWithStatus.reference.end}`;
        if (hoveredRange === rangeKey && this.activePopover) {
          this.cancelScheduledPopoverClose();
          return false;
        }

        const from = resolvedWithStatus.reference.start;
        const to = resolvedWithStatus.reference.end;
        const fromRect = view.coordsAtPos(from);
        const toRect = view.coordsAtPos(to);
        if (!fromRect || !toRect) {
          return false;
        }

        hoveredRange = rangeKey;
        this.showPopoverAtRect(
          new DOMRect(
            Math.min(fromRect.left, toRect.left),
            Math.min(fromRect.top, toRect.top),
            Math.max(1, Math.abs(toRect.right - fromRect.left)),
            Math.max(fromRect.bottom - fromRect.top, toRect.bottom - toRect.top)
          ),
          resolvedWithStatus,
          { showInsert: true }
        );
        return false;
      },
      mouseleave: () => {
        hoveredRange = null;
        this.schedulePopoverClose();
        return false;
      }
    });
  }

  private decorateRenderedMarkdown(element: HTMLElement) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const textNodes: Text[] = [];

    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!(node instanceof Text) || !node.nodeValue) {
        continue;
      }

      const parent = node.parentElement;
      if (!parent || parent.closest("code, pre, a, .legal-reference-mark, .legal-reference-popover")) {
        continue;
      }

      if (this.resolveTextReferences(node.nodeValue).length > 0) {
        textNodes.push(node);
      }
    }

    for (const textNode of textNodes) {
      this.decorateTextNode(textNode);
    }
  }

  private decorateTextNode(textNode: Text) {
    const text = textNode.nodeValue ?? "";
    const resolvedReferences = this.resolveTextReferences(text);
    if (resolvedReferences.length === 0) {
      return;
    }

    const fragment = document.createDocumentFragment();
    let cursor = 0;

    for (const resolved of resolvedReferences) {
      const { start, end, raw } = resolved.reference;
      if (start < cursor) {
        continue;
      }

      fragment.appendText(text.slice(cursor, start));

      const mark = document.createElement("span");
      mark.addClass("legal-reference-mark");
      mark.setText(raw);
      mark.addEventListener("mouseenter", () => {
        this.showPopover(mark, resolved);
      });
      mark.addEventListener("mouseleave", () => {
        this.schedulePopoverClose();
      });
      mark.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.showPopover(mark, resolved, { showInsert: false });
      });

      fragment.appendChild(mark);
      cursor = end;
    }

    fragment.appendText(text.slice(cursor));
    textNode.replaceWith(fragment);
  }

  private rememberCurrentEditor() {
    const activeEditor = this.app.workspace.activeEditor;
    const file = this.app.workspace.getActiveFile();

    if (activeEditor?.editor && file instanceof TFile && file.extension === "md") {
      this.rememberEditor(activeEditor.editor, file);
    }
  }

  private rememberEditor(editor: Editor, file: TFile | null) {
    this.lastEditor = editor;
    if (file instanceof TFile && file.extension === "md") {
      this.lastMarkdownFile = file;
    }
  }

  private resolveReferences(references: LegalReference[], sourceText?: string) {
    const resolved: ResolvedReference[] = [];

    references.forEach((reference, index) => {
      const article = this.findArticle(reference);
      if (article) {
        const item: ResolvedReference = { reference, article };
        if (sourceText !== undefined) {
          const nextReferenceStart = references[index + 1]?.start ?? sourceText.length;
          item.isInserted = isReferenceTextInserted(sourceText, item, nextReferenceStart);
        }
        resolved.push(item);
      }
    });

    return resolved;
  }

  private findArticle(reference: LegalReference) {
    const lawAlias = reference.lawAlias ? normalizeLawKey(reference.lawAlias) : null;
    const candidates = this.articles.filter((article) => article.article === reference.article);

    if (lawAlias) {
      const aliases = parseLawAliasSettings(this.settings.lawAliases);
      return candidates.find((article) => lawMatches(article.lawKey, lawAlias, aliases)) ?? null;
    }

    return candidates.length === 1 ? candidates[0] : null;
  }

  private async loadLegalLibraryArticles() {
    const files = this.app.vault.getFiles().filter((file) => {
      return file.extension === "md" && file.path.startsWith(`${LEGAL_LIBRARY_DIR}/`);
    });
    const articles: LegalArticle[] = [];

    for (const file of files) {
      const content = await this.app.vault.read(file);
      articles.push(...parseLegalLibraryMarkdown(content, file.basename));
    }

    return dedupeLegalArticles(articles);
  }

  private async extractLawSourceText(file: TFile) {
    if (file.extension === "md" || file.extension === "txt") {
      return this.app.vault.read(file);
    }

    if (["doc", "docx", "rtf", "pdf"].includes(file.extension)) {
      return extractDesktopDocumentText(this.app, file);
    }

    throw new Error(`Unsupported law source type: .${file.extension}`);
  }

  private async ensureFolder(folderPath: string) {
    const existing = this.app.vault.getAbstractFileByPath(folderPath);
    if (!existing) {
      await this.app.vault.createFolder(folderPath);
    }
  }

  private async ensureFolderPath(folderPath: string) {
    const parts = normalizeVaultFolderPath(folderPath).split("/").filter(Boolean);
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      await this.ensureFolder(current);
    }
  }

  private refreshReferenceLeaves() {
    this.app.workspace.getLeavesOfType(VIEW_TYPE_LEGAL_REFERENCE).forEach((leaf) => {
      const view = leaf.view;
      if (view instanceof LegalReferenceView) {
        void view.render();
      }
    });
  }
}

class LegalReferenceSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly plugin: LegalReferencePlugin
  ) {
    super(app, plugin);
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h3", { cls: "legal-reference-setting-heading", text: "Insertion" });

    new Setting(containerEl)
      .setName("Insertion format")
      .setDesc("Choose how legal text is inserted into the active note.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("callout", "Callout")
          .addOption("bullet", "Nested bullet")
          .addOption("quote", "Block quote")
          .addOption("plaintext", "Plain text")
          .setValue(this.plugin.settings.insertionFormat)
          .onChange(async (value) => {
            this.plugin.settings.insertionFormat = value as InsertionFormat;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Content only")
      .setDesc("Insert only the provision content, without the generated law title and article label.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.contentOnlyInsertion)
          .onChange(async (value) => {
            this.plugin.settings.contentOnlyInsertion = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Create statute notes")
      .setDesc("When enabled, generated statute references become wikilinks and StatuteLink creates one note per article.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.enableStatuteNotes)
          .onChange(async (value) => {
            this.plugin.settings.enableStatuteNotes = value;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Statute notes folder")
      .setDesc("Folder for per-article statute notes. This is separate from Legal Library.")
      .addText((text) => {
        text
          .setPlaceholder("Legal Notes")
          .setValue(this.plugin.settings.statuteNotesFolder)
          .onChange(async (value) => {
            this.plugin.settings.statuteNotesFolder = value.trim() || DEFAULT_SETTINGS.statuteNotesFolder;
            await this.plugin.saveSettings();
          });
      });

    containerEl.createEl("h3", { cls: "legal-reference-setting-heading", text: "Library" });

    new Setting(containerEl)
      .setName("Bundled starter library")
      .setDesc("Install the seven bundled law files into Legal Library. Existing files are not overwritten.")
      .addButton((button) => {
        button
          .setButtonText("Install bundled laws")
          .onClick(async () => {
            await this.plugin.installBundledLawLibrary();
          });
      });

    new Setting(containerEl)
      .setName("Law aliases")
      .setDesc("One alias per line, using alias=official law name. Built-in default: 刑诉法=刑事诉讼法.")
      .addTextArea((text) => {
        text
          .setPlaceholder("刑诉法=刑事诉讼法")
          .setValue(this.plugin.settings.lawAliases)
          .onChange(async (value) => {
            this.plugin.settings.lawAliases = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 6;
        text.inputEl.cols = 36;
      });
  }
}

class LegalReferenceView extends ItemView {
  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: LegalReferencePlugin
  ) {
    super(leaf);
  }

  getViewType() {
    return VIEW_TYPE_LEGAL_REFERENCE;
  }

  getDisplayText() {
    return "Legal References";
  }

  getIcon() {
    return "scroll-text";
  }

  async onOpen() {
    await this.render();
  }

  async render() {
    const container = this.containerEl.children[1];
    container.empty();
    container.addClass("legal-reference-view");

    const toolbar = container.createDiv({ cls: "legal-reference-toolbar" });
    toolbar.createEl("h2", { text: "Legal References" });

    new ButtonComponent(toolbar)
      .setIcon("refresh-cw")
      .setTooltip("Rescan current note")
      .onClick(() => {
        void this.render();
      });

    new ButtonComponent(toolbar)
      .setIcon("folder-input")
      .setTooltip("Import Law Sources folder")
      .onClick(async () => {
        await this.plugin.importLawSourcesFolder();
        await this.render();
      });

    container.createDiv({
      cls: "legal-reference-status",
      text: `Indexed articles: ${this.plugin.getArticleCount()}`
    });

    const list = container.createDiv({ cls: "legal-reference-list" });
    const references = await this.plugin.scanActiveFile();

    if (references.length === 0) {
      list.createDiv({
        cls: "legal-reference-empty",
        text: "No matched legal references in the active note."
      });
      return;
    }

    for (const resolved of references) {
      this.renderReference(list, resolved);
    }
  }

  private renderReference(parent: Element, resolved: ResolvedReference) {
    const item = parent.createDiv({ cls: "legal-reference-item" });
    const titleRow = item.createDiv({ cls: "legal-reference-item-title-row" });
    const title = titleRow.createDiv({
      cls: "legal-reference-item-title",
      text: formatReferenceTitle(resolved)
    });
    title.setAttr("title", `《${resolved.article.law}》${formatReferenceLabel(resolved.reference)}`);
    titleRow.createDiv({
      cls: getInsertionStatusClass(resolved),
      text: getInsertionStatusText(resolved)
    });
    item.createDiv({
      cls: "legal-reference-item-meta",
      text: `Matched: ${resolved.reference.raw}`
    });
    item.createDiv({
      cls: "legal-reference-item-text",
      text: getResolvedReferenceText(resolved)
    });

    const actions = item.createDiv({ cls: "legal-reference-item-actions" });
    new ButtonComponent(actions)
      .setButtonText("Insert")
      .setCta()
      .onClick(() => {
        void this.plugin.insertArticleCallout(resolved.article, resolved.reference);
      });
  }
}

function isSupportedLawSource(file: TFile) {
  return ["md", "txt", "doc", "docx", "rtf", "pdf"].includes(file.extension);
}

function isInLawSourceFolder(file: TFile) {
  const [topLevelFolder] = file.path.split("/");
  return normalizeFolderName(topLevelFolder ?? "") === normalizeFolderName(LAW_SOURCE_DIR);
}

function normalizeFolderName(value: string) {
  return value.replace(/[\s_-]/g, "").toLowerCase();
}

function parseLegalLibraryMarkdown(content: string, fallbackLaw: string): LegalArticle[] {
  const law = extractFrontmatterValue(content, "law")
    ?? content.match(/^#\s+(.+)$/m)?.[1]?.trim()
    ?? fallbackLaw;
  const articleBlocks = parseImportedArticles(content);

  return articleBlocks.map((article) => createLegalArticle(law, article.number, article.body));
}

function parseDatabase(content: string): LegalArticle[] {
  const articles: LegalArticle[] = [];
  const articlePattern = /^\s*[-*]\s*(.+?)\s+第?([零〇一二三四五六七八九十百千万两\d]+)条\s+(.+)\s*$/gm;

  for (const match of content.matchAll(articlePattern)) {
    const article = parseArticleNumber(match[2]);
    if (article === null) {
      continue;
    }

    const law = match[1].trim().replace(/^《|》$/g, "");
    articles.push(createLegalArticle(law, article, match[3].trim()));
  }

  return articles;
}

function parseImportedLawSource(rawText: string, fallbackLaw: string): ImportedLawSource {
  const normalizedText = normalizeExtractedText(rawText);
  return {
    law: detectLawTitle(normalizedText, fallbackLaw),
    articles: parseImportedArticles(normalizedText)
  };
}

function parseImportedArticles(text: string): ImportedArticle[] {
  const starts = [...text.matchAll(/^#{0,6}\s*第[零〇一二三四五六七八九十百千万两\d]+条/gm)];
  const articles: ImportedArticle[] = [];

  for (let i = 0; i < starts.length; i += 1) {
    const current = starts[i];
    const next = starts[i + 1];
    const start = current.index ?? 0;
    const end = next?.index ?? text.length;
    const rawHeading = current[0].replace(/^#+\s*/, "");
    const number = parseArticleNumber(rawHeading.replace(/^第|条$/g, ""));

    if (number === null) {
      continue;
    }

    const block = text.slice(start, end).trim();
    const body = cleanImportedArticleBody(block.slice(current[0].length));
    if (!body) {
      continue;
    }

    articles.push({ number, heading: rawHeading, body });
  }

  return dedupeImportedArticles(articles);
}

function stripGeneratedLawCallouts(content: string) {
  const lines = content.split("\n");
  const kept: string[] = [];
  let insideLawCallout = false;

  for (const line of lines) {
    if (/^>\s*\[!law\]/.test(line)) {
      insideLawCallout = true;
      kept.push("");
      continue;
    }

    if (insideLawCallout) {
      if (/^>/.test(line) || line.trim() === "") {
        kept.push("");
        continue;
      }
      insideLawCallout = false;
    }

    kept.push(line);
  }

  return kept.join("\n");
}

function stripGeneratedLawInsertionsPreserveOffsets(content: string) {
  const lines = content.split("\n");
  const kept: string[] = [];
  let insideLawCallout = false;
  let insideLawQuote = false;
  let lawBulletIndent: number | null = null;

  for (const line of lines) {
    if (/^>\s*\[!law\]/.test(line)) {
      insideLawCallout = true;
      kept.push(maskLine(line));
      continue;
    }

    if (insideLawCallout) {
      if (/^>/.test(line) || line.trim() === "") {
        kept.push(maskLine(line));
        continue;
      }
      insideLawCallout = false;
    }

    if (isGeneratedLawQuoteHeader(line)) {
      insideLawQuote = true;
      kept.push(maskLine(line));
      continue;
    }

    if (insideLawQuote) {
      if (/^>/.test(line) || line.trim() === "") {
        kept.push(maskLine(line));
        continue;
      }
      insideLawQuote = false;
    }

    const lawBulletIndentMatch = line.match(/^(\s*)[-+*]\s+《[^》]+》第[零〇一二三四五六七八九十百千万两\d]+条/);
    if (lawBulletIndentMatch) {
      lawBulletIndent = lawBulletIndentMatch[1].length;
      kept.push(maskLine(line));
      continue;
    }

    if (lawBulletIndent !== null) {
      if (line.trim() === "" || isGeneratedLawBulletBody(line, lawBulletIndent)) {
        kept.push(maskLine(line));
        continue;
      }
      lawBulletIndent = null;
    }

    kept.push(line);
  }

  return kept.join("\n");
}

function maskLine(line: string) {
  return " ".repeat(line.length);
}

function isGeneratedLawQuoteHeader(line: string) {
  return /^>\s*《[^》]+》第[零〇一二三四五六七八九十百千万两\d]+条/.test(line);
}

function isGeneratedLawBulletBody(line: string, parentIndent: number) {
  const match = line.match(/^(\s*)[-+*]\s+/);
  return !!match && match[1].length > parentIndent;
}

function findReferenceFragmentBeforeCursor(text: string) {
  const referenceLikePattern = /(?:《?[\u4e00-\u9fa5]{1,24}(?:法|典|编|条例|规定|解释)》?\s*)?第?[零〇一二三四五六七八九十百千万两\d]+条(?:第?[零〇一二三四五六七八九十百千万两\d]+款)?(?:第?[（(]?[零〇一二三四五六七八九十百千万两\d]+[）)]?项|[（(][零〇一二三四五六七八九十百千万两\d]+[）)])?$/;
  const match = text.match(referenceLikePattern);
  if (!match || match.index === undefined) {
    return null;
  }

  return {
    text: match[0],
    start: match.index
  };
}

function parseReferences(content: string): LegalReference[] {
  const references: LegalReference[] = [];
  const numberPattern = "[零〇一二三四五六七八九十百千万两\\d]+";
  const referencePattern = new RegExp(
    `(?:《?([\\u4e00-\\u9fa5]{1,24}?(?:法|典|编|条例|规定|解释))》?\\s*)?`
      + `第?(${numberPattern})条`
      + `(?:第?(${numberPattern})款)?`
      + `(?:第?[（(]?(${numberPattern})[）)]?项|[（(](${numberPattern})[）)])?`,
    "g"
  );

  for (const match of content.matchAll(referencePattern)) {
    const raw = match[0];
    const article = parseArticleNumber(match[2]);
    const paragraph = match[3] ? parseArticleNumber(match[3]) : null;
    const item = match[4] ? parseArticleNumber(match[4]) : match[5] ? parseArticleNumber(match[5]) : null;
    if (article === null) {
      continue;
    }

    references.push({
      raw,
      lawAlias: match[1]?.trim() ?? null,
      article,
      articleLabel: `第${article}条`,
      paragraph,
      item,
      start: match.index ?? 0,
      end: (match.index ?? 0) + raw.length
    });
  }

  return references;
}

function parseArticleNumber(value: string): number | null {
  if (/^\d+$/.test(value)) {
    return Number(value);
  }

  const normalized = value.replace(/两/g, "二").replace(/〇/g, "零");
  const digitMap = new Map<string, number>([
    ["零", 0],
    ["一", 1],
    ["二", 2],
    ["三", 3],
    ["四", 4],
    ["五", 5],
    ["六", 6],
    ["七", 7],
    ["八", 8],
    ["九", 9]
  ]);
  const unitMap = new Map<string, number>([
    ["十", 10],
    ["百", 100],
    ["千", 1000],
    ["万", 10000]
  ]);

  if (![...normalized].some((char) => unitMap.has(char))) {
    let positional = "";
    for (const char of normalized) {
      const digit = digitMap.get(char);
      if (digit === undefined) {
        return null;
      }
      positional += String(digit);
    }
    return Number(positional);
  }

  let result = 0;
  let section = 0;
  let number = 0;

  for (const char of normalized) {
    const digit = digitMap.get(char);
    if (digit !== undefined) {
      number = digit;
      continue;
    }

    const unit = unitMap.get(char);
    if (unit === undefined) {
      return null;
    }

    if (unit === 10000) {
      section = (section + number) * unit;
      result += section;
      section = 0;
    } else {
      section += (number || 1) * unit;
    }
    number = 0;
  }

  return result + section + number;
}

function normalizeExtractedText(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/\t/g, " ")
    .replace(new RegExp(" HYPERLINK \"[^\"]+\"(?: \\\\l \"[^\"]+\")?\\\\s*", "g"), "")
    .replace(new RegExp("HYPERLINK \"[^\"]+\"(?: \\\\l \"[^\"]+\")?\\\\s*", "g"), "")
    .replace(/[ ]{2,}/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function detectLawTitle(text: string, fallbackLaw: string) {
  return text.match(/中华人民共和国[^\n]{0,30}法典/)?.[0]?.trim()
    ?? text.match(/中华人民共和国[^\n]{0,40}(?:法|法典|条例|规定|解释)/)?.[0]?.trim()
    ?? fallbackLaw.replace(/[_-]?\d{4}.*$/, "");
}

function cleanImportedArticleBody(body: string) {
  const lines = body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => !/^第[一二三四五六七八九十百千万零〇两\d]+[编章节](?:\s|$)/.test(line));

  return trimTrailingImportNoise(lines)
    .join("\n")
    .replace(/\n+/g, "\n")
    .replace(/[ ]+/g, " ")
    .trim();
}

function trimTrailingImportNoise(lines: string[]) {
  let end = lines.length;

  for (let i = 0; i < end; i += 1) {
    if (isImportTrailerStart(lines[i])) {
      end = i;
      break;
    }
  }

  while (end > 0 && isImportTrailerNoise(lines[end - 1])) {
    end -= 1;
  }

  return lines.slice(0, end);
}

function isImportTrailerStart(line: string) {
  const compact = line.replace(/\s/g, "");
  return /北大法宝/.test(compact)
    || /扫描二维码阅读原文/.test(compact)
    || /^原文链接[:：]/.test(compact)
    || /法宝引证码/.test(compact)
    || /^下载日期[:：]/.test(compact)
    || /^本文本转载于/.test(compact);
}

function isImportTrailerNoise(line: string) {
  const compact = line.replace(/\s/g, "");
  return compact === ""
    || compact === "PAGE/NUMPAGES"
    || /^PAGE\s*\/\s*NUMPAGES/i.test(line)
    || /共\d+条\d+字/.test(compact)
    || /扫一扫.*手机阅读/.test(compact)
    || /扫描二维码阅读原文/.test(compact)
    || /^原文链接[:：]/.test(compact)
    || /法宝引证码/.test(compact)
    || /^下载日期[:：]/.test(compact)
    || /^本文本转载于/.test(compact)
    || /^中华人民共和国[^\n]{0,40}(?:法|法典|条例|规定|解释)$/.test(compact);
}

function dedupeImportedArticles(articles: ImportedArticle[]) {
  const seen = new Set<number>();
  const result: ImportedArticle[] = [];

  for (const article of articles) {
    if (seen.has(article.number)) {
      continue;
    }
    seen.add(article.number);
    result.push(article);
  }

  return result;
}

function dedupeLegalArticles(articles: LegalArticle[]) {
  const seen = new Set<string>();
  const result: LegalArticle[] = [];

  for (const article of articles) {
    const key = `${article.lawKey}:${article.article}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(article);
  }

  return result;
}

function renderLibraryMarkdown(lawTitle: string, articles: ImportedArticle[]) {
  const lines = [
    "---",
    `law: ${lawTitle}`,
    "source_type: imported",
    `imported_at: ${new Date().toISOString()}`,
    "---",
    "",
    `# ${lawTitle}`,
    ""
  ];

  for (const article of articles) {
    lines.push(`## ${article.heading}`);
    lines.push("");
    lines.push(article.body);
    lines.push("");
  }

  return lines.join("\n");
}

function extractFrontmatterValue(content: string, key: string) {
  const frontmatter = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatter) {
    return null;
  }

  return frontmatter[1].match(new RegExp(`^${key}:\\s*(.+)$`, "m"))?.[1]?.trim() ?? null;
}

function safeFileName(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, "_");
}

function normalizeVaultFolderPath(value: string) {
  return value
    .split("/")
    .map((part) => safeFileName(part.trim()))
    .filter(Boolean)
    .join("/") || DEFAULT_SETTINGS.statuteNotesFolder;
}

function extractDesktopDocumentText(app: Plugin["app"], file: TFile) {
  const adapter = app.vault.adapter as { getFullPath?: (path: string) => string };
  const fullPath = adapter.getFullPath?.(file.path);
  const globalWithRequire = globalThis as typeof globalThis & { require?: (module: string) => unknown };
  const windowWithRequire = window as unknown as { require?: (module: string) => unknown };
  const nodeRequire = globalWithRequire.require ?? windowWithRequire.require;

  if (!fullPath || !nodeRequire) {
    throw new Error("DOC/DOCX/PDF import is currently available only in Obsidian desktop.");
  }

  const childProcess = nodeRequire("child_process") as {
    execFileSync: (file: string, args: string[], options: { encoding: BufferEncoding; maxBuffer: number }) => string;
  };

  if (["doc", "docx", "rtf"].includes(file.extension)) {
    return childProcess.execFileSync("textutil", ["-convert", "txt", "-stdout", fullPath], {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024
    });
  }

  try {
    return childProcess.execFileSync("pdftotext", ["-layout", fullPath, "-"], {
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024
    });
  } catch {
    try {
      return childProcess.execFileSync("textutil", ["-convert", "txt", "-stdout", fullPath], {
        encoding: "utf8",
        maxBuffer: 50 * 1024 * 1024
      });
    } catch {
      throw new Error("PDF text extraction failed. Install Poppler pdftotext or convert the PDF to TXT first.");
    }
  }
}

function normalizeLawKey(value: string) {
  return value
    .replace(/[《》\s]/g, "")
    .replace(/^中华人民共和国/, "")
    .replace(/侵权责任分编/g, "侵权编")
    .replace(/侵权责任编/g, "侵权编");
}

function lawMatches(indexedLawKey: string, queryLawKey: string, aliases: Map<string, string>) {
  const resolvedQueryLawKey = aliases.get(queryLawKey) ?? queryLawKey;

  if (indexedLawKey === resolvedQueryLawKey) {
    return true;
  }

  if (indexedLawKey.includes(resolvedQueryLawKey) || resolvedQueryLawKey.includes(indexedLawKey)) {
    return true;
  }

  if (resolvedQueryLawKey === "侵权编" && indexedLawKey.includes("民法典")) {
    return true;
  }

  return false;
}

function parseLawAliasSettings(value: string) {
  const aliases = new Map<string, string>();

  for (const line of value.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.includes("=") ? "=" : trimmed.includes("：") ? "：" : ":";
    const [alias, official] = trimmed.split(separator).map((part) => part.trim());
    if (!alias || !official) {
      continue;
    }

    aliases.set(normalizeLawKey(alias), normalizeLawKey(official));
  }

  return aliases;
}

function formatArticleInsertion(
  article: LegalArticle,
  reference: LegalReference | undefined,
  format: InsertionFormat,
  contentOnly: boolean,
  statuteLink?: string,
  beforeCursor = ""
) {
  const label = reference ? formatReferenceLabel(reference) : article.articleLabel;
  const text = reference ? getReferenceTargetText(article, reference) : article.text;
  const heading = statuteLink ?? `《${article.law}》${label}`;

  if (format === "bullet") {
    const bulletText = text
      .split("\n")
      .map((line) => `\t- ${line}`)
      .join("\n");
    return contentOnly ? `\n${bulletText}\n` : `\n- ${heading}\n${bulletText}\n`;
  }

  if (format === "quote") {
    const quotedText = (contentOnly ? text : `${heading}\n${text}`)
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
    return `\n${quotedText}\n`;
  }

  if (format === "plaintext") {
    return formatPlainTextInsertion(contentOnly ? text : `${heading}\n${text}`, beforeCursor);
  }

  const quotedText = (contentOnly ? text : `${heading}\n${text}`)
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

  return contentOnly ? `\n> [!law]\n${quotedText}\n` : `\n> [!law] ${heading}\n${quotedText}\n`;
}

function formatPlainTextInsertion(text: string, beforeCursor: string) {
  return formatAutocompleteTextInsertion(text, beforeCursor);
}

function formatPlainArticle(article: LegalArticle, reference?: LegalReference) {
  const label = reference ? formatReferenceLabel(reference) : article.articleLabel;
  const text = reference ? getReferenceTargetText(article, reference) : article.text;
  return `《${article.law}》${label}\n${text}`;
}

function formatArticleLabel(article: LegalArticle) {
  return article.articleLabel || `第${article.article}条`;
}

function formatStatuteLinkText(folder: string, resolved: ResolvedReference) {
  return formatStatuteWikilink(getStatuteNotePath(folder, resolved.article), resolved.article, resolved.reference);
}

function getStatuteNotePath(folder: string, article: LegalArticle) {
  return `${normalizeVaultFolderPath(folder)}/${safeFileName(article.law)}/${safeFileName(formatArticleLabel(article))}.md`;
}

function formatStatuteWikilink(notePath: string, article: LegalArticle, reference: LegalReference) {
  const linkTarget = notePath.replace(/\.md$/i, "");
  return `[[${linkTarget}|${formatStatuteLinkAlias(article, reference)}]]`;
}

function formatStatuteLinkAlias(article: LegalArticle, reference: LegalReference) {
  return `${getShortLawName(article.law)}${formatReferenceLabel(reference)}`;
}

function renderStatuteNote(article: LegalArticle) {
  const title = `《${article.law}》${formatArticleLabel(article)}`;
  return [
    "---",
    "type: statute",
    `law: ${article.law}`,
    `article: ${article.article}`,
    "---",
    "",
    `# ${title}`,
    "",
    article.text.trim(),
    ""
  ].join("\n");
}

function getResolvedReferenceText(resolved: ResolvedReference, contentOnly = true) {
  const text = getReferenceTargetText(resolved.article, resolved.reference);
  if (contentOnly) {
    return text;
  }
  return `《${resolved.article.law}》${formatReferenceLabel(resolved.reference)}\n${text}`;
}

function formatAutocompleteTextInsertion(text: string, beforeFragment: string) {
  const lines = text
    .trim()
    .split("\n")
    .map((line) => line.trimEnd());

  if (lines.length <= 1) {
    return lines[0] ?? "";
  }

  const continuationPrefix = getMarkdownContinuationPrefix(beforeFragment);
  return lines
    .map((line, index) => index === 0 ? line : `${continuationPrefix}${line}`)
    .join("\n");
}

function getMarkdownContinuationPrefix(beforeFragment: string) {
  const leadingWhitespace = beforeFragment.match(/^\s*/)?.[0] ?? "";
  const lineContent = beforeFragment.slice(leadingWhitespace.length);

  const blockQuote = lineContent.match(/^(>+\s*)/);
  if (blockQuote) {
    return `${leadingWhitespace}${blockQuote[1]}`;
  }

  const taskList = lineContent.match(/^([-+*]\s+\[[ xX]\]\s+)/);
  if (taskList) {
    return leadingWhitespace + " ".repeat(taskList[1].length);
  }

  const bulletList = lineContent.match(/^([-+*]\s+)/);
  if (bulletList) {
    return leadingWhitespace + " ".repeat(bulletList[1].length);
  }

  const orderedList = lineContent.match(/^(\d+[.)]\s+)/);
  if (orderedList) {
    return leadingWhitespace + " ".repeat(orderedList[1].length);
  }

  return leadingWhitespace;
}

function formatReferenceTitle(resolved: ResolvedReference) {
  return `${getShortLawName(resolved.article.law)} ${formatReferenceLabel(resolved.reference)}`;
}

function getShortLawName(law: string) {
  return law
    .replace(/^中华人民共和国/, "")
    .replace(/^最高人民法院关于/, "")
    .replace(/^最高人民检察院关于/, "");
}

function getInsertionStatusText(resolved: ResolvedReference) {
  return resolved.isInserted ? "已插入" : "未插入";
}

function getInsertionStatusClass(resolved: ResolvedReference) {
  return resolved.isInserted
    ? "legal-reference-insertion-status is-inserted"
    : "legal-reference-insertion-status is-missing";
}

function isReferenceTextInserted(sourceText: string, resolved: ResolvedReference, nextReferenceStart?: number) {
  const target = normalizeInsertedTextProbe(getResolvedReferenceText(resolved));
  if (target.length < 8) {
    return false;
  }

  const probe = target.slice(0, Math.min(48, Math.max(16, Math.floor(target.length * 0.35))));
  const localEnd = nextReferenceStart !== undefined && nextReferenceStart > resolved.reference.end
    ? nextReferenceStart
    : sourceText.length;
  const windowEnd = Math.min(localEnd, resolved.reference.end + 1600);
  const afterReference = normalizeInsertedTextProbe(sourceText.slice(resolved.reference.end, windowEnd));
  return afterReference.includes(probe);
}

function normalizeInsertedTextProbe(text: string) {
  return text
    .replace(/^\s*>\s?\[!law\].*$/gm, "")
    .replace(/^\s*(?:>\s?|[-+*]\s+|\d+[.)]\s+)+/gm, "")
    .replace(/[\s\u00a0]/g, "")
    .replace(/[《》「」『』“”"'\`*_~#\-]/g, "");
}

function formatReferenceLabel(reference: LegalReference) {
  let label = `第${reference.article}条`;
  if (reference.paragraph !== null) {
    label += `第${reference.paragraph}款`;
  }
  if (reference.item !== null) {
    label += `第${reference.item}项`;
  }
  return label;
}

function getReferenceTargetText(article: LegalArticle, reference: LegalReference) {
  if (reference.item !== null) {
    const itemText = findStructuredItemText(article, reference.paragraph, reference.item);
    if (itemText) {
      return itemText;
    }
  }

  if (reference.paragraph !== null) {
    const paragraphText = article.paragraphs.find((paragraph) => paragraph.number === reference.paragraph)?.text;
    if (paragraphText) {
      return paragraphText;
    }
  }

  return article.text;
}

function createLegalArticle(law: string, article: number, text: string): LegalArticle {
  return {
    law,
    lawKey: normalizeLawKey(law),
    article,
    articleLabel: `第${article}条`,
    text,
    paragraphs: parseArticleStructure(text)
  };
}

function parseArticleStructure(articleText: string): LegalParagraph[] {
  const lines = articleText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const paragraphs: LegalParagraph[] = [];
  let current: LegalParagraph | null = null;

  for (const line of lines) {
    const itemNumber = parseItemMarker(line);
    if (itemNumber !== null) {
      if (!current) {
        current = { number: paragraphs.length + 1, text: "", items: [] };
        paragraphs.push(current);
      }
      current.items.push({ number: itemNumber, text: line });
      current.text = current.text ? `${current.text}\n${line}` : line;
      continue;
    }

    current = {
      number: paragraphs.length + 1,
      text: line,
      items: []
    };
    paragraphs.push(current);
  }

  return paragraphs;
}

function findStructuredItemText(article: LegalArticle, paragraphNumber: number | null, itemNumber: number) {
  const paragraphCandidates = paragraphNumber !== null
    ? article.paragraphs.filter((paragraph) => paragraph.number === paragraphNumber)
    : article.paragraphs;

  for (const paragraph of paragraphCandidates) {
    const item = paragraph.items.find((candidate) => candidate.number === itemNumber);
    if (item) {
      return item.text;
    }
  }

  return null;
}

function parseItemMarker(line: string) {
  const match = line.trim().match(/^[（(]([零〇一二三四五六七八九十百千万两\\d]+)[）)]/);
  return match ? parseArticleNumber(match[1]) : null;
}

function positionPopover(rect: DOMRect, popover: HTMLElement) {
  const margin = 8;
  const maxLeft = window.innerWidth - popover.offsetWidth - margin;
  const left = Math.max(margin, Math.min(rect.left, maxLeft));
  const belowTop = rect.bottom + margin;
  const aboveTop = rect.top - popover.offsetHeight - margin;
  const top = belowTop + popover.offsetHeight < window.innerHeight
    ? belowTop
    : Math.max(margin, aboveTop);

  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
}
