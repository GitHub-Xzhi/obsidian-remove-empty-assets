import {
	App,
	Notice,
	Platform,
	Plugin,
	PluginSettingTab,
	Setting,
	TAbstractFile,
	TFile,
	TFolder,
	normalizePath,
} from "obsidian";

/**
 * Remove Empty Assets
 * 删除附件目录中的空目录（桌面端 + 移动端均可使用）。
 * 附件目录路径支持三种写法：
 *   1) 绝对路径（如 D:\notes\attachments）—— 仅桌面端支持，且只处理这一个目录；
 *   2) 以 "./" 开头（如 ./assets）—— 相对每个笔记目录，扫描全库中所有同名子目录并分别清理；
 *   3) 其他相对路径（如 .attachments 或 attachments）—— 相对仓库根目录。
 * 触发方式：
 *   - 打开仓库时自动清理一次；
 *   - 监听 md 文件删除：被删笔记的附件目录立即定点扫描（./ 配置只扫该笔记的目录）；
 *   - 命令面板 / 设置页按钮手动触发。
 * 删除方式（设置中切换，默认移入回收站）：
 *   - trash：桌面端移入系统回收站；移动端移到 Obsidian 自带的 .trash 回收文件夹（均可恢复）
 *   - permanent：永久删除（不可恢复）
 */

// ---------------------------------------------------------------------------
// 桌面端桥接：Node fs / Electron shell 仅在"仓库外绝对路径"与"系统回收站"场景使用。
// 移动端（Capacitor 环境）没有 Node/Electron，所有操作走 Obsidian 的 vault.adapter API。
// ---------------------------------------------------------------------------
declare global {
	interface Window {
		require?: (module: string) => any;
	}
}

/** 获取 Node fs 模块（仅桌面端） */
function nodeFs(): any {
	const mod = (window as any).require?.("fs");
	if (!mod) {
		throw new Error("无法访问 Node fs，请确认插件运行在桌面端 Obsidian。");
	}
	return mod;
}

/** 获取 Electron shell（系统回收站，仅桌面端）；不可用时返回 null */
async function electronShell(): Promise<any | null> {
	try {
		const electron = (window as any).require?.("electron");
		if (electron?.shell?.trashItem) {
			return electron.shell;
		}
	} catch (e) {
		// 忽略：回收站不可用时回退为永久删除
	}
	return null;
}

/** 判断是否为绝对路径（Windows 盘符或 POSIX 根） */
function isAbsolutePath(p: string): boolean {
	return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("/");
}

/** 判断是否以 "./"（或 ".\\"）开头：表示相对每个笔记目录 */
function isPerNotePath(raw: string): boolean {
	return raw.startsWith("./") || raw.startsWith(".\\");
}

/** 提取相对笔记目录的子目录名："./assets" -> "assets"；无法提取时返回空串 */
function perNoteSubdir(raw: string): string {
	return raw
		.replace(/^\.\//, "")
		.replace(/^\.\\/, "")
		.replace(/^[/\\]+/, "")
		.replace(/[/\\]+$/, "");
}

/** 判断 childPath 是否位于 dirPath 目录内（childPath 等于 dirPath 也算在内） */
function isInside(childPath: string, dirPath: string): boolean {
	if (!dirPath || dirPath === "/") {
		return true;
	}
	const dir = dirPath.replace(/\/+$/, "");
	return childPath === dir || childPath.startsWith(dir + "/");
}

/** 查找文件路径上最深的一层名为 sub 的祖先目录（vault 相对路径），找不到返回 null */
function findDeepestSubdirAncestor(filePath: string, sub: string): string | null {
	const parts = filePath.split("/");
	parts.pop(); // 去掉末尾的文件/目录名，只保留祖先目录链
	for (let i = parts.length - 1; i >= 0; i--) {
		if (parts[i] === sub) {
			return normalizePath(parts.slice(0, i + 1).join("/"));
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------
interface PluginSettings {
	/** 附件目录路径：绝对路径(仅桌面) / "./" 开头(相对笔记目录，扫全库同名子目录) / 其他(相对仓库根) */
	attachmentPath: string;
	/** 删除方式：trash 回收站(.trash)；permanent 永久删除 */
	deleteMode: "trash" | "permanent";
	/** 是否在控制台打印扫描与删除日志 */
	consoleLog: boolean;
	/** 附件目录本身为空时是否一并删除（false=保留，只删内部的空子目录） */
	deleteEmptyRoot: boolean;
}

const DEFAULT_SETTINGS: PluginSettings = {
	attachmentPath: ".attachments",
	deleteMode: "trash",
	consoleLog: true,
	deleteEmptyRoot: false,
};

/** 一个待清理的目标目录：优先使用 vault 相对路径；absPath 仅用于仓库外的绝对路径配置（桌面端） */
interface CleanTarget {
	relPath: string;  // vault 内相对路径（归一化，正斜杠）
	absPath?: string; // 仓库外的绝对路径（桌面端专用）
}

// ---------------------------------------------------------------------------
// 主插件
// ---------------------------------------------------------------------------
export default class RemoveEmptyAssetsPlugin extends Plugin {
	settings: PluginSettings;

	// 笔记删除触发扫描的防抖状态（合并短时间内的多次删除）
	private deleteScanTimer: number | null = null;
	private pendingDeleteTargets: CleanTarget[] = [];

	// 由本插件自己移动/删除的路径（用于忽略由此触发的 delete/rename 事件，避免自我触发重复扫描）
	private selfMovedPaths: Set<string> = new Set();

	async onload() {
		await this.loadSettings();

		// 命令面板手动触发
		this.addCommand({
			id: "remove-empty-assets",
			name: "删除空附件目录",
			callback: () => {
				void this.runCleanup(false, "命令面板");
			},
		});

		// 启动自动清理：等待布局就绪后延迟执行，确保文件树已加载完成
		this.app.workspace.onLayoutReady(() => {
			window.setTimeout(() => {
				void this.runCleanup(true, "启动");
			}, 2000);
		});

		// 监听删除：md 笔记删除 → 定点扫描其附件目录；附件/子目录删除 → 若位于附件目录内则定点扫描
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				this.onFileDeleted(file);
			})
		);

		// 监听移到仓库内 .trash（Obsidian 设置为"移到 .trash"时的删除，走的是 rename 而非 delete）
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (file.path.startsWith(".trash/")) {
					this.onFileDeleted(file, oldPath);
				}
			})
		);

		this.addSettingTab(new RemoveEmptyAssetsSettingTab(this.app, this));
	}

	onunload() {
		// 清理防抖定时器
		if (this.deleteScanTimer !== null) {
			window.clearTimeout(this.deleteScanTimer);
			this.deleteScanTimer = null;
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	/** 控制台日志：仅当设置开启时打印 */
	private log(...args: unknown[]): void {
		if (this.settings.consoleLog) {
			console.log("[Remove Empty Assets]", ...args);
		}
	}

	// -----------------------------------------------------------------------
	// 清理入口
	// -----------------------------------------------------------------------
	async runCleanup(silent: boolean, source = "手动"): Promise<void> {
		const targets = this.resolveTargetDirs();
		this.log(`[扫描] ${source}触发，解析到 ${targets.length} 个目标目录:`,
			targets.map((t) => t.relPath || t.absPath));
		if (targets.length === 0) {
			if (!silent) {
				new Notice("没有找到可清理的附件目录（请检查设置中的附件目录路径）。");
			}
			this.log(`[扫描完成] ${source}，无目标目录`);
			return;
		}

		let deleted = 0;
		let errors = 0;
		for (const t of targets) {
			try {
				deleted += await this.cleanTarget(t);
			} catch (e) {
				errors++;
				console.error("[Remove Empty Assets] 清理失败:", t.relPath || t.absPath, e);
			}
		}
		this.log(`[扫描完成] ${source}，共删除 ${deleted} 个空目录，失败 ${errors} 个`);

		// 静默启动且无任何变化时不再打扰用户
		if (silent && deleted === 0 && errors === 0) {
			return;
		}

		const parts = [`已清理 ${deleted} 个空目录`];
		if (errors > 0) {
			parts.push(`，${errors} 个目录处理失败（详见控制台）`);
		}
		if (this.settings.deleteMode === "trash") {
			parts.push(Platform.isMobile ? "（已移入 .trash 回收文件夹）" : "（已移入系统回收站）");
		}
		new Notice(parts.join(""));
	}

	// -----------------------------------------------------------------------
	// 清理单个目标：优先走 vault 相对路径（跨平台）；绝对路径仅桌面端
	// -----------------------------------------------------------------------
	async cleanTarget(t: CleanTarget): Promise<number> {
		if (t.absPath) {
			return this.cleanAbsolute(t.absPath);
		}
		return this.cleanRelative(t.relPath);
	}

	/** 记录由本插件自己移动/删除的路径，用于忽略由此触发的 delete/rename 事件（避免自我触发重复扫描） */
	private markSelfMoved(path: string): void {
		this.selfMovedPaths.add(path);
		// 5 秒后自动清理，避免长期占用内存，也不妨碍以后同路径的真实删除
		window.setTimeout(() => {
			this.selfMovedPaths.delete(path);
		}, 5000);
	}

	// -----------------------------------------------------------------------
	// 删除触发：md 笔记删除 → 定点扫描其附件目录；
	// 附件/子目录删除 → 若位于附件目录内，定点扫描该附件目录
	// originalPath：rename 到 .trash 时传入文件原路径（此时 file.path 已变成 .trash/...）
	// -----------------------------------------------------------------------
	onFileDeleted(file: TAbstractFile, originalPath?: string): void {
		const path = originalPath ?? file.path;

		// 忽略由本插件自己移动/删除产生的 delete/rename 事件（如把空子目录移入回收站时）
		if (this.selfMovedPaths.has(path)) {
			this.selfMovedPaths.delete(path);
			return;
		}

		const raw = (this.settings.attachmentPath || "").trim();
		if (!raw) {
			return;
		}

		const isMd = file instanceof TFile && file.extension === "md";
		const isAbsCfg = isAbsolutePath(raw);
		const isPerNoteCfg = isPerNotePath(raw);
		const parentOfPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";

		let target: CleanTarget | null = null;

		if (isAbsCfg) {
			// 绝对路径配置：仅桌面端；附件删除发生在仓库内，不会命中仓库外路径，只有 md 删除才扫描
			if (Platform.isDesktop && isMd) {
				target = { relPath: "", absPath: raw };
			}
		} else if (isPerNoteCfg) {
			const sub = perNoteSubdir(raw);
			if (!sub) {
				return;
			}
			if (isMd) {
				// md 删除：定位到被删笔记所在目录下的附件子目录
				const rel = parentOfPath ? normalizePath(parentOfPath + "/" + sub) : sub;
				target = { relPath: rel };
			} else {
				// 附件/子目录删除：定位其所在的最深同名 <sub> 目录
				const rel = findDeepestSubdirAncestor(path, sub);
				target = rel ? { relPath: rel } : null;
			}
		} else {
			// 其他配置（全局单一目录，相对仓库根）
			const targets = this.resolveTargetDirs();
			if (targets.length === 0) {
				return;
			}
			if (!isMd) {
				// 附件/子目录删除：仅当位于该附件目录内才扫描
				const dirOfDeleted = file instanceof TFile ? parentOfPath : path;
				if (!isInside(dirOfDeleted, targets[0].relPath)) {
					return;
				}
			}
			target = targets[0];
		}

		if (!target) {
			return;
		}

		this.log("检测到删除，加入定点扫描队列:", path, "→", target.relPath || target.absPath);

		// 防抖：合并短时间内的多次删除，避免频繁扫描
		// 同一目标只入队一次，避免同一批里重复扫描同一目录
		const sameTarget = this.pendingDeleteTargets.some(
			(t) => t.relPath === target.relPath && (t.absPath ?? "") === (target.absPath ?? "")
		);
		if (!sameTarget) {
			this.pendingDeleteTargets.push(target);
		}
		if (this.deleteScanTimer !== null) {
			window.clearTimeout(this.deleteScanTimer);
		}
		this.deleteScanTimer = window.setTimeout(() => {
			void this.runTargetedCleanup(this.pendingDeleteTargets);
			this.pendingDeleteTargets = [];
			this.deleteScanTimer = null;
		}, 1500);
	}

	/** 对一组定点目标执行清理（删除触发） */
	async runTargetedCleanup(targets: CleanTarget[]): Promise<void> {
		this.log("[扫描] 删除触发，定点扫描目标:",
			targets.map((t) => t.relPath || t.absPath));
		let deleted = 0;
		let errors = 0;
		for (const t of targets) {
			try {
				deleted += await this.cleanTarget(t);
			} catch (e) {
				errors++;
				console.error("[Remove Empty Assets] 定点清理失败:", t.relPath || t.absPath, e);
			}
		}
		this.log(`[扫描完成] 删除定点扫描，共删除 ${deleted} 个空目录，失败 ${errors} 个`);

		if (deleted === 0 && errors === 0) {
			return;
		}

		const parts = [`已清理 ${deleted} 个空目录`];
		if (errors > 0) {
			parts.push(`，${errors} 个目录处理失败（详见控制台）`);
		}
		if (this.settings.deleteMode === "trash") {
			parts.push(Platform.isMobile ? "（已移入 .trash 回收文件夹）" : "（已移入系统回收站）");
		}
		new Notice(parts.join(""));
	}

	// -----------------------------------------------------------------------
	// 路径解析：把配置的附件目录路径解析为清理目标列表
	// -----------------------------------------------------------------------
	resolveTargetDirs(): CleanTarget[] {
		const raw = (this.settings.attachmentPath || "").trim();
		if (!raw) {
			return [];
		}

		// 1) 绝对路径：仅桌面端支持，且只处理这一个目录
		if (isAbsolutePath(raw)) {
			if (Platform.isMobile) {
				new Notice("手机端不支持绝对路径的附件目录，请改用相对路径（如 .attachments）。");
				return [];
			}
			return [{ relPath: "", absPath: raw }];
		}

		// 2) "./" 开头：相对每个笔记目录，扫描全库同名子目录
		if (isPerNotePath(raw)) {
			const sub = perNoteSubdir(raw);
			if (!sub) {
				// 形如 "./"：没有子目录名，无法定位，跳过本次清理
				return [];
			}
			const targets: CleanTarget[] = [];
			for (const file of this.app.vault.getAllLoadedFiles()) {
				if (file instanceof TFolder && file.name === sub) {
					targets.push({ relPath: file.path });
				}
			}
			return targets;
		}

		// 3) 其他相对路径（.attachments / attachments / 子路径）：相对仓库根目录
		const rel = normalizePath(raw.replace(/^[/\\]+/, ""));
		return [{ relPath: rel }];
	}

	// -----------------------------------------------------------------------
	// 递归清理（vault 内相对路径，桌面端/移动端通用）
	// 口径：先深入子目录，若某目录内没有任何文件、且子目录也全部被删除，
	//       则该目录被判定为空并删除（递归清理，上层目录因此变空时也会一并删除）。
	// 返回删除的目录数量。
	// -----------------------------------------------------------------------
	// 递归清理：isRoot=true 表示这是配置的目标目录本身（受 deleteEmptyRoot 开关控制）；
	// isRoot=false 表示目标内部的子目录（空则始终删除）
	async cleanRelative(relPath: string, isRoot = true): Promise<number> {
		const adapter = this.app.vault.adapter;

		if (!(await adapter.exists(relPath))) {
			return 0; // 目录已不存在，无需处理
		}

		const listing = await adapter.list(relPath);
		let deleted = 0;
		for (const folder of listing.folders) {
			deleted += await this.cleanRelative(folder, false);
		}

		// 子目录处理完毕后再次检查：目录是否已空（没有任何文件、也没有剩余子目录）
		const again = await adapter.list(relPath);
		if (again.files.length === 0 && again.folders.length === 0) {
			// 目标目录本身为空时，是否删除由开关控制；子目录为空则始终删除
			if (isRoot && !this.settings.deleteEmptyRoot) {
				return deleted; // 保留空的附件目录本身
			}
			if (await this.deleteDir(relPath)) {
				deleted += 1;
			}
		}
		return deleted;
	}

	// -----------------------------------------------------------------------
	// 递归清理（仓库外绝对路径，仅桌面端）
	// -----------------------------------------------------------------------
	// 递归清理（仓库外绝对路径，仅桌面端）：isRoot=true 表示配置的目标目录本身
	async cleanAbsolute(absPath: string, isRoot = true): Promise<number> {
		const fs = nodeFs();
		let entries: any[];
		try {
			entries = fs.readdirSync(absPath, { withFileTypes: true });
		} catch (e) {
			if (e && e.code === "ENOENT") {
				return 0;
			}
			throw e;
		}

		let deleted = 0;
		for (const ent of entries) {
			if (ent.isDirectory()) {
				deleted += await this.cleanAbsolute(absPath.replace(/[\\/]+$/, "") + "/" + ent.name, false);
			}
		}

		if (fs.readdirSync(absPath).length === 0) {
			// 目标目录本身为空时，是否删除由开关控制；子目录为空则始终删除
			if (isRoot && !this.settings.deleteEmptyRoot) {
				return deleted; // 保留空的附件目录本身
			}
			if (this.settings.deleteMode === "trash") {
				const shell = await electronShell();
				if (shell) {
					try {
						await shell.trashItem(absPath);
						this.log("[删除] 移入系统回收站:", absPath);
						deleted += 1;
						return deleted;
					} catch (e) {
						// 回收站失败：跳过，绝不回退为永久删除（避免瞬时故障造成数据丢失）
						console.error("[Remove Empty Assets] 移入系统回收站失败，已跳过（未删除）:", absPath, e);
						return deleted;
					}
				}
				// 无回收站实现可用：跳过
				console.error("[Remove Empty Assets] 系统回收站不可用，已跳过（未删除）:", absPath);
				return deleted;
			}
			fs.rmSync(absPath, { recursive: true, force: true });
			this.log("[删除] 永久删除:", absPath);
			deleted += 1;
		}
		return deleted;
	}

	// -----------------------------------------------------------------------
	// 删除目录（vault 内）：按设置与平台选择 系统回收站 / .trash / 永久删除
	// 返回 true=已删除；false=未删除（跳过或目录已不存在）
	// 注意：回收站模式下绝不回退为永久删除，避免瞬时故障导致不可逆的数据丢失
	// -----------------------------------------------------------------------
	async deleteDir(relPath: string): Promise<boolean> {
		if (this.settings.deleteMode === "trash") {
			if (Platform.isMobile) {
				// 移动端：移到 Obsidian 自带的 .trash 回收文件夹（可恢复）
				const moved = await this.moveToObsidianTrash(relPath);
				if (moved) {
					this.log("[删除] 移入 .trash 回收文件夹:", relPath);
				}
				return moved;
			}
			// 桌面端：优先移入系统回收站
			// 用 Obsidian 的 vault.trash(file, true) 而非 electron.shell.trashItem：
			// 插件运行在渲染进程，Windows 上渲染进程调用 shell.trashItem 会报
			// "Failed to create FileOperation instance"（Electron 已知问题 #29598）；
			// vault.trash 走 Obsidian 主进程实现，与 Obsidian 核心删除一致，可正常进系统回收站。
			const folder = this.app.vault.getAbstractFileByPath(relPath);
			if (folder) {
				try {
					this.markSelfMoved(relPath); // 忽略由此触发的 delete 事件，避免重复扫描
					await this.app.vault.trash(folder, true);
					this.log("[删除] 移入系统回收站:", relPath);
					return true;
				} catch (e) {
					console.error("[Remove Empty Assets] 移入系统回收站失败:", relPath, e);
				}
			}
			// 回收站失败：回退到仓库内 .trash 回收文件夹（仍可恢复，绝不永久删除）
			try {
				const moved = await this.moveToObsidianTrash(relPath);
				if (moved) {
					this.log("[删除] 系统回收站不可用，改移入 .trash 回收文件夹:", relPath);
					return true;
				}
				return false; // 目录已不存在，无需处理
			} catch (e) {
				console.error("[Remove Empty Assets] 移入 .trash 也失败，已跳过（未删除）:", relPath, e);
				return false;
			}
		}
		// 用户显式选择“永久删除”时才直接删除
		await this.app.vault.adapter.remove(relPath);
		this.log("[删除] 永久删除:", relPath);
		return true;
	}

	// -----------------------------------------------------------------------
	// 移动端回收：把空目录移动到仓库根目录下的 .trash 回收文件夹
	// 返回 true=已移动；false=目录已不存在
	// -----------------------------------------------------------------------
	async moveToObsidianTrash(relPath: string): Promise<boolean> {
		const adapter = this.app.vault.adapter;

		// 确保 .trash 存在（vault.rename 不会自动创建父目录）
		if (!(await adapter.exists(".trash"))) {
			await adapter.mkdir(".trash");
		}

		const name = relPath.split("/").pop() || "folder";
		let target = normalizePath(".trash/" + name);
		if (await adapter.exists(target)) {
			target = normalizePath(".trash/" + name + "-" + Date.now());
		}

		const folder = this.app.vault.getAbstractFileByPath(relPath);
		if (!folder) {
			// 目录已不存在，无需移动
			return false;
		}
		this.markSelfMoved(relPath); // 忽略由此触发的 rename 事件（移到 .trash），避免重复扫描
		await this.app.vault.rename(folder, target);
		return true;
	}
}

// ---------------------------------------------------------------------------
// 设置面板
// ---------------------------------------------------------------------------
class RemoveEmptyAssetsSettingTab extends PluginSettingTab {
	plugin: RemoveEmptyAssetsPlugin;

	constructor(app: App, plugin: RemoveEmptyAssetsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Remove Empty Assets" });

		new Setting(containerEl)
			.setName("附件目录路径")
			.setDesc(
				"支持四种写法：① 绝对路径，如 D:\\notes\\attachments（仅桌面端）；" +
				"② 以 \"./\" 开头表示相对每个笔记目录，如 ./assets（清理各笔记目录下名为 assets 的子目录）；" +
				"③ 以 \".\" 开头（无斜杠）表示相对仓库根目录，如 .attachments；" +
				"④ 其他写法相对仓库根目录，如 attachments。删除 md 笔记时会自动定点扫描其附件目录。"
			)
			.addText((text) =>
				text
					.setPlaceholder(".attachments")
					.setValue(this.plugin.settings.attachmentPath)
					.onChange(async (value) => {
						this.plugin.settings.attachmentPath = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("删除方式")
			.setDesc(
				"移入回收站：桌面端=系统回收站，移动端=.trash 回收文件夹（均可恢复，更安全）；" +
				"永久删除不可恢复。"
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("trash", "移入回收站（可恢复）")
					.addOption("permanent", "永久删除（不可恢复）")
					.setValue(this.plugin.settings.deleteMode)
					.onChange(async (value) => {
						this.plugin.settings.deleteMode = value as PluginSettings["deleteMode"];
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("空的附件目录本身也删除")
			.setDesc(
				"开启后，当附件目录（如 ./assets）本身为空时，也会一并删除；" +
				"关闭则只删除其中的空子目录，保留附件目录本身（默认关闭）。"
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.deleteEmptyRoot)
					.onChange(async (value) => {
						this.plugin.settings.deleteEmptyRoot = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("控制台日志")
			.setDesc("开启后，在开发者控制台打印扫描与删除日志（便于排查）。")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.consoleLog)
					.onChange(async (value) => {
						this.plugin.settings.consoleLog = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("立即清理")
			.setDesc("手动执行一次清理，效果与命令面板的「删除空附件目录」相同。")
			.addButton((button) =>
				button
					.setButtonText("执行清理")
					.setCta()
					.onClick(() => {
						void this.plugin.runCleanup(false, "设置按钮");
					})
			);
	}
}
