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

type TuicrResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal: NodeJS.Signals | null;
  error?: string;
};

function buildTuicrCommand(args: string): string {
  const trimmed = args.trim();
  return trimmed ? `tuicr --stdout ${trimmed}` : "tuicr --stdout -w";
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

function relevantStderr(value: string): string {
  return stripTerminalControls(value)
    .split("\n")
    .filter((line) => !line.startsWith("tuicr-session:"))
    .join("\n")
    .trim();
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("diff", {
    description:
      "Review changes with tuicr and add exported comments to the editor",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();

      if (ctx.mode !== "tui") {
        ctx.ui.notify("/diff requires interactive pi", "error");
        return;
      }

      const command = buildTuicrCommand(args);
      const tempDir = mkdtempSync(join(tmpdir(), "pi-tuicr-diff-"));
      const reviewPath = join(tempDir, "review.md");
      const stderrPath = join(tempDir, "stderr.txt");

      try {
        const result = await ctx.ui.custom<TuicrResult>(
          (tui, _theme, _keybindings, done) => {
            let settled = false;
            let ttyFd: number | undefined;
            let tuiStopped = false;

            const emptyComponent = { render: () => [], invalidate: () => {} };

            const finish = (value: Omit<TuicrResult, "stdout" | "stderr">) => {
              if (settled) return;
              settled = true;

              let stdout = "";
              let stderr = "";

              try {
                if (existsSync(reviewPath)) {
                  stdout = readFileSync(reviewPath, "utf8");
                }
                if (existsSync(stderrPath)) {
                  stderr = readFileSync(stderrPath, "utf8");
                }
              } catch (error) {
                value = {
                  ...value,
                  error: `Unable to read tuicr output: ${errorMessage(error)}`,
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

              done({ ...value, stdout, stderr });
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

              // Give tuicr its own pseudo-terminal. Merely attaching /dev/tty to
              // a spawned process is not sufficient for every terminal/crossterm
              // combination and can make tuicr exit immediately.
              const shell = process.env.SHELL || "/bin/sh";
              const redirectedCommand = `${command} > ${shellQuote(reviewPath)} 2> ${shellQuote(stderrPath)}`;
              const scriptArgs =
                process.platform === "darwin"
                  ? ["-q", "-e", "/dev/null", shell, "-c", redirectedCommand]
                  : ["-q", "-e", "-c", redirectedCommand, "/dev/null"];
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

        const stderr = relevantStderr(result.stderr);

        if (result.error) {
          const details = stderr ? `: ${stderr}` : "";
          ctx.ui.notify(`tuicr failed: ${result.error}${details}`, "error");
          return;
        }

        const review = stripTerminalControls(result.stdout);
        if (!review) {
          const suffix = result.exitCode === 0 ? "" : ` (exit ${result.exitCode})`;
          const details = stderr ? `: ${stderr}` : "";
          ctx.ui.notify(
            `No tuicr review exported${suffix}${details}. Use y, :clip, or ZZ to export before exiting.`,
            result.exitCode === 0 ? "info" : "warning",
          );
          return;
        }

        if (result.exitCode !== 0) {
          const details = stderr ? `: ${stderr}` : "";
          ctx.ui.notify(
            `tuicr exited with code ${result.exitCode}${details}; adding captured output anyway.`,
            "warning",
          );
        }

        const existingDraft = ctx.ui.getEditorText().trim();
        ctx.ui.setEditorText(
          existingDraft ? `${existingDraft}\n\n${review}` : review,
        );
        ctx.ui.notify(
          "tuicr review added to the editor. Submit when ready.",
          "info",
        );
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    },
  });
}
