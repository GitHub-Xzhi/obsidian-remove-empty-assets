import {
	App,
	Notice,
	Platform,
	Plugin,
	PluginSettingTab,
	Setting,
	TFolder,
	normalizePath,
} from "obsidian";

/**
 * Remove Empty Assets
 * 删除附件目录中的空目录（桌面端 + 移动端均可使用）。
 * 附件目录路径支持三种写法：
 *   1) 绝对路径（如 D:\notes\attachments）—— 仅桌面端支持，且只处理这一个目录；
 *   2) 以 "." 开头（如 .attachments）—— 相对每个笔记目录，扫描全库中所有同名目录并分别清理；
 *   3) 其他相对路径（如 attachments）—— 相对仓库根目录。
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

// ---------------------------------------------------------------------------
// 设置
// ---------------------------------------------------------------------------
interface PluginSettings {
	/** 附件目录路径：绝对路径(仅桌面) / "." 开头(相对笔记目录，扫全库同名目录) / 其他(相对仓库根) */
	attachmentPath: string;
	/** 删除方式：trash 回收站(.trash)；permanent 永久删除 */
	deleteMode: "trash" | "permanent";
}

const DEFAULT_SETTINGS: PluginSettings = {
	attachmentPath: ".attachments",
	deleteMode: "trash",
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

	async onload() {
		await this.loadSettings();

		// 命令面板手动触发
		this.addCommand({
			id: "remove-empty-assets",
			name: "删除空附件目录",
			callback: () => {
				void this.runCleanup(false);
			},
		});

		// 启动自动清理：等待布局就绪后延迟执行，确保文件树已加载完成
		this.app.workspace.onLayoutReady(() => {
			window.setTimeout(() => {
				void this.runCleanup(true);
			}, 2000);
		});

		this.addSettingTab(new RemoveEmptyAssetsSettingTab(this.app, this));
	}

	onunload() {
		// 无需要清理的资源
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// -----------------------------------------------------------------------
	// 清理入口
	// -----------------------------------------------------------------------
	async runCleanup(silent: boolean): Promise<void> {
		const targets = this.resolveTargetDirs();
		if (targets.length === 0) {
			if (!silent) {
				new Notice("没有找到可清理的附件目录（请检查设置中的附件目录路径）。");
			}
			return;
		}

		let deleted = 0;
		let errors = 0;
		for (const t of targets) {
			try {
				if (t.absPath) {
					deleted += await this.cleanAbsolute(t.absPath);
				} else {
					deleted += await this.cleanRelative(t.relPath);
				}
			} catch (e) {
				errors++;
				console.error("[Remove Empty Assets] 清理失败:", t.relPath || t.absPath, e);
			}
		}

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

		// 2) "." 开头：相对每个笔记目录，扫描全库同名目录
		if (raw.startsWith(".")) {
			const sub = raw.replace(/^\.+/, "").replace(/^[/\\]+/, "");
			if (!sub) {
				// 形如 "." 或 "./"：没有目录名，无法定位，跳过本次清理
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

		// 3) 其他相对路径：相对仓库根目录
		const rel = normalizePath(raw.replace(/^[/\\]+/, ""));
		return [{ relPath: rel }];
	}

	// -----------------------------------------------------------------------
	// 递归清理（vault 内相对路径，桌面端/移动端通用）
	// 口径：先深入子目录，若某目录内没有任何文件、且子目录也全部被删除，
	//       则该目录被判定为空并删除（递归清理，上层目录因此变空时也会一并删除）。
	// 返回删除的目录数量。
	// -----------------------------------------------------------------------
	async cleanRelative(relPath: string): Promise<number> {
		const adapter = this.app.vault.adapter;

		if (!(await adapter.exists(relPath))) {
			return 0; // 目录已不存在，无需处理
		}

		const listing = await adapter.list(relPath);
		let deleted = 0;
		for (const folder of listing.folders) {
			deleted += await this.cleanRelative(folder);
		}

		// 子目录处理完毕后再次检查：目录是否已空（没有任何文件、也没有剩余子目录）
		const again = await adapter.list(relPath);
		if (again.files.length === 0 && again.folders.length === 0) {
			await this.deleteDir(relPath);
			deleted += 1;
		}
		return deleted;
	}

	// -----------------------------------------------------------------------
	// 递归清理（仓库外绝对路径，仅桌面端）
	// -----------------------------------------------------------------------
	async cleanAbsolute(absPath: string): Promise<number> {
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
				deleted += await this.cleanAbsolute(absPath.replace(/[\\/]+$/, "") + "/" + ent.name);
			}
		}

		if (fs.readdirSync(absPath).length === 0) {
			if (this.settings.deleteMode === "trash") {
				const shell = await electronShell();
				if (shell) {
					try {
						await shell.trashItem(absPath);
						deleted += 1;
						return deleted;
					} catch (e) {
						console.error("[Remove Empty Assets] 移入回收站失败，改为永久删除:", absPath, e);
					}
				}
			}
			fs.rmSync(absPath, { recursive: true, force: true });
			deleted += 1;
		}
		return deleted;
	}

	// -----------------------------------------------------------------------
	// 删除目录（vault 内）：按设置与平台选择 系统回收站 / .trash / 永久删除
	// -----------------------------------------------------------------------
	async deleteDir(relPath: string): Promise<void> {
		if (this.settings.deleteMode === "trash") {
			if (Platform.isMobile) {
				// 移动端：移到 Obsidian 自带的 .trash 回收文件夹（可恢复）
				await this.moveToObsidianTrash(relPath);
				return;
			}
			// 桌面端：移入系统回收站
			const shell = await electronShell();
			if (shell) {
				try {
					const abs = (this.app.vault.adapter as any).getFullPath?.(relPath);
					if (abs) {
						await shell.trashItem(abs);
						return;
					}
				} catch (e) {
					console.error("[Remove Empty Assets] 移入系统回收站失败，改为永久删除:", relPath, e);
				}
			}
		}
		// 永久删除（或回收站不可用时的回退）
		await this.app.vault.adapter.remove(relPath);
	}

	// -----------------------------------------------------------------------
	// 移动端回收：把空目录移动到仓库根目录下的 .trash 回收文件夹
	// -----------------------------------------------------------------------
	async moveToObsidianTrash(relPath: string): Promise<void> {
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
			return;
		}
		await this.app.vault.rename(folder, target);
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
				"支持三种写法：① 绝对路径，如 D:\\notes\\attachments（仅桌面端）；" +
				"② 以 \".\" 开头表示相对每个笔记目录，如 .attachments（将扫描全库中所有同名目录，清理其中的空目录）；" +
				"③ 其他写法相对仓库根目录，如 attachments。"
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
			.setName("立即清理")
			.setDesc("手动执行一次清理，效果与命令面板的「删除空附件目录」相同。")
			.addButton((button) =>
				button
					.setButtonText("执行清理")
					.setCta()
					.onClick(() => {
						void this.plugin.runCleanup(false);
					})
			);
	}
}
