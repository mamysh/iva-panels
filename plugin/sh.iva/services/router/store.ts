import { z } from "zod";
import { mkdir, open, readFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { viewSchema } from "./contracts.ts";
const screen = z
  .object({
    owner: z.number().int().positive().safe(),
    chat: z.number().int().positive().safe(),
    message: z.number().int().positive().safe().nullable(),
    revision: z.number().int().nonnegative(),
    expires: z.number().finite(),
    page: z.string(),
    view: viewSchema,
    closed: z.boolean(),
  })
  .strict();
const receipt = z
  .object({
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    screen: z.string().regex(/^[a-f0-9]{24}$/),
    phase: z.enum(["sending", "editing", "done", "uncertain"]),
  })
  .strict();
export const stateSchema = z
  .object({
    schema: z.literal(1),
    floor: z.number().int().min(-1),
    screens: z.record(z.string().regex(/^[a-f0-9]{24}$/), screen),
    events: z.record(z.string().regex(/^\d+$/), receipt),
  })
  .strict();
export type State = z.infer<typeof stateSchema>;
export class Store {
  directory: string;
  constructor(directory: string) {
    this.directory = directory;
  }
  async load(): Promise<State> {
    try {
      const path = join(this.directory, "screens.json");
      if ((await stat(path)).size > 5 * 1024 * 1024)
        throw new Error("STATE_TOO_LARGE");
      return stateSchema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { schema: 1, floor: -1, screens: {}, events: {} };
      throw new Error("INVALID_STATE");
    }
  }
  async save(state: State): Promise<void> {
    const valid = stateSchema.parse(state);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(
      this.directory,
      `.screens-${randomBytes(8).toString("hex")}.tmp`,
    );
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(valid));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(path, join(this.directory, "screens.json"));
    const directory = await open(this.directory, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }
}
