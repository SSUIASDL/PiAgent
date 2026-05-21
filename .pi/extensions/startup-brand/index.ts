import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type PiInstallInfo = {
	version: string;
	installPath: string;
	entryPath: string;
	commandPath: string;
};

function truncateToWidth(text: string, width: number): string {
	if (width <= 0) return "";
	return text.length > width ? `${text.slice(0, Math.max(0, width - 1))}…` : text;
}

function readPiPackage(dir: string): { version: string; entryPath: string } | undefined {
	const packageJsonPath = join(dir, "package.json");
	if (!existsSync(packageJsonPath)) return undefined;

	try {
		const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
		if (packageJson.name !== "@earendil-works/pi-coding-agent") return undefined;

		const mainPath = typeof packageJson.main === "string" ? packageJson.main.replace(/^\.\//, "") : "dist/index.js";
		return {
			version: String(packageJson.version ?? "unknown"),
			entryPath: join(dir, mainPath),
		};
	} catch {
		return undefined;
	}
}

function findPackageDirFrom(startPath: string): string | undefined {
	let dir = existsSync(startPath) ? dirname(startPath) : startPath;

	for (let i = 0; i < 12; i++) {
		if (readPiPackage(dir)) return dir;

		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	return undefined;
}

function findPiInstallInfo(): PiInstallInfo {
	const commandPath = process.argv[1] ?? "unknown";
	const require = createRequire(import.meta.url);
	const candidates: string[] = [];

	try {
		candidates.push(findPackageDirFrom(require.resolve("@earendil-works/pi-coding-agent")) ?? "");
	} catch {
		// Project-local extensions cannot always resolve globally installed Pi.
	}

	candidates.push(
		findPackageDirFrom(commandPath) ?? "",
		process.env.APPDATA ? join(process.env.APPDATA, "npm", "node_modules", "@earendil-works", "pi-coding-agent") : "",
		process.env.NODE_PATH ? join(process.env.NODE_PATH, "@earendil-works", "pi-coding-agent") : "",
	);

	for (const dir of candidates.filter(Boolean)) {
		const packageInfo = readPiPackage(dir);
		if (packageInfo) {
			return {
				version: packageInfo.version,
				installPath: dir,
				entryPath: packageInfo.entryPath,
				commandPath,
			};
		}
	}

	return { version: "unknown", installPath: "unknown", entryPath: "unknown", commandPath };
}

function loadGwangsamiLogo(cwd: string): string[] {
	const logoPath = join(cwd, ".pi", "assets", "gwangsami-logo.txt");
	try {
		return readFileSync(logoPath, "utf8")
			.replace(/\r\n/g, "\n")
			.split("\n")
			.filter((line, index, lines) => line.length > 0 || index < lines.length - 1);
	} catch {
		return [
			"        ✦ ･ﾟ 광삼이 ･ﾟ ✦",
			"      ┌─────────────────┐",
			"      │   ◕       ◕     │",
			"      │       ᴗ         │",
			"      └──╮  CLI  ╭─────┘",
			"         ╰───────╯",
		];
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (event, ctx) => {
		const info = findPiInstallInfo();
		const logo = loadGwangsamiLogo(ctx.cwd);
		const lines = [
			...logo,
			"",
			`Pi version : ${info.version}`,
			`Pi path    : ${info.installPath}`,
			`Pi command : ${info.commandPath}`,
			`Pi entry   : ${info.entryPath}`,
			`Session    : ${event.reason}`,
		];

		ctx.ui.setTitle(`광삼이 Pi · v${info.version}`);
		ctx.ui.setStatus("pi-install", `pi v${info.version}`);
		ctx.ui.setWidget(
			"gwangsami-startup",
			() => ({
				render(width: number) {
					return lines.map((line) => truncateToWidth(line, width));
				},
				invalidate() {},
			}),
			{ placement: "aboveEditor" },
		);

		ctx.ui.notify(`Pi v${info.version} · ${info.installPath}`, "info");
	});

	pi.registerCommand("pi-info", {
		description: "Show Pi version, install path, and the Gwangsami startup logo",
		handler: async (_args, ctx) => {
			const info = findPiInstallInfo();
			ctx.ui.setWidget("gwangsami-startup", [
				...loadGwangsamiLogo(ctx.cwd),
				"",
				`Pi version : ${info.version}`,
				`Pi path    : ${info.installPath}`,
				`Pi command : ${info.commandPath}`,
				`Pi entry   : ${info.entryPath}`,
			], { placement: "aboveEditor" });
			ctx.ui.notify(`Pi v${info.version} · ${info.installPath}`, "info");
		},
	});
}
