import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const LOCAL = ".local";

export async function preparePrivateDirectory(): Promise<void> {
  await mkdir(LOCAL, { mode: 0o700, recursive: true });
  const info = await lstat(LOCAL);
  if (!info.isDirectory() || (process.getuid !== undefined && info.uid !== process.getuid())) {
    throw new Error("invalid-private-directory");
  }
  if ((info.mode & 0o777) !== 0o700) {
    await chmod(LOCAL, 0o700);
  }
}

export async function readPrivate(name: string): Promise<string> {
  const file = await open(path.join(LOCAL, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || (process.getuid !== undefined && info.uid !== process.getuid())) {
      throw new Error("invalid-private-file");
    }
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}

export async function writePrivate(name: string, content: string): Promise<void> {
  const directory = await mkdtemp(path.join(LOCAL, ".write-"));
  const temporary = path.join(directory, "secret");
  try {
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    await rename(temporary, path.join(LOCAL, name));
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}
