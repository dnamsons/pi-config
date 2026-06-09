import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type LumenDiffResult = {
  stdout: string;
  exitCode: number;
  signal: NodeJS.Signals | null;
  error?: string;
};

function buildLumenCommand(args: string): string {
  const trimmed = args.trim();
  return trimmed ? `lumen diff ${trimmed}` : "lumen diff";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function stripTerminalControls(value: string): string {
  return value
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()][A-Za-z0-9]/g, "")
    .trim();
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("diff", {
    description:
      "Review the git diff with lumen and send captured annotations to the agent",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();

      if (!ctx.hasUI) {
        ctx.ui.notify("/diff requires interactive pi", "error");
        return;
      }

      const command = buildLumenCommand(args);
      const tempDir = mkdtempSync(join(tmpdir(), "pi-lumen-diff-"));
      const annotationsPath = join(tempDir, "annotations.txt");

      try {
        const result = await ctx.ui.custom<LumenDiffResult>(
          (tui, _theme, _keybindings, done) => {
            let settled = false;
            let ttyFd: number | undefined;
            let tuiStopped = false;

            const emptyComponent = { render: () => [], invalidate: () => {} };

            const finish = (value: Omit<LumenDiffResult, "stdout">) => {
              if (settled) return;
              settled = true;

              let stdout = "";
              try {
                if (existsSync(annotationsPath)) {
                  stdout = readFileSync(annotationsPath, "utf8");
                }
              } catch (error) {
                value = {
                  ...value,
                  error: `Unable to read lumen annotations: ${errorMessage(error)}`,
                };
              }

              if (ttyFd !== undefined) {
                try {
                  closeSync(ttyFd);
                } catch {
                  // Ignore close errors; the child has already exited or failed to spawn.
                }
              }

              if (tuiStopped) {
                tui.start();
                tui.requestRender(true);
              }

              done({ ...value, stdout });
            };

            try {
              tui.stop();
              tuiStopped = true;
              process.stdout.write("\x1b[2J\x1b[H");

              try {
                ttyFd = openSync("/dev/tty", "r+");
              } catch (error) {
                finish({
                  exitCode: 1,
                  signal: null,
                  error: `Unable to open /dev/tty: ${errorMessage(error)}`,
                });
                return emptyComponent;
              }

              const shell = process.env.SHELL || "/bin/sh";
              const lumenCommand = `${command} > ${shellQuote(annotationsPath)}`;
              const scriptArgs =
                process.platform === "darwin"
                  ? ["-q", "-e", "/dev/null", shell, "-c", lumenCommand]
                  : ["-q", "-e", "-c", lumenCommand, "/dev/null"];
              const child = spawn("script", scriptArgs, {
                cwd: ctx.cwd,
                env: process.env,
                stdio: [ttyFd, ttyFd, ttyFd],
              });

              child.on("error", (error) => {
                finish({
                  exitCode: 1,
                  signal: null,
                  error: errorMessage(error),
                });
              });

              child.on("close", (code, signal) => {
                finish({
                  exitCode: code ?? 1,
                  signal,
                });
              });
            } catch (error) {
              finish({
                exitCode: 1,
                signal: null,
                error: errorMessage(error),
              });
            }

            return emptyComponent;
          },
        );

        if (result.error) {
          ctx.ui.notify(`lumen diff failed: ${result.error}`, "error");
          return;
        }

        const annotations = stripTerminalControls(result.stdout);
        if (!annotations) {
          const suffix =
            result.exitCode === 0 ? "" : ` (exit ${result.exitCode})`;
          ctx.ui.notify(
            `No lumen annotations emitted${suffix}.`,
            result.exitCode === 0 ? "info" : "warning",
          );
          return;
        }

        if (result.exitCode !== 0) {
          ctx.ui.notify(
            `lumen diff exited with code ${result.exitCode}; sending captured annotations anyway.`,
            "warning",
          );
        }

        pi.sendUserMessage(
          `I reviewed the diff with lumen. Please address these annotations:\n\n${annotations}`,
        );
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  });
}
