import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ComputerWorkspace } from "../src/computer-workspace.js";

test("workspace refuses symbolic-link traversal outside its root", { skip: process.platform === "win32" }, async () => {
    const base = await mkdtemp(join(tmpdir(), "sovereign-workspace-"));
    const root = join(base, "workspace");
    const outside = join(base, "outside");
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "secret.txt"), "outside", "utf8");
    await symlink(outside, join(root, "escape"), "dir");

    const workspace = new ComputerWorkspace(root);
    await workspace.init();
    await assert.rejects(() => workspace.read("escape/secret.txt"), /symbolic link|junction/);
    await assert.rejects(() => workspace.write("escape/new.txt", "nope"), /symbolic link|junction/);
});
